import { z } from "zod";

import { canonical } from "./util.ts";

const RecordOfUnknown = z.record(z.string(), z.unknown());

// ─────────────────────────── Tenant ───────────────────────────

export const TENANT_DEFAULTS = {
  status: "active",
} as const;

export const TenantSchema = z
  .strictObject({
    name: z.string().min(1).describe("Tenant display name (e.g. \"Acme Corp\")."),
    status: z
      .enum(["active", "suspended", "archived"])
      .default(TENANT_DEFAULTS.status)
      .describe("Lifecycle status of the tenant."),
  })
  .describe("Configuration file written to <tenant>/tenant.yaml.");

export type TenantConfig = z.infer<typeof TenantSchema>;

// ─────────────────── Sub-schemas for agent JSONBs ──────────────────

/** internal/config/config_channels.go:425-432 */
const ToolPolicyBase = z
  .strictObject({
    profile: z.string().optional().describe("Named tool policy profile to inherit from."),
    allow: z.array(z.string()).optional().describe("Allowlist of tool names."),
    deny: z.array(z.string()).optional().describe("Denylist of tool names (overrides allow)."),
    alsoAllow: z
      .array(z.string())
      .optional()
      .describe("Extra tools allowed on top of the resolved policy."),
    toolCallPrefix: z
      .string()
      .regex(/^[a-z0-9_{}]+$/)
      .optional()
      .describe("Prefix injected before tool names. Pattern: [a-z0-9_{}]."),
  })
  .describe("Tool policy spec (allow/deny lists with optional per-provider override).");

const ToolsConfigSchema = ToolPolicyBase.extend({
  byProvider: z
    .record(z.string(), ToolPolicyBase)
    .optional()
    .describe("Per-provider override map keyed by provider name."),
});

/** internal/config/config.go:235-257 */
const SandboxConfigSchema = z
  .strictObject({
    mode: z.enum(["off", "non-main", "all"]).optional().describe("When to sandbox tool calls."),
    image: z.string().optional().describe("Docker image used for the sandbox."),
    workspace_access: z
      .enum(["none", "ro", "rw"])
      .optional()
      .describe("How the sandbox sees the workspace."),
    scope: z
      .enum(["session", "agent", "shared"])
      .optional()
      .describe("Container lifetime / sharing scope."),
    memory_mb: z.number().int().nonnegative().optional().describe("Memory cap in MB."),
    cpus: z.number().nonnegative().optional().describe("CPU cap (e.g. 1.5)."),
    timeout_sec: z.number().int().nonnegative().optional().describe("Per-call wall-clock timeout."),
    network_enabled: z.boolean().optional(),
    read_only_root: z.boolean().optional(),
    setup_command: z.string().optional().describe("Command run on container init."),
    env: z.record(z.string(), z.string()).optional().describe("Extra env vars passed to the container."),
    user: z.string().optional().describe("Linux uid:gid the container runs as."),
    tmpfs_size_mb: z.number().int().nonnegative().optional(),
    max_output_bytes: z.number().int().nonnegative().optional(),
    idle_hours: z.number().int().nonnegative().optional().describe("Auto-stop after this much idle time."),
    max_age_days: z.number().int().nonnegative().optional(),
    prune_interval_min: z.number().int().nonnegative().optional(),
  })
  .describe("Docker sandbox configuration for tool execution.");

/** internal/config/config.go:411-418 */
const SubagentsConfigSchema = z
  .strictObject({
    maxConcurrent: z.number().int().nonnegative().optional(),
    maxSpawnDepth: z.number().int().nonnegative().optional(),
    maxChildrenPerAgent: z.number().int().nonnegative().optional(),
    archiveAfterMinutes: z.number().int().nonnegative().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    model: z.string().optional().describe("Model used for spawned subagents."),
  })
  .describe("Subagent dispatch and concurrency configuration.");

/** internal/config/config.go:204-219 */
const DreamingConfigSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    debounce_ms: z.number().int().nonnegative().optional(),
    threshold: z.number().int().nonnegative().optional(),
    verbose_log: z.boolean().optional(),
  })
  .describe("Background dreaming/consolidation pass for memory.");

