import { CryptoHasher, YAML } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { GoClawClient, type Agent, type Tenant } from "../client.ts";
import { loadConfig, type Config } from "../config.ts";

class WSCache {
  private readonly map = new Map<string, GoClawWSClient>();
  constructor(private readonly config: Config) {}

  async forTenant(tenantSlug: string): Promise<GoClawWSClient> {
    let ws = this.map.get(tenantSlug);
    if (!ws) {
      ws = new GoClawWSClient(this.config);
      await ws.connect(tenantSlug);
      this.map.set(tenantSlug, ws);
    }
    return ws;
  }

  closeAll(): void {
    for (const ws of this.map.values()) ws.close();
    this.map.clear();
  }
}
import {
  AgentSchema,
  CANONICAL_CONTEXT_FILES,
  TenantSchema,
  agentWorkspaceDefault,
  type AgentConfig,
  type TenantConfig,
} from "../schemas.ts";
import { canonical } from "../util.ts";
import { GoClawWSClient } from "../ws-client.ts";

export interface PushOptions {
  yes: boolean;
}

interface LocalTenant {
  slug: string;
  config: TenantConfig;
  agents: LocalAgent[];
}

interface LocalAgent {
  slug: string;
  tenantSlug: string;
  agentDir: string;
  config: AgentConfig;
  agent_description?: string;
  /** Map of filename → sha256 hex for every allowlisted *.md file in the folder. */
  contextFileHashes: Map<string, string>;
  /** Filenames found locally that aren't in the allowlist (e.g. typos, drafts). */
  unknownContextFiles: string[];
}

interface ContextFileDiff {
  changed: string[]; // present both sides, content differs
  added: string[]; // only locally
  remoteOnly: string[]; // only remotely (warn: merge import won't delete)
}

interface TenantUpdate {
  name?: string;
  status?: string;
}

type TenantPlanAction =
  | { kind: "tenant.create"; slug: string; local: TenantConfig }
  | {
      kind: "tenant.update";
      slug: string;
      remote: Tenant;
      changes: TenantUpdate;
      diffs: string[];
    }
  | { kind: "tenant.archive"; slug: string; remote: Tenant }
  | { kind: "tenant.unchanged"; slug: string };

type AgentPlanAction =
  | {
      kind: "agent.create";
      tenantSlug: string;
      slug: string;
      agentDir: string;
      body: Record<string, unknown>;
      /** All local context files will be uploaded after creation. */
      contextFiles: string[];
    }
  | {
      kind: "agent.update";
      tenantSlug: string;
      slug: string;
      remoteId: string;
      agentDir: string;
      updates: Record<string, unknown>;
      diffs: string[];
      contextFileDiff: ContextFileDiff;
    }
  | { kind: "agent.delete"; tenantSlug: string; slug: string; remoteId: string }
  | { kind: "agent.unchanged"; tenantSlug: string; slug: string };

type PlanAction = TenantPlanAction | AgentPlanAction;

/** PUT /v1/agents/{id} whitelist (see internal/http/validate.go in goclaw). */
const AGENT_WRITE_FIELDS = [
  "agent_key",
  "display_name",
  "provider",
  "model",
  "status",
  "context_window",
  "max_tool_iterations",
  "workspace",
  "restrict_to_workspace",
  "frontmatter",
  "agent_description",
  "compaction_config",
  "memory_config",
  "other_config",
  "tools_config",
  "emoji",
  "thinking_level",
  "max_tokens",
  "self_evolve",
  "skill_evolve",
  "skill_nudge_interval",
  "reasoning_config",
  "workspace_sharing",
  "shell_deny_groups",
  "kg_dedup_config",
  "is_default",
] as const;

/**
 * Files in the agent folder that are NOT context files. agent.yaml carries the
 * structured config; DESCRIPTION.md is the agent_description summoning prompt
 * (extracted to a sibling file because it tends to be multi-paragraph).
 * Both round-trip via the PUT/POST agent body, not via agents.files.set.
 */
const HANDLED_METADATA_FILES = new Set(["agent.yaml", "DESCRIPTION.md"]);


