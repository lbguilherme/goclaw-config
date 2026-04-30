import { YAML } from "bun";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ZodType } from "zod";

import { GoClawClient, type Agent, type McpServer, type Provider, type Skill, type Tenant } from "../client.ts";
import { loadConfig } from "../config.ts";
import {
  AGENT_DEFAULTS,
  AgentSchema,
  CANONICAL_CONTEXT_FILES,
  MCP_HEADER_SECRET_SENTINEL,
  MCP_SERVER_DEFAULTS,
  McpServerSchema,
  PROVIDER_API_KEY_SENTINEL,
  PROVIDER_DEFAULTS,
  ProviderSchema,
  SKILL_DEFAULTS,
  SkillSchema,
  TENANT_DEFAULTS,
  TenantSchema,
  agentWorkspaceDefault,
  isSensitiveHeaderKey,
  providerApiBaseDefault,
  stripDefaults,
} from "../schemas.ts";
import { writeJsonSchemas, type SchemaPaths } from "../schema-output.ts";
import { safeFolderName } from "../slug.ts";
import { GoClawWSClient } from "../ws-client.ts";

export interface PullOptions {
  tenantSlug?: string;
}

export async function pull(options: PullOptions = {}): Promise<void> {
  const config = loadConfig();
  const client = new GoClawClient(config);

  console.log(`→ GoClaw base URL: ${config.baseUrl}`);
  console.log(`→ Output directory: ${config.outputDir}`);
  if (options.tenantSlug) {
    console.log(`→ Scoped to tenant: ${options.tenantSlug}`);
  }

  const schemaPaths = await writeJsonSchemas();

  const allTenants = await client.listTenants();
  let tenants = allTenants.filter((t) => t.status !== "archived");

  if (options.tenantSlug) {
    tenants = tenants.filter((t) => t.slug === options.tenantSlug);
    if (tenants.length === 0) {
      console.log(`No active tenant matched slug "${options.tenantSlug}".`);
      return;
    }
  }

  if (tenants.length === 0) {
    console.log("No active tenants returned by the API.");
    return;
  }

  const tenantsDir = join(config.outputDir, "tenants");
  await mkdir(tenantsDir, { recursive: true });

  for (const tenant of tenants) {
    await pullTenant(client, config, tenant, tenantsDir, schemaPaths);
  }

  console.log("\n✓ Pull complete.");
}

async function pullTenant(
  client: GoClawClient,
  config: ReturnType<typeof loadConfig>,
  tenant: Tenant,
  outputDir: string,
  schemaPaths: SchemaPaths,
): Promise<void> {
  const tenantFolder = safeFolderName(tenant.slug, tenant.name, tenant.id);
  const tenantPath = join(outputDir, tenantFolder);
  await mkdir(tenantPath, { recursive: true });

  console.log(`\n[tenant] ${tenant.name ?? tenant.id} → ${tenantPath}`);

  const tenantData = stripTenantFields(tenant);
  await writeYaml(
    join(tenantPath, "tenant.yaml"),
    tenantData,
    TenantSchema,
    TENANT_DEFAULTS,
    schemaPaths.urls.tenant,
    `tenant ${tenant.name ?? tenant.id}`,
  );

  await pullProviders(client, tenant, tenantPath, schemaPaths);
  await pullMcpServers(client, tenant, tenantPath, schemaPaths);
  await pullSkills(client, tenant, tenantPath, schemaPaths);

  const agents = await client.listAgents(tenant.id);
  if (agents.length === 0) return;

  const agentsPath = join(tenantPath, "agents");
  await mkdir(agentsPath, { recursive: true });

  // Context files come over a tenant-scoped WebSocket connection.
  const ws = new GoClawWSClient(config);
  try {
    const tenantSlugForWS = typeof tenant.slug === "string" ? tenant.slug : String(tenant.id);
    await ws.connect(tenantSlugForWS);
    for (const agent of agents) {
      await pullAgent(client, ws, tenant, agent, agentsPath, schemaPaths);
    }
  } finally {
    ws.close();
  }
}

const PROVIDER_OMIT_FIELDS = ["id", "created_at", "updated_at", "tenant_id", "name"] as const;

/**
 * Pulls the provider list for a tenant and writes one YAML per provider under
 * <tenant>/providers/<name>.yaml. The `api_key` server-side is masked, so we
 * write the sentinel "[encrypted]" — but if the existing file already has a
 * real key (a value that isn't the sentinel), we preserve it on disk so a
 * subsequent push can rotate the key.
 */