const MemoryConfigSchema = z
  .strictObject({
    enabled: z.boolean().optional().describe("Master switch for the memory subsystem."),
    embedding_provider: z
      .enum(["openai", "gemini", "openrouter", ""])
      .optional()
      .describe("Embedding provider; \"\" means auto-detect."),
    embedding_model: z.string().optional(),
    embedding_api_base: z.string().optional(),
    max_results: z.number().int().nonnegative().optional(),
    max_chunk_len: z.number().int().nonnegative().optional(),
    chunk_overlap: z.number().int().nonnegative().optional(),
    vector_weight: z.number().optional().describe("Weight for vector similarity in hybrid search."),
    text_weight: z.number().optional().describe("Weight for keyword text match in hybrid search."),
    min_score: z.number().optional().describe("Minimum hybrid score to surface a chunk."),
    dreaming: DreamingConfigSchema.optional(),
  })
  .describe("Memory subsystem configuration (chunking, embeddings, hybrid search, dreaming).");

/** internal/config/config.go:155-169 */
const MemoryFlushSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    softThresholdTokens: z.number().int().nonnegative().optional(),
    prompt: z.string().optional(),
    systemPrompt: z.string().optional(),
  })
  .describe("Memory-flush step inside compaction.");

const CompactionConfigSchema = z
  .strictObject({
    reserveTokensFloor: z.number().int().nonnegative().optional(),
    maxHistoryShare: z
      .number()
      .optional()
      .describe("Fraction of context window allowed for raw history (0.0–1.0)."),
    keepLastMessages: z.number().int().nonnegative().optional(),
    memoryFlush: MemoryFlushSchema.optional(),
  })
  .describe("Session compaction strategy and thresholds.");

/** internal/config/config.go:178-200 */
const SoftTrimSchema = z
  .strictObject({
    maxChars: z.number().int().nonnegative().optional(),
    headChars: z.number().int().nonnegative().optional(),
    tailChars: z.number().int().nonnegative().optional(),
  })
  .describe("Soft-trim range for tool result truncation.");

const HardClearSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    placeholder: z.string().optional(),
  })
  .describe("Hard-clear behaviour once trimming alone is insufficient.");

const ContextPruningSchema = z
  .strictObject({
    mode: z.enum(["", "off", "cache-ttl"]).optional().describe("Pruning strategy; \"\" = use default."),
    ttl: z.string().optional().describe("Go duration string, e.g. \"5m\", \"30s\"."),
    keepLastAssistants: z.number().int().nonnegative().optional(),
    softTrimRatio: z.number().optional(),
    hardClearRatio: z.number().optional(),
    minPrunableToolChars: z.number().int().nonnegative().optional(),
    softTrim: SoftTrimSchema.optional(),
    hardClear: HardClearSchema.optional(),
  })
  .describe("Context pruning policy applied to tool-call history.");