export async function push(options: PushOptions): Promise<void> {
  const config = loadConfig();
  const client = new GoClawClient(config);

  console.log(`→ GoClaw base URL: ${config.baseUrl}`);
  console.log(`→ Reading local config from: ${config.outputDir}`);

  const [localTenants, remoteTenants] = await Promise.all([
    readLocalTenants(config.outputDir),
    client.listTenants(),
  ]);

  const wsCache = new WSCache(config);
  try {
    const tenantPlan = buildTenantPlan(localTenants, remoteTenants);
    const agentPlan = await buildAgentPlan(client, wsCache, localTenants, remoteTenants);

    printUnknownContextFiles(localTenants);
    const plan: PlanAction[] = [...tenantPlan, ...agentPlan];
    printPlan(plan);

    const mutating = plan.filter(
      (p) => p.kind !== "tenant.unchanged" && p.kind !== "agent.unchanged",
    );
    if (mutating.length === 0) {
      console.log("\nNothing to do.");
      return;
    }

    if (!options.yes && !(await confirm(`\nApply ${mutating.length} change(s)?`))) {
      console.log("Aborted.");
      return;
    }

    await applyPlan(client, wsCache, tenantPlan, agentPlan, remoteTenants);
    console.log("\n✓ Push complete.");
  } finally {
    wsCache.closeAll();
  }
}

// ───────────────────────────── Local read ─────────────────────────────

async function readLocalTenants(outputDir: string): Promise<LocalTenant[]> {
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch {
    return [];
  }

  const result: LocalTenant[] = [];
  for (const slug of entries.sort()) {
    const yamlPath = join(outputDir, slug, "tenant.yaml");
    const file = Bun.file(yamlPath);
    if (!(await file.exists())) continue;

    const text = await file.text();
    const parsed = parseYaml(text, yamlPath);
    const validated = TenantSchema.safeParse(parsed);
    if (!validated.success) {
      throw schemaError(yamlPath, "tenant", validated.error.issues);
    }

    const agents = await readLocalAgents(join(outputDir, slug), slug);
    result.push({ slug, config: validated.data, agents });
  }
  return result;
}

async function readLocalAgents(tenantDir: string, tenantSlug: string): Promise<LocalAgent[]> {
  let entries: string[];
  try {
    entries = await readdir(tenantDir);
  } catch {
    return [];
  }

  const result: LocalAgent[] = [];
  for (const slug of entries.sort()) {
    const agentDir = join(tenantDir, slug);
    const yamlPath = join(agentDir, "agent.yaml");
    const yamlFile = Bun.file(yamlPath);
    if (!(await yamlFile.exists())) continue;

    const text = await yamlFile.text();
    const parsed = parseYaml(text, yamlPath);
    const validated = AgentSchema.safeParse(parsed);
    if (!validated.success) {
      throw schemaError(yamlPath, "agent", validated.error.issues);
    }

    // Fill dynamic defaults that depend on the agent_key (= folder name).
    const config: AgentConfig = { ...validated.data };
    if (!config.workspace) config.workspace = agentWorkspaceDefault(slug);

    const description = await readOptionalText(join(agentDir, "DESCRIPTION.md"));
    const { hashes: contextFileHashes, unknown: unknownContextFiles } =
      await hashLocalContextFiles(agentDir);

    result.push({
      slug,
      tenantSlug,
      agentDir,
      config,
      agent_description: description,
      contextFileHashes,
      unknownContextFiles,
    });
  }

  if (result.length === 0) {
    console.log(`  (no agents under ${tenantSlug})`);
  }
  return result;
}

/**
 * Walks every file in agentDir and partitions them: hashes for canonical
 * context files (uploaded via WebSocket), and "unknown" for anything else
 * — typos, drafts, non-md files. Unknowns are surfaced as a warning and
 * never uploaded.
 */
