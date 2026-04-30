#!/usr/bin/env bun
import { pull } from "./commands/pull.ts";
import { push } from "./commands/push.ts";

type CommandHandler = (args: string[]) => Promise<void>;

const COMMANDS: Record<string, CommandHandler> = {
  pull: async (args) => {
    const tenantSlug = positional(args);
    await pull({ tenantSlug });
  },
  push: async (args) => {
    const yes = args.includes("-y") || args.includes("--yes");
    const tenantSlug = positional(args);
    await push({ yes, tenantSlug });
  },
};

function positional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

function printUsage(): void {
  console.log(`goclaw-config — pull and push GoClaw configuration via REST API

Usage:
  goclaw-config <command> [<tenant-slug>] [flags]

Commands:
  pull [<tenant-slug>]       Download tenants, providers, MCP servers, skills, and agents (with context files)
  push [<tenant-slug>] [-y]  Sync local tenants/providers/mcps/skills/agents to GoClaw (create / update / archive)
  help                       Show this message

When <tenant-slug> is provided, the command is scoped to that single tenant
(no other tenant is read, written, or archived).

Flags:
  -y, --yes      Apply the plan without asking for confirmation (push only)

Environment:
  GOCLAW_GATEWAY_TOKEN  (required) bearer token for the GoClaw gateway
  GOCLAW_BASE_URL       (optional) gateway base URL, default http://localhost:18790
  GOCLAW_USER_ID        (optional) X-GoClaw-User-Id header, default "system"
  GOCLAW_OUTPUT_DIR     (optional) output folder, default ./goclaw
`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = Bun.argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  await handler(rest);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