/** internal/store/agent_store.go:359-364 + providers/reasoning_resolution.go */
const ReasoningEffortValues = [
  "off",
  "auto",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

const ReasoningConfigSchema = z
  .strictObject({
    override_mode: z.enum(["inherit", "custom"]).optional(),
    effort: z.enum(ReasoningEffortValues).optional(),
    fallback: z.enum(["downgrade", "off", "provider_default"]).optional(),
  })
  .describe("Extended-reasoning configuration applied to the LLM.");

/** internal/store/agent_store.go:337-344 */
const WorkspaceSharingSchema = z
  .strictObject({
    shared_dm: z.boolean().optional(),
    shared_group: z.boolean().optional(),
    shared_users: z.array(z.string()).optional(),
    share_memory: z.boolean().optional(),
    share_knowledge_graph: z.boolean().optional(),
    share_sessions: z.boolean().optional(),
  })
  .describe(
    "Workspace sharing flags between agent instances. NOTE: any boolean field set to true " +
      "is rejected by `goclaw-config push` for predefined agents.",
  );

/** internal/store/agent_store.go:417-421 */
const ChatGPTOAuthRoutingSchema = z
  .strictObject({
    override_mode: z.enum(["inherit", "custom"]).optional(),
    strategy: z
      .enum(["manual", "primary_first", "round_robin", "priority_order"])
      .optional(),
    extra_provider_names: z.array(z.string()).optional(),
  })
  .describe("Routing across multiple ChatGPT OAuth providers when present.");

// ─────────────────────────── Agent ───────────────────────────

export const AGENT_DEFAULTS = {
  owner_id: "system",
  context_window: 200_000,
  max_tool_iterations: 30,
  restrict_to_workspace: true,
  is_default: false,
  status: "active",
  thinking_level: "" as "" | "off" | "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh",
  tools_config: {} as Record<string, unknown>,
  memory_config: { enabled: true } as Record<string, unknown>,
  compaction_config: {} as Record<string, unknown>,
  other_config: {} as Record<string, unknown>,
  reasoning_config: {} as Record<string, unknown>,
  workspace_sharing: {} as Record<string, unknown>,
  shell_deny_groups: {} as Record<string, boolean>,
  kg_dedup_config: {} as Record<string, unknown>,
  emoji: "",
  max_tokens: 0,
  self_evolve: false,
  skill_evolve: false,
  skill_nudge_interval: 0,
} as const;

export const AgentSchema = z
  .strictObject({
    display_name: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Human-readable name shown in UI; may include emoji. Max 255 chars."),
    frontmatter: z
      .string()
      .optional()
      .describe(
        "Short expertise summary used for agent delegation / routing. Kept inline in the yaml " +
          "(small, single-paragraph). Distinct from agent_description (the summoning prompt), " +
          "which lives in DESCRIPTION.md.",
      ),
    owner_id: z
      .string()
      .default(AGENT_DEFAULTS.owner_id)
      .describe("ID of the user who created the agent. Defaults to \"system\"."),
    provider: z
      .string()
      .min(1)
      .describe(
        "LLM provider name as defined in `llm_providers` (NOT the provider type). " +
          "Examples: anthropic, openai, gemini-native, ollama, openrouter.",
      ),
    model: z.string().min(1).max(200).describe("Provider-specific model identifier (max 200 chars)."),
    context_window: z
      .number()
      .int()
      .nonnegative()
      .default(AGENT_DEFAULTS.context_window)
      .describe("Context window size in tokens."),
    max_tool_iterations: z
      .number()
      .int()
      .nonnegative()
      .default(AGENT_DEFAULTS.max_tool_iterations)
      .describe("Maximum number of tool-call rounds per agent run."),
    workspace: z
      .string()
      .optional()
      .describe(
        "Absolute filesystem path the agent operates within. " +
          "Defaults dynamically to `/app/workspace/<agent_key>` — omit when matching to keep yaml clean.",
      ),
    restrict_to_workspace: z
      .boolean()
      .default(AGENT_DEFAULTS.restrict_to_workspace)
      .describe("When true, file access is sandboxed to the workspace path."),
    is_default: z
      .boolean()
      .default(AGENT_DEFAULTS.is_default)
      .describe("Marks this agent as the tenant default for routing un-targeted requests."),
    status: z
      .enum(["active", "inactive", "summoning", "summon_failed"])
      .default(AGENT_DEFAULTS.status)
      .describe("Lifecycle state of the agent."),
    budget_monthly_cents: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe("Monthly spend cap in USD cents; null/absent means unlimited."),
    tools_config: ToolsConfigSchema.default(AGENT_DEFAULTS.tools_config).describe(
      "Per-tool policy overrides (allow/deny, parameter constraints).",
    ),
    sandbox_config: SandboxConfigSchema.optional().describe(
      "Docker sandbox configuration (when sandboxing is enabled).",
    ),
    subagents_config: SubagentsConfigSchema.optional().describe(
      "Subagent concurrency and dispatch configuration.",
    ),
    memory_config: MemoryConfigSchema.default(AGENT_DEFAULTS.memory_config).describe(
      "Memory subsystem configuration. Common keys: enabled (boolean).",
    ),
    compaction_config: CompactionConfigSchema.default(AGENT_DEFAULTS.compaction_config).describe(
      "Session-compaction strategy and thresholds.",
    ),
    context_pruning: ContextPruningSchema.optional().describe("Context-pruning policy."),
    other_config: RecordOfUnknown.default(AGENT_DEFAULTS.other_config).describe(
      "Miscellaneous configuration bag for promoted/experimental fields " +
        "(e.g. self_evolution_metrics, self_evolution_suggestions).",
    ),
    reasoning_config: ReasoningConfigSchema.default(AGENT_DEFAULTS.reasoning_config).describe(
      "Extended-reasoning / thinking configuration.",
    ),
    workspace_sharing: WorkspaceSharingSchema.default(AGENT_DEFAULTS.workspace_sharing).describe(
      "Workspace sharing settings between agents in the same tenant.",
    ),
    chatgpt_oauth_routing: ChatGPTOAuthRoutingSchema.optional().describe(
      "ChatGPT OAuth routing strategy across multiple providers.",
    ),
    shell_deny_groups: z
      .record(z.string(), z.boolean())
      .default(AGENT_DEFAULTS.shell_deny_groups)
      .describe(
        "Map of shell command group → deny flag, e.g. { package_install: true }. " +
          "Empty object = no groups denied.",
      ),
    kg_dedup_config: RecordOfUnknown.default(AGENT_DEFAULTS.kg_dedup_config).describe(
      "Knowledge-graph deduplication configuration (free-form).",
    ),
    emoji: z
      .string()
      .default(AGENT_DEFAULTS.emoji)
      .describe("Emoji rendered next to the agent in UIs (may be empty)."),
    thinking_level: z
      .enum(["", ...ReasoningEffortValues])
      .default(AGENT_DEFAULTS.thinking_level)
      .describe(
        "Top-level extended-thinking level. \"\" = use server default. " +
          "Same enum as reasoning_config.effort.",
      ),
    max_tokens: z
      .number()
      .int()
      .nonnegative()
      .default(AGENT_DEFAULTS.max_tokens)
      .describe("Output token limit; 0 means use provider default."),
    self_evolve: z
      .boolean()
      .default(AGENT_DEFAULTS.self_evolve)
      .describe(
        "Allows the agent to edit its own SOUL.md/AGENTS.md. " +
          "REJECTED by goclaw-config push for predefined agents.",
      ),
    skill_evolve: z
      .boolean()
      .default(AGENT_DEFAULTS.skill_evolve)
      .describe("Enables the skill-evolution loop."),
    skill_nudge_interval: z
      .number()
      .int()
      .nonnegative()
      .default(AGENT_DEFAULTS.skill_nudge_interval)
      .describe("Number of turns between skill suggestion nudges (0 → server default of 15)."),
  })
  .describe(
    "Configuration file written to <tenant>/<agent>/agent.yaml. " +
      "Long-form fields (frontmatter, agent_description) are extracted to FRONTMATTER.md and DESCRIPTION.md.",
  );

export type AgentConfig = z.infer<typeof AgentSchema>;

/**
 * Dynamic default for an agent's workspace. Mirrors GoClaw's convention.
 * Used at pull-strip time (omit when matches) and at push-fill time (apply
 * when missing) so the yaml stays clean for the common case.
 */
export function agentWorkspaceDefault(agentKey: string): string {
  return `/app/workspace/${agentKey}`;
}

/**
 * Canonical agent-level context files this CLI manages — the set exposed by
 * `agents.files.*` minus per-user / runtime-managed files (USER.md, BOOTSTRAP.md,
 * MEMORY.json). AGENTS_CORE.md / AGENTS_TASK.md / TOOLS.md are not in WS scope
 * and intentionally out of band.
 */
export const CANONICAL_CONTEXT_FILES = new Set([
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER_PREDEFINED.md",
  "CAPABILITIES.md",
  "HEARTBEAT.md",
]);

// ─────────────────────────── Helpers ───────────────────────────

/**
 * Returns a shallow copy of `value` with keys whose value deep-equals their
 * default omitted. Used at YAML write time to keep files clean — fields that
 * are at default values disappear and Zod re-fills them at parse time.
 */
export function stripDefaults(
  value: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k in defaults && canonical(v) === canonical(defaults[k])) continue;
    result[k] = v;
  }
  return result;
}

export const SCHEMA_REGISTRY = {
  tenant: { schema: TenantSchema, fileName: "tenant.schema.json" },
  agent: { schema: AgentSchema, fileName: "agent.schema.json" },
} as const;

export type SchemaName = keyof typeof SCHEMA_REGISTRY;