async function hashLocalContextFiles(
  agentDir: string,
): Promise<{ hashes: Map<string, string>; unknown: string[] }> {
  const hashes = new Map<string, string>();
  const unknown: string[] = [];
  const glob = new Bun.Glob("*");
  for await (const name of glob.scan({ cwd: agentDir, onlyFiles: true })) {
    if (HANDLED_METADATA_FILES.has(name)) continue;
    if (!CANONICAL_CONTEXT_FILES.has(name)) {
      unknown.push(name);
      continue;
    }
    const bytes = await Bun.file(join(agentDir, name)).bytes();
    hashes.set(name, hashBytes(bytes));
  }
  return { hashes, unknown: unknown.sort() };
}

const EMPTY_HASH = hashBytes(new Uint8Array());

/**
 * Hashes every canonical context file on the server via `agents.files.get`.
 * Missing/empty files receive the empty hash so they compare equal to empty
 * local placeholders, avoiding spurious uploads.
 */
async function hashRemoteContextFiles(
  ws: GoClawWSClient,
  agentKey: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const name of CANONICAL_CONTEXT_FILES) {
    const file = await ws.getAgentFile(agentKey, name);
    if (file.missing || file.content === undefined) {
      result.set(name, EMPTY_HASH);
    } else {
      result.set(name, hashBytes(new TextEncoder().encode(file.content)));
    }
  }
  return result;
}

function hashBytes(bytes: Uint8Array): string {
  return new CryptoHasher("sha256").update(bytes).digest("hex");
}

function diffContextFiles(
  local: Map<string, string>,
  remote: Map<string, string>,
): ContextFileDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const remoteOnly: string[] = [];
  for (const [name, hash] of local) {
    const r = remote.get(name);
    if (r === undefined) added.push(name);
    else if (r !== hash) changed.push(name);
  }
  for (const name of remote.keys()) {
    if (!local.has(name)) remoteOnly.push(name);
  }
  return {
    changed: changed.sort(),
    added: added.sort(),
    remoteOnly: remoteOnly.sort(),
  };
}

function hasContextFileChanges(d: ContextFileDiff): boolean {
  return d.changed.length > 0 || d.added.length > 0;
}

/**
 * Uploads each context file individually via WebSocket `agents.files.set`.
 * Granular per-file write — no tar.gz packaging needed.
 */
