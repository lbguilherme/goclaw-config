import { YAML } from "bun";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ZodType } from "zod";

import { GoClawClient, type Agent, type Tenant } from "../client.ts";
import { loadConfig } from "../config.ts";
import {
  AGENT_DEFAULTS,
  AgentSchema,
  CANONICAL_CONTEXT_FILES,
  TENANT_DEFAULTS,
  TenantSchema,
  agentWorkspaceDefault,
  stripDefaults,
} from "../schemas.ts";
import { writeJsonSchemas, type SchemaPaths } from "../schema-output.ts";
import { safeFolderName } from "../slug.ts";
import { GoClawWSClient } from "../ws-client.ts";

export async function pull(): Promise<void> {
  const config = loadConfig();
  const client = new GoClawClient(config);

  console.log(`→ GoClaw base URL: ${config.baseUrl}`);
  console.log(`→ Output directory: ${config.outputDir}`);

  const schemaPaths = await writeJsonSchemas();

  const allTenants = await client.listTenants();
  const tenants = allTenants.filter((t) => t.status !== "archived");

  if (tenants.length === 0) {
    console.log("No active tenants returned by the API.");
    return;
  }

  for (const tenant of tenants) {
    await pullTenant(client, config, tenant, config.outputDir, schemaPaths);
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

  const agents = await client.listAgents(tenant.id);
  if (agents.length === 0) return;

  // Context files come over a tenant-scoped WebSocket connection.
  const ws = new GoClawWSClient(config);
  try {
    const tenantSlugForWS = typeof tenant.slug === "string" ? tenant.slug : String(tenant.id);
    await ws.connect(tenantSlugForWS);
    for (const agent of agents) {
      await pullAgent(client, ws, tenant, agent, tenantPath, schemaPaths);
    }
  } finally {
    ws.close();
  }
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
  tenantPath: string,
  schemaPaths: SchemaPaths,
): Promise<void> {
  const agentFolder = safeFolderName(agent.agent_key, agent.display_name, agent.id);
  const agentPath = join(tenantPath, agentFolder);
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
