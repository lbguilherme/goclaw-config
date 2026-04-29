import type { Config } from "./config.ts";

export interface Tenant {
  id: string;
  name?: string;
  slug?: string;
  [key: string]: unknown;
}

export interface Agent {
  id: string;
  agent_key?: string;
  display_name?: string;
  [key: string]: unknown;
}

export class GoClawClient {
  constructor(private readonly config: Config) {}

  private async request(
    path: string,
    init: RequestInit & { tenantId?: string } = {},
  ): Promise<Response> {
    const { tenantId, headers, ...rest } = init;

    const finalHeaders = new Headers(headers);
    finalHeaders.set("Authorization", `Bearer ${this.config.token}`);
    finalHeaders.set("X-GoClaw-User-Id", this.config.userId);
    if (tenantId) finalHeaders.set("X-GoClaw-Tenant-Id", tenantId);
    if (!finalHeaders.has("Accept")) finalHeaders.set("Accept", "application/json");

    const url = `${this.config.baseUrl}${path}`;
    const response = await fetch(url, { ...rest, headers: finalHeaders });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `GoClaw API ${rest.method ?? "GET"} ${path} failed: ${response.status} ${response.statusText}${
          body ? ` — ${body.slice(0, 500)}` : ""
        }`,
      );
    }

    return response;
  }

  private async json<T>(path: string, init: RequestInit & { tenantId?: string } = {}): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  async listTenants(): Promise<Tenant[]> {
    const data = await this.json<Tenant[] | { tenants?: Tenant[]; data?: Tenant[] }>(
      "/v1/tenants",
    );
    return normalizeList<Tenant>(data, ["tenants", "data"]);
  }

  async createTenant(input: { name: string; slug: string }): Promise<Tenant> {
    return await this.json<Tenant>("/v1/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async updateTenant(
    id: string,
    updates: Partial<{ name: string; status: string }>,
  ): Promise<void> {
    await this.request(`/v1/tenants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  }

  async listAgents(tenantId: string): Promise<Agent[]> {
    const data = await this.json<Agent[] | { agents?: Agent[]; data?: Agent[] }>(
      "/v1/agents",
      { tenantId },
    );
    return normalizeList<Agent>(data, ["agents", "data"]);
  }

  async getAgent(agentId: string, tenantId: string): Promise<Agent> {
    return await this.json<Agent>(`/v1/agents/${encodeURIComponent(agentId)}`, { tenantId });
  }

  async createAgent(tenantId: string, body: Record<string, unknown>): Promise<Agent> {
    return await this.json<Agent>("/v1/agents", {
      method: "POST",
      tenantId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async updateAgent(
    agentId: string,
    tenantId: string,
    updates: Record<string, unknown>,
  ): Promise<void> {
    await this.request(`/v1/agents/${encodeURIComponent(agentId)}`, {
      method: "PUT",
      tenantId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  }

  async deleteAgent(agentId: string, tenantId: string): Promise<void> {
    await this.request(`/v1/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
      tenantId,
    });
  }

}

function normalizeList<T>(data: unknown, keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    for (const key of keys) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}