async function pullProviders(
  client: GoClawClient,
  tenant: Tenant,
  tenantPath: string,
  schemaPaths: SchemaPaths,
): Promise<void> {
  const providers = await client.listProviders(tenant.id);
  if (providers.length === 0) return;

  const providersPath = join(tenantPath, "providers");
  await mkdir(providersPath, { recursive: true });

  for (const provider of providers) {
    const slug = safeFolderName(provider.name, provider.id);
    const filePath = join(providersPath, `${slug}.yaml`);
    console.log(`  [provider] ${provider.name ?? provider.id} → ${filePath}`);

    const data = stripProviderFields(provider);
    if ("api_key" in data) {
      const existing = await readExistingApiKey(filePath);
      data.api_key = existing ?? PROVIDER_API_KEY_SENTINEL;
    }
    // Strip api_base when it matches the per-type default — keeps yaml clean
    // for the common case. Push refills it before diffing.
    const typeDefault = providerApiBaseDefault(String(data.provider_type ?? ""));
    if (typeDefault !== undefined && data.api_base === typeDefault) {
      delete data.api_base;
    }

    await writeYaml(
      filePath,
      data,
      ProviderSchema,
      PROVIDER_DEFAULTS,
      schemaPaths.urls.provider,
      `provider ${provider.name ?? provider.id}`,
    );
  }
}

function stripProviderFields(provider: Provider): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...provider };
  for (const field of PROVIDER_OMIT_FIELDS) delete rest[field];
  return rest;
}

const MCP_OMIT_FIELDS = [
  "id",
  "created_at",
  "updated_at",
  "tenant_id",
  "name",
  "created_by",
  "agent_count",
] as const;

/**
 * Pulls MCP servers for a tenant. Header values that look like credentials
 * (`Authorization`, `*-api-key`, `*-token`, etc.) are masked with the sentinel,
 * preserving any real values already on disk so a subsequent push can rotate.
 */
async function pullMcpServers(
  client: GoClawClient,
  tenant: Tenant,
  tenantPath: string,
  schemaPaths: SchemaPaths,
): Promise<void> {
  const servers = await client.listMcpServers(tenant.id);
  if (servers.length === 0) return;

  const mcpsPath = join(tenantPath, "mcps");
  await mkdir(mcpsPath, { recursive: true });

  for (const server of servers) {
    const slug = safeFolderName(server.name, server.id);
    const filePath = join(mcpsPath, `${slug}.yaml`);
    console.log(`  [mcp] ${server.name ?? server.id} → ${filePath}`);

    const data = stripMcpFields(server);
    if (data.headers && typeof data.headers === "object") {
      const existing = await readExistingMcpHeaders(filePath);
      data.headers = maskSensitiveHeaders(
        data.headers as Record<string, string>,
        existing,
      );
    }

    await writeYaml(
      filePath,
      data,
      McpServerSchema,
      MCP_SERVER_DEFAULTS,
      schemaPaths.urls.mcp,
      `mcp ${server.name ?? server.id}`,
    );
  }
}

function stripMcpFields(server: McpServer): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...server };
  for (const field of MCP_OMIT_FIELDS) delete rest[field];
  return rest;
}

/**
 * Replaces sensitive header values with the sentinel. If `existing` already
 * contains a real (non-sentinel) value for a sensitive header, that value is
 * kept on disk so the user can rotate without first pulling the secret from
 * the server.
 */
function maskSensitiveHeaders(
  headers: Record<string, string>,
  existing: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isSensitiveHeaderKey(name)) {
      result[name] = value;
      continue;
    }
    const prior = existing[name];
    if (typeof prior === "string" && prior !== MCP_HEADER_SECRET_SENTINEL) {
      result[name] = prior;
    } else {
      result[name] = MCP_HEADER_SECRET_SENTINEL;
    }
  }
  return result;
}

async function readExistingMcpHeaders(filePath: string): Promise<Record<string, string>> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return {};
  let parsed: unknown;
  try {
    parsed = YAML.parse(await file.text());
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const headers = (parsed as Record<string, unknown>).headers;
  if (!headers || typeof headers !== "object") return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
}

const SKILL_OMIT_FIELDS = ["id", "created_at", "updated_at", "tenant_id", "path", "baseDir"] as const;

/**
 * Pulls non-system skills for a tenant. System skills (is_system: true) are
 * platform-managed and excluded — syncing them via this CLI would be a no-op
 * at best and would clobber server-side defaults at worst.
 */
async function pullSkills(
  client: GoClawClient,
  tenant: Tenant,
  tenantPath: string,
  schemaPaths: SchemaPaths,
): Promise<void> {
  const all = await client.listSkills(tenant.id);
  const userSkills = all.filter((s) => s.is_system !== true);
  const systemCount = all.length - userSkills.length;

  if (userSkills.length === 0) {
    if (systemCount > 0) {
      console.log(`  [skills] 0 user skill(s); ${systemCount} system skill(s) skipped`);
    }
    return;
  }

  const skillsPath = join(tenantPath, "skills");
  await mkdir(skillsPath, { recursive: true });

  for (const skill of userSkills) {
    const slug = safeFolderName(skill.slug, skill.name, skill.id);
    const filePath = join(skillsPath, `${slug}.yaml`);
    console.log(`  [skill] ${skill.name ?? skill.slug ?? skill.id} → ${filePath}`);

    const data = stripSkillFields(skill);
    await writeYaml(
      filePath,
      data,
      SkillSchema,
      SKILL_DEFAULTS,
      schemaPaths.urls.skill,
      `skill ${skill.name ?? skill.slug ?? skill.id}`,
    );
  }

  if (systemCount > 0) {
    console.log(`  [skills] ${systemCount} system skill(s) skipped`);
  }
}

