import type { Config } from "./config.ts";

interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

interface EventFrame {
  type: "event";
  event: string;
  payload?: unknown;
}

type Pending = { resolve: (v: unknown) => void; reject: (err: Error) => void };

export interface AgentFile {
  name: string;
  missing: boolean;
  size?: number;
  content?: string;
}

/**
 * Minimal WebSocket RPC client for the GoClaw gateway. Handles the `connect`
 * handshake (auth + tenant scoping) and request/response correlation via the
 * `id` field. Auth uses the same gateway token as the REST client.
 */
export class GoClawWSClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private connectPromise?: Promise<void>;
  private closed = false;

  constructor(private readonly config: Config) {}

  /**
   * Connects and runs the `connect` handshake. Pass a tenant slug (or UUID)
   * to scope the connection — `agents.list`, `agents.files.*`, etc. will
   * resolve agent_keys within that tenant only.
   */
  async connect(tenantId?: string): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect(tenantId);
    return this.connectPromise;
  }

  private async doConnect(tenantId?: string): Promise<void> {
    const url = this.config.baseUrl.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener(
        "error",
        () => reject(new Error(`WebSocket connection to ${url} failed`)),
        { once: true },
      );
    });

    ws.addEventListener("message", (ev: MessageEvent) => this.handleMessage(ev));
    ws.addEventListener("close", () => this.handleClose());

    const params: Record<string, unknown> = {
      token: this.config.token,
      user_id: this.config.userId,
    };
    if (tenantId) params.tenant_id = tenantId;
    await this.call("connect", params);
  }

  private handleMessage(ev: MessageEvent): void {
    let frame: ResponseFrame | EventFrame;
    try {
      frame = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
    } catch {
      return;
    }
    if (frame.type !== "res") return; // ignore events for now
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      const err = frame.error ?? { code: "UNKNOWN", message: "(no error payload)" };
      pending.reject(new Error(`WS RPC error [${err.code}]: ${err.message}`));
    }
  }

  private handleClose(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("WebSocket closed"));
    this.pending.clear();
  }

  private async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws) throw new Error("WebSocket not connected — call connect() first");
    if (this.closed) throw new Error("WebSocket already closed");
    const id = String(this.nextId++);
    const frame: RequestFrame = { type: "req", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  async getAgentFile(agentId: string, name: string): Promise<AgentFile> {
    const res = await this.call<{ file: AgentFile }>("agents.files.get", { agentId, name });
    return res.file;
  }

  async setAgentFile(
    agentId: string,
    name: string,
    content: string,
    propagate = false,
  ): Promise<void> {
    await this.call("agents.files.set", { agentId, name, content, propagate });
  }
}