async function uploadContextFiles(
  ws: GoClawWSClient,
  agentKey: string,
  agentDir: string,
  files: string[],
): Promise<void> {
  for (const name of files) {
    const content = await Bun.file(join(agentDir, name)).text();
    await ws.setAgentFile(agentKey, name, content);
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const text = await file.text();
  return text.replace(/\n+$/, "");
}

function parseYaml(text: string, path: string): unknown {
  try {
    return YAML.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
}

function schemaError(
  path: string,
  kind: string,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): Error {
  const formatted = issues
    .map((i) => {
      const segments = i.path.map((p) => String(p));
      return `  • ${segments.join(".") || "(root)"}: ${i.message}`;
    })
    .join("\n");
  return new Error(`${path} does not match ${kind} schema:\n${formatted}`);
}

// ───────────────────────────── Tenant plan ─────────────────────────────

function buildTenantPlan(local: LocalTenant[], remote: Tenant[]): TenantPlanAction[] {
  const remoteBySlug = new Map<string, Tenant>();
  for (const t of remote) {
    if (typeof t.slug === "string" && t.slug.length > 0) remoteBySlug.set(t.slug, t);
  }

  const plan: TenantPlanAction[] = [];
  const handled = new Set<string>();

  for (const { slug, config } of local) {
    handled.add(slug);
    const match = remoteBySlug.get(slug);
    if (!match) {
      plan.push({ kind: "tenant.create", slug, local: config });
      continue;
    }
    const { changes, diffs } = diffTenant(config, match);
    if (Object.keys(changes).length === 0) {
      plan.push({ kind: "tenant.unchanged", slug });
    } else {
      plan.push({ kind: "tenant.update", slug, remote: match, changes, diffs });
    }
  }

  for (const [slug, t] of remoteBySlug) {
    if (handled.has(slug)) continue;
    if (typeof t.status === "string" && t.status === "archived") continue;
    plan.push({ kind: "tenant.archive", slug, remote: t });
  }

  return plan;
}

function diffTenant(local: TenantConfig, remote: Tenant): { changes: TenantUpdate; diffs: string[] } {
  const changes: TenantUpdate = {};
  const diffs: string[] = [];

  if (typeof remote.name !== "string" || local.name !== remote.name) {
    changes.name = local.name;
    diffs.push(`name: ${formatValue(remote.name)} → ${formatValue(local.name)}`);
  }
  if (typeof remote.status !== "string" || local.status !== remote.status) {
    changes.status = local.status;
    diffs.push(`status: ${formatValue(remote.status)} → ${formatValue(local.status)}`);
  }

  return { changes, diffs };
}

// ───────────────────────────── Agent plan ─────────────────────────────

async function buildAgentPlan(
  client: GoClawClient,
  wsCache: WSCache,
  localTenants: LocalTenant[],
  remoteTenants: Tenant[],
): Promise<AgentPlanAction[]> {
  const remoteTenantBySlug = new Map<string, Tenant>();
  for (const t of remoteTenants) {
    if (typeof t.slug === "string") remoteTenantBySlug.set(t.slug, t);
  }

  const plan: AgentPlanAction[] = [];

  for (const tenant of localTenants) {
    const remoteTenant = remoteTenantBySlug.get(tenant.slug);
    const remoteAgents = remoteTenant
      ? await client.listAgents(String(remoteTenant.id))
      : [];

    const remoteByKey = new Map<string, Agent>();
    for (const a of remoteAgents) {
      if (typeof a.agent_key === "string") remoteByKey.set(a.agent_key, a);
    }

    const handled = new Set<string>();

    for (const local of tenant.agents) {
      handled.add(local.slug);
      const body = buildAgentBody(local);
      const match = remoteByKey.get(local.slug);
      if (!match) {
        plan.push({
          kind: "agent.create",
          tenantSlug: tenant.slug,
          slug: local.slug,
          agentDir: local.agentDir,
          body,
          contextFiles: [...local.contextFileHashes.keys()].sort(),
        });
        continue;
      }
      const { updates, diffs } = diffAgent(body, match);
      const ws = await wsCache.forTenant(tenant.slug);
      const agentKey = String(match.agent_key ?? local.slug);
      const remoteHashes = await hashRemoteContextFiles(ws, agentKey);
      const contextFileDiff = diffContextFiles(local.contextFileHashes, remoteHashes);
      if (diffs.length === 0 && !hasContextFileChanges(contextFileDiff)) {
        plan.push({ kind: "agent.unchanged", tenantSlug: tenant.slug, slug: local.slug });
      } else {
        plan.push({
          kind: "agent.update",
          tenantSlug: tenant.slug,
          slug: local.slug,
          remoteId: String(match.id),
          agentDir: local.agentDir,
          updates,
          diffs,
          contextFileDiff,
        });
      }
    }

    for (const [key, a] of remoteByKey) {
      if (handled.has(key)) continue;
      plan.push({
        kind: "agent.delete",
        tenantSlug: tenant.slug,
        slug: key,
        remoteId: String(a.id),
      });
    }
  }

  return plan;
}

function buildAgentBody(local: LocalAgent): Record<string, unknown> {
  const body: Record<string, unknown> = { agent_key: local.slug };
  for (const field of AGENT_WRITE_FIELDS) {
    if (field === "agent_key") continue;
    const value = (local.config as Record<string, unknown>)[field];
    if (value !== undefined) body[field] = value;
  }
  if (local.agent_description !== undefined) body.agent_description = local.agent_description;
  // frontmatter is now a regular yaml field (handled by AGENT_WRITE_FIELDS loop above).
  return body;
}

function diffAgent(
  body: Record<string, unknown>,
  remote: Agent,
): { updates: Record<string, unknown>; diffs: string[] } {
  const updates: Record<string, unknown> = {};
  const diffs: string[] = [];

  for (const field of Object.keys(body)) {
    const localValue = body[field];
    const remoteValue = (remote as Record<string, unknown>)[field];
    if (canonical(localValue) === canonical(remoteValue)) continue;
    updates[field] = localValue;
    diffs.push(`${field}: ${shortValue(remoteValue)} → ${shortValue(localValue)}`);
  }

  return { updates, diffs };
}

// ───────────────────────────── Output ─────────────────────────────

function printUnknownContextFiles(localTenants: LocalTenant[]): void {
  const lines: string[] = [];
  for (const t of localTenants) {
    for (const a of t.agents) {
      for (const name of a.unknownContextFiles) {
        lines.push(`  ! ${t.slug}/${a.slug}/${name}`);
      }
    }
  }
  if (lines.length === 0) return;
  console.log(
    `\nWarning: ${lines.length} unexpected file(s) found locally — ignored. ` +
      `Allowed: agent.yaml, DESCRIPTION.md + context files (` +
      `${[...CANONICAL_CONTEXT_FILES].sort().join(", ")}).`,
  );
  for (const l of lines) console.log(l);
}

function printPlan(plan: PlanAction[]): void {
  const tenantMutating = plan.filter(
    (p): p is TenantPlanAction => p.kind.startsWith("tenant.") && p.kind !== "tenant.unchanged",
  );
  const agentMutating = plan.filter(
    (p): p is AgentPlanAction => p.kind.startsWith("agent.") && p.kind !== "agent.unchanged",
  );

  console.log("\nPlan:");
  if (tenantMutating.length === 0 && agentMutating.length === 0) {
    console.log("  (no changes)");
  } else {
    if (tenantMutating.length > 0) {
      console.log("  Tenants:");
      for (const a of tenantMutating) printTenantAction(a);
    }
    if (agentMutating.length > 0) {
      console.log("  Agents:");
      const byTenant = groupBy(agentMutating, (a) => a.tenantSlug);
      for (const [tenantSlug, actions] of byTenant) {
        console.log(`    [${tenantSlug}]`);
        for (const a of actions) printAgentAction(a);
      }
    }
  }

  const orphans = agentMutating
    .filter((a): a is Extract<AgentPlanAction, { kind: "agent.update" }> => a.kind === "agent.update")
    .flatMap((a) => a.contextFileDiff.remoteOnly.map((name) => `${a.tenantSlug}/${a.slug}/${name}`));
  if (orphans.length > 0) {
    console.log(
      `\nWarning: ${orphans.length} remote context file(s) have no local copy. ` +
        `GoClaw merge-import cannot delete them — they will remain on the server:`,
    );
    for (const o of orphans) console.log(`  ! ${o}`);
  }
}

function printTenantAction(a: TenantPlanAction): void {
  switch (a.kind) {
    case "tenant.create":
      console.log(`    + create   ${a.slug}  name="${a.local.name}" status=${a.local.status}`);
      break;
    case "tenant.update":
      console.log(`    ~ update   ${a.slug}`);
      for (const d of a.diffs) console.log(`                ${d}`);
      break;
    case "tenant.archive":
      console.log(
        `    - archive  ${a.slug}  (status → archived; GoClaw API has no DELETE for tenants)`,
      );
      break;
    case "tenant.unchanged":
      break;
  }
}

function printAgentAction(a: AgentPlanAction): void {
  switch (a.kind) {
    case "agent.create":
      console.log(`      + create   ${a.slug}  ${shortBody(a.body)}`);
      if (a.contextFiles.length > 0) {
        console.log(`                  context_files: ${a.contextFiles.join(", ")}`);
      }
      break;
    case "agent.update":
      console.log(`      ~ update   ${a.slug}`);
      for (const d of a.diffs) console.log(`                  ${d}`);
      if (hasContextFileChanges(a.contextFileDiff)) {
        const parts: string[] = [];
        if (a.contextFileDiff.changed.length > 0) {
          parts.push(`changed=${a.contextFileDiff.changed.join(",")}`);
        }
        if (a.contextFileDiff.added.length > 0) {
          parts.push(`added=${a.contextFileDiff.added.join(",")}`);
        }
        console.log(`                  context_files: ${parts.join("; ")}`);
      }
      break;
    case "agent.delete":
      console.log(`      - delete   ${a.slug}  (id=${a.remoteId})`);
      break;
    case "agent.unchanged":
      console.log(`      = unchanged ${a.slug}`);
      break;
  }
}

function shortBody(body: Record<string, unknown>): string {
  const display = body.display_name ?? body.agent_key ?? "";
  return `display_name=${formatValue(display)} provider=${formatValue(body.provider)} model=${formatValue(body.model)}`;
}

function shortValue(v: unknown): string {
  if (v === undefined) return "(unset)";
  if (v === null) return "null";
  if (typeof v === "string") {
    return v.length > 60 ? `${JSON.stringify(v.slice(0, 60))}…` : JSON.stringify(v);
  }
  const str = canonical(v);
  return str.length > 60 ? `${str.slice(0, 60)}…` : str;
}


// ───────────────────────────── Apply ─────────────────────────────

async function applyPlan(
  client: GoClawClient,
  wsCache: WSCache,
  tenantPlan: TenantPlanAction[],
  agentPlan: AgentPlanAction[],
  remoteTenants: Tenant[],
): Promise<void> {
  console.log("\nApplying...");

  // tenantSlug → tenant id, populated from remote and updated as we create.
  const tenantIdBySlug = new Map<string, string>();
  for (const t of remoteTenants) {
    if (typeof t.slug === "string") tenantIdBySlug.set(t.slug, String(t.id));
  }

  console.log("  Tenants:");
  for (const a of tenantPlan) {
    switch (a.kind) {
      case "tenant.create": {
        const created = await client.createTenant({ name: a.local.name, slug: a.slug });
        tenantIdBySlug.set(a.slug, String(created.id));
        console.log(`    + created  ${a.slug} (id=${created.id})`);
        const followUp: TenantUpdate = {};
        if (a.local.status !== "active") followUp.status = a.local.status;
        if (Object.keys(followUp).length > 0) {
          await client.updateTenant(String(created.id), followUp);
          console.log(`              └ patched ${Object.keys(followUp).join(", ")}`);
        }
        break;
      }
      case "tenant.update":
        await client.updateTenant(String(a.remote.id), a.changes);
        console.log(`    ~ updated  ${a.slug}`);
        break;
      case "tenant.archive":
        await client.updateTenant(String(a.remote.id), { status: "archived" });
        console.log(`    - archived ${a.slug}`);
        break;
      case "tenant.unchanged":
        break;
    }
  }

  console.log("  Agents:");
  for (const a of agentPlan) {
    const tenantId = tenantIdBySlug.get(a.tenantSlug);
    if (!tenantId) {
      throw new Error(
        `Cannot apply agent action for tenant slug "${a.tenantSlug}" — tenant id not resolved.`,
      );
    }
    switch (a.kind) {
      case "agent.create": {
        const created = await client.createAgent(tenantId, a.body);
        console.log(`    + created  ${a.tenantSlug}/${a.slug} (id=${created.id})`);
        if (a.contextFiles.length > 0) {
          const ws = await wsCache.forTenant(a.tenantSlug);
          await uploadContextFiles(ws, a.slug, a.agentDir, a.contextFiles);
          console.log(`              └ uploaded ${a.contextFiles.length} context file(s)`);
        }
        break;
      }
      case "agent.update": {
        if (Object.keys(a.updates).length > 0) {
          await client.updateAgent(a.remoteId, tenantId, a.updates);
          console.log(
            `    ~ updated  ${a.tenantSlug}/${a.slug} (${Object.keys(a.updates).length} field(s))`,
          );
        }
        if (hasContextFileChanges(a.contextFileDiff)) {
          const toUpload = [...a.contextFileDiff.changed, ...a.contextFileDiff.added].sort();
          const ws = await wsCache.forTenant(a.tenantSlug);
          await uploadContextFiles(ws, a.slug, a.agentDir, toUpload);
          console.log(`              └ uploaded ${toUpload.length} context file(s)`);
        }
        break;
      }
      case "agent.delete":
        await client.deleteAgent(a.remoteId, tenantId);
        console.log(`    - deleted  ${a.tenantSlug}/${a.slug}`);
        break;
      case "agent.unchanged":
        break;
    }
  }
}

// ───────────────────────────── Helpers ─────────────────────────────

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function formatValue(v: unknown): string {
  if (v === undefined) return "(unset)";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