function stripSkillFields(skill: Skill): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...skill };
  for (const field of SKILL_OMIT_FIELDS) delete rest[field];
  return rest;
}

/**
 * Reads `api_key` from the existing provider YAML on disk. Returns the value
 * only when it's a real key (not the sentinel) — that's the case where the
 * user wrote a real key locally and we don't want to clobber it.
 */
async function readExistingApiKey(filePath: string): Promise<string | undefined> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return undefined;
  let parsed: unknown;
  try {
    parsed = YAML.parse(await file.text());
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = (parsed as Record<string, unknown>).api_key;
  if (typeof value !== "string" || value === PROVIDER_API_KEY_SENTINEL) return undefined;
  return value;
}

const TENANT_OMIT_FIELDS = ["id", "slug", "created_at", "updated_at", "settings"] as const;
const AGENT_OMIT_FIELDS = [
  "id",
  "created_at",
  "updated_at",
  "tenant_id",
  "agent_key",
  "agent_type", // deprecated server-side; always "predefined" — drop from yaml
] as const;

function stripTenantFields(tenant: Tenant): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...tenant };
  for (const field of TENANT_OMIT_FIELDS) delete rest[field];
  return rest;
}

async function pullAgent(
  client: GoClawClient,
  ws: GoClawWSClient,
  tenant: Tenant,
  agent: Agent,
  agentsPath: string,
  schemaPaths: SchemaPaths,
): Promise<void> {
  const agentFolder = safeFolderName(agent.agent_key, agent.display_name, agent.id);
  const agentPath = join(agentsPath, agentFolder);
  await mkdir(agentPath, { recursive: true });

  console.log(`  [agent] ${agent.display_name ?? agent.agent_key ?? agent.id} → ${agentPath}`);

  const detail = await client.getAgent(agent.id, tenant.id).catch((err: unknown) => {
    console.log(`    ! could not fetch full metadata (${(err as Error).message})`);
    return agent;
  });

  const metadata = await extractMarkdownFields(detail, agentPath, {
    agent_description: "DESCRIPTION.md",
  });

  // Delete legacy FRONTMATTER.md (now stored inline in agent.yaml).
  await Bun.file(join(agentPath, "FRONTMATTER.md"))
    .delete()
    .catch(() => {
      /* not present, fine */
    });
  for (const field of AGENT_OMIT_FIELDS) delete metadata[field];

  // Dynamic default: workspace = /app/workspace/<agent_key> — strip when matching.
  const agentKey = String(agent.agent_key ?? "");
  if (agentKey && metadata.workspace === agentWorkspaceDefault(agentKey)) {
    delete metadata.workspace;
  }

  await writeYaml(
    join(agentPath, "agent.yaml"),
    metadata,
    AgentSchema,
    AGENT_DEFAULTS,
    schemaPaths.urls.agent,
    `agent ${agent.display_name ?? agent.agent_key ?? agent.id}`,
  );

  await pullAgentContextFiles(ws, agent, agentPath);
}

async function writeYaml<T>(
  filePath: string,
  data: unknown,
  schema: ZodType<T>,
  defaults: Record<string, unknown>,
  schemaUrl: string,
  label: string,
): Promise<void> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Schema validation failed for ${label}:\n${issues}`);
  }
  const stripped = stripDefaults(result.data as Record<string, unknown>, defaults);
  const modeline = `# yaml-language-server: $schema=${schemaUrl}\n`;
  const body = YAML.stringify(stripped, null, 2);
  await Bun.write(filePath, modeline + body + (body.endsWith("\n") ? "" : "\n"));
}

async function extractMarkdownFields(
  agent: Agent,
  agentPath: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const rest: Record<string, unknown> = { ...agent };
  for (const [field, filename] of Object.entries(fields)) {
    const value = rest[field];
    delete rest[field];
    if (typeof value === "string" && value.trim().length > 0) {
      await Bun.write(join(agentPath, filename), value.endsWith("\n") ? value : `${value}\n`);
    }
  }
  return rest;
}

/**
 * Fetches each canonical context file via `agents.files.get`. Files reported
 * as missing on the server are written as empty placeholders so the canonical
 * set is always present on disk; push translates empty content into ws.set("").
 */
async function pullAgentContextFiles(
  ws: GoClawWSClient,
  agent: Agent,
  agentPath: string,
): Promise<void> {
  const agentKey = String(agent.agent_key ?? agent.id ?? "");
  if (!agentKey) {
    console.log(`    ! cannot fetch context files (no agent_key)`);
    return;
  }

  let missing = 0;
  for (const name of [...CANONICAL_CONTEXT_FILES].sort()) {
    const file = await ws.getAgentFile(agentKey, name);
    if (file.missing || file.content === undefined) {
      await Bun.write(join(agentPath, name), "");
      missing++;
    } else {
      await Bun.write(join(agentPath, name), file.content);
    }
  }
  const total = CANONICAL_CONTEXT_FILES.size;
  const suffix = missing > 0 ? ` (${missing} empty)` : "";
  console.log(`    + ${total} context file(s)${suffix}`);
}
