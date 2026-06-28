#!/usr/bin/env node
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getV2DataFilePath } from "./v2-config.js";
import { V2MemoryEngine } from "./v2-engine.js";
import { startV2McpServer } from "./v2-mcp-server.js";
import { ingestV2TaskEvents } from "./v2-task-ingest.js";
import type {
  V2ContextMode,
  V2MemoryKind,
  V2RetrievalMode,
} from "./v2-types.js";

interface ParsedArgs {
  positional: string[];
  options: Record<string, string | boolean>;
}

interface CodexRunner {
  command: string;
  prefixArgs: string[];
  label: string;
}

interface CodexMcpServerConfig {
  name: string;
  transport?: {
    type?: string;
    command?: string;
    args?: string[];
  };
}

const APP_NAME = "retentia";
const DEFAULT_V2_MCP_SERVER_NAME = "retentia";
const SUPPORTED_CLIENTS = ["codex", "claude-code"] as const;
const V2_TOP_LEVEL_ACTIONS = new Set([
  "init",
  "install",
  "mcp-config",
  "event",
  "memory",
  "memory-get",
  "memory-update",
  "memory-pin",
  "memory-archive",
  "memory-delete",
  "memory-merge",
  "memory-stale",
  "evidence",
  "evidence-search",
  "search",
  "context",
  "edge",
  "graph",
  "dashboard",
  "doctor",
  "health",
  "ingest",
]);
const V2_MEMORY_KINDS: V2MemoryKind[] = [
  "episode",
  "fact",
  "decision",
  "preference",
  "procedure",
  "constraint",
  "artifact",
  "todo",
];
const V2_CONTEXT_MODES: V2ContextMode[] = [
  "ids",
  "brief",
  "task-primer",
  "full-evidence",
];

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command = "mcp"] = parsed.positional;
  const dataFile = getOptionalString(parsed.options["data-file"]);
  const scriptPath = resolve(process.argv[1] || "");

  switch (command) {
    case "install": {
      printJson(installV2Mcp(parsed, scriptPath, getV2DataFilePath(dataFile)));
      return;
    }

    case "mcp": {
      await startV2McpServer({ dataFile });
      return;
    }

    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    default:
      if (V2_TOP_LEVEL_ACTIONS.has(command)) {
        await handleV2Command(parsed, scriptPath, dataFile, command);
        return;
      }

      throw new Error(`Unknown command: ${command}`);
      return;
  }
}

async function handleV2Command(
  parsed: ParsedArgs,
  scriptPath: string,
  dataFile: string | undefined,
  actionOverride?: string,
): Promise<void> {
  const action = actionOverride || parsed.positional[1] || "help";
  const v2DataFile = getV2DataFilePath(dataFile);

  if (action === "install") {
    printJson(installV2Mcp(parsed, scriptPath, v2DataFile));
    return;
  }

  if (action === "mcp-config") {
    printJson(buildV2McpConfig(parsed, scriptPath, v2DataFile));
    return;
  }

  if (action === "help" || action === "--help" || action === "-h") {
    printHelp();
    return;
  }

  const engine = new V2MemoryEngine(v2DataFile);
  try {
    switch (action) {
      case "init":
        printJson({
          ok: true,
          engine: "retentia",
          dataFile: v2DataFile,
          clients: SUPPORTED_CLIENTS,
          message: "Retentia store is ready",
        });
        return;

      case "event": {
        const saved = engine.addEvent({
          type: getRequiredString(parsed.options.type, "--type"),
          source: getRequiredString(parsed.options.source, "--source"),
          actor: getOptionalString(parsed.options.actor),
          role: getOptionalString(parsed.options.role),
          taskId: getOptionalString(parsed.options["task-id"]),
          parentTaskId: getOptionalString(parsed.options["parent-task-id"]),
          project: getOptionalString(parsed.options.project),
          summary: getOptionalString(parsed.options.summary),
          tags: getCsvList(parsed.options.tags),
          artifacts: getCsvList(parsed.options.artifacts),
          payload: parseJsonOption(parsed.options.payload),
        });
        printJson(saved);
        return;
      }

      case "memory": {
        const saved = engine.addMemory({
          kind: getV2MemoryKind(
            getRequiredString(parsed.options.kind, "--kind"),
          ),
          title: getRequiredString(parsed.options.title, "--title"),
          body: getRequiredString(parsed.options.body, "--body"),
          project: getOptionalString(parsed.options.project),
          tags: getCsvList(parsed.options.tags),
          sourceEventIds: getCsvList(parsed.options["source-event-ids"])
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0),
          confidence: getOptionalNumber(parsed.options.confidence),
          pinned: Boolean(parsed.options.pinned),
        });
        printJson(saved);
        return;
      }

      case "memory-get": {
        printJson(
          engine.getMemoryById(
            getRequiredNumber(parsed.options.id, "--id"),
            true,
          ),
        );
        return;
      }

      case "memory-update": {
        const saved = engine.updateMemory(
          getRequiredNumber(parsed.options.id, "--id"),
          {
            kind: getOptionalV2MemoryKind(parsed.options.kind),
            title: getOptionalString(parsed.options.title),
            body: getOptionalString(parsed.options.body),
            project: getOptionalString(parsed.options.project),
            tags:
              parsed.options.tags === undefined
                ? undefined
                : getCsvList(parsed.options.tags),
            sourceEventIds:
              parsed.options["source-event-ids"] === undefined
                ? undefined
                : getCsvList(parsed.options["source-event-ids"])
                    .map((value) => Number(value))
                    .filter((value) => Number.isInteger(value) && value > 0),
            confidence: getOptionalNumber(parsed.options.confidence),
            pinned: parsed.options.pinned
              ? true
              : parsed.options.unpinned
                ? false
                : undefined,
            archived: parsed.options.archived
              ? true
              : parsed.options.unarchived
                ? false
                : undefined,
          },
        );
        printJson(saved);
        return;
      }

      case "memory-pin": {
        printJson(
          engine.setMemoryPinned(
            getRequiredNumber(parsed.options.id, "--id"),
            !parsed.options.unpin,
          ),
        );
        return;
      }

      case "memory-archive": {
        printJson(
          engine.archiveMemory(
            getRequiredNumber(parsed.options.id, "--id"),
            !parsed.options.restore,
          ),
        );
        return;
      }

      case "memory-delete": {
        if (!parsed.options.yes) {
          throw new Error("memory-delete requires --yes.");
        }
        printJson(engine.deleteMemory(getRequiredNumber(parsed.options.id, "--id")));
        return;
      }

      case "memory-merge": {
        const merged = engine.mergeMemories(
          getRequiredNumber(parsed.options["primary-id"], "--primary-id"),
          getCsvList(parsed.options["duplicate-ids"]).map((value) =>
            Number(value),
          ),
        );
        printJson(merged);
        return;
      }

      case "memory-stale": {
        const memories = engine.listStaleMemories({
          olderThanDays: getOptionalNumber(parsed.options["older-than-days"]),
          project: getOptionalString(parsed.options.project),
          limit: getOptionalNumber(parsed.options.limit),
        });
        printJson({ total: memories.length, memories });
        return;
      }

      case "evidence": {
        const saved = engine.addEvidence({
          sourceType: getRequiredString(
            parsed.options["source-type"],
            "--source-type",
          ),
          sourceId: getRequiredString(
            parsed.options["source-id"],
            "--source-id",
          ),
          content: getRequiredString(parsed.options.content, "--content"),
          project: getOptionalString(parsed.options.project),
          uri: getOptionalString(parsed.options.uri),
          offsetStart: getOptionalNumber(parsed.options["offset-start"]),
          offsetEnd: getOptionalNumber(parsed.options["offset-end"]),
          metadata: parseJsonOption(parsed.options.metadata),
          redact: parsed.options["no-redact"] ? false : true,
        });
        printJson(saved);
        return;
      }

      case "evidence-search": {
        const results = engine.searchEvidence({
          query: getOptionalString(parsed.options.query),
          project: getOptionalString(parsed.options.project),
          sourceType: getOptionalString(parsed.options["source-type"]),
          sourceId: getOptionalString(parsed.options["source-id"]),
          limit: getOptionalNumber(parsed.options.limit),
        });
        printJson({ total: results.length, results });
        return;
      }

      case "search": {
        const results = engine.search({
          query: getOptionalString(parsed.options.query),
          project: getOptionalString(parsed.options.project),
          kind: getOptionalV2MemoryKind(parsed.options.kind),
          tags: getCsvList(parsed.options.tags),
          limit: getOptionalNumber(parsed.options.limit),
          retrieval: getOptionalV2RetrievalMode(parsed.options.retrieval),
          explain: Boolean(parsed.options.explain),
          includeArchived: Boolean(parsed.options["include-archived"]),
        });
        printJson({ total: results.length, results });
        return;
      }

      case "context": {
        const context = engine.buildContext({
          query: getOptionalString(parsed.options.query),
          project: getOptionalString(parsed.options.project),
          kind: getOptionalV2MemoryKind(parsed.options.kind),
          tags: getCsvList(parsed.options.tags),
          limit: getOptionalNumber(parsed.options.limit),
          mode: getOptionalV2ContextMode(parsed.options.mode),
          maxChars: getOptionalNumber(parsed.options["max-chars"]),
        });

        if (parsed.options.json) {
          printJson(context);
          return;
        }

        process.stdout.write(`${context.text}\n`);
        return;
      }

      case "edge": {
        const saved = engine.addEdge({
          fromType: getRequiredString(
            parsed.options["from-type"],
            "--from-type",
          ),
          fromId: getRequiredString(parsed.options["from-id"], "--from-id"),
          toType: getRequiredString(parsed.options["to-type"], "--to-type"),
          toId: getRequiredString(parsed.options["to-id"], "--to-id"),
          relation: getRequiredString(parsed.options.relation, "--relation"),
          weight: getOptionalNumber(parsed.options.weight),
          metadata: parseJsonOption(parsed.options.metadata),
        });
        printJson(saved);
        return;
      }

      case "graph": {
        const edges = engine.listEdgesForNode(
          getRequiredString(parsed.options["node-type"], "--node-type"),
          getRequiredString(parsed.options["node-id"], "--node-id"),
          getOptionalNumber(parsed.options.limit),
        );
        printJson({ total: edges.length, edges });
        return;
      }

      case "dashboard": {
        printJson(
          engine.buildDashboard(getOptionalNumber(parsed.options.limit)),
        );
        return;
      }

      case "doctor":
      case "health": {
        printJson(engine.buildHealthReport());
        return;
      }

      case "ingest": {
        const result = ingestV2TaskEvents(engine, {
          providers: getCsvList(parsed.options.providers),
          copilotPath: getOptionalString(parsed.options["copilot-path"]),
          codexPath: getOptionalString(parsed.options["codex-path"]),
          claudePath: getOptionalString(parsed.options["claude-path"]),
          lookbackDays: getOptionalNumber(parsed.options["lookback-days"]),
          maxFilesPerProvider: getOptionalNumber(parsed.options["max-files"]),
          maxImport: getOptionalNumber(parsed.options["max-import"]),
          fallbackProject:
            getOptionalString(parsed.options.project) ||
            basenameSafe(process.cwd()),
        });
        printJson(result);
        return;
      }

      default:
        throw new Error(`Unknown command: ${action}`);
    }
  } finally {
    engine.close();
  }
}

function installV2Mcp(
  parsed: ParsedArgs,
  scriptPath: string,
  dataFile: string,
): Record<string, unknown> {
  const client = getSupportedClient(parsed.options.client);
  const name =
    getOptionalString(parsed.options.name) || DEFAULT_V2_MCP_SERVER_NAME;
  const config = buildV2McpConfig(parsed, scriptPath, dataFile);

  if (client === "claude-code") {
    return {
      ok: true,
      installed: false,
      client,
      name,
      dataFile,
      message: "Copy this MCP config into your client configuration.",
      config,
    };
  }

  const addArgs = [
    "mcp",
    "add",
    name,
    "--",
    "node",
    scriptPath,
    "mcp",
    "--data-file",
    dataFile,
  ];
  const commandPreview = ["codex", ...addArgs].join(" ");

  if (parsed.options["dry-run"]) {
    return {
      ok: true,
      installed: false,
      dryRun: true,
      client,
      name,
      dataFile,
      command: commandPreview,
      config,
    };
  }

  const runner = resolveCodexRunner();
  const listResult = runCodexCommand(runner, ["mcp", "list", "--json"]);
  const configured = parseCodexMcpList(listResult.stdout).find(
    (item) => item.name === name,
  );
  if (configured) {
    runCodexCommand(runner, ["mcp", "remove", name]);
  }
  runCodexCommand(runner, addArgs);

  return {
    ok: true,
    installed: true,
    changed: true,
    client,
    name,
    dataFile,
    using: runner.label,
    command: [runner.command, ...runner.prefixArgs, ...addArgs].join(" "),
  };
}

function buildV2McpConfig(
  parsed: ParsedArgs,
  scriptPath: string,
  dataFile: string,
): Record<string, unknown> {
  const client = getSupportedClient(parsed.options.client);
  const name =
    getOptionalString(parsed.options.name) || DEFAULT_V2_MCP_SERVER_NAME;
  const args = [scriptPath, "mcp", "--data-file", dataFile];

  if (client === "codex") {
    return {
      client,
      name,
      command: "codex",
      args: ["mcp", "add", name, "--", "node", ...args],
    };
  }

  return {
    client,
    name,
    mcpServers: {
      [name]: {
        command: "node",
        args,
      },
    },
  };
}

function getSupportedClient(
  value: string | boolean | undefined,
): (typeof SUPPORTED_CLIENTS)[number] {
  const client = (getOptionalString(value) || "codex").toLowerCase();
  if (
    !SUPPORTED_CLIENTS.includes(client as (typeof SUPPORTED_CLIENTS)[number])
  ) {
    throw new Error(`--client must be one of: ${SUPPORTED_CLIENTS.join(", ")}`);
  }
  return client as (typeof SUPPORTED_CLIENTS)[number];
}

function getV2MemoryKind(value: string): V2MemoryKind {
  if (!V2_MEMORY_KINDS.includes(value as V2MemoryKind)) {
    throw new Error(`--kind must be one of: ${V2_MEMORY_KINDS.join(", ")}`);
  }
  return value as V2MemoryKind;
}

function getOptionalV2MemoryKind(
  value: string | boolean | undefined,
): V2MemoryKind | undefined {
  const normalized = getOptionalString(value);
  return normalized ? getV2MemoryKind(normalized) : undefined;
}

function getOptionalV2ContextMode(
  value: string | boolean | undefined,
): V2ContextMode | undefined {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (!V2_CONTEXT_MODES.includes(normalized as V2ContextMode)) {
    throw new Error(`--mode must be one of: ${V2_CONTEXT_MODES.join(", ")}`);
  }
  return normalized as V2ContextMode;
}

function getOptionalV2RetrievalMode(
  value: string | boolean | undefined,
): V2RetrievalMode | undefined {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized !== "fts" && normalized !== "hybrid") {
    throw new Error("--retrieval must be one of: fts, hybrid");
  }
  return normalized;
}

function parseJsonOption(
  value: string | boolean | undefined,
): unknown | undefined {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return undefined;
  }

  try {
    return JSON.parse(normalized) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON option: ${message}`);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return { positional, options };
}

function getRequiredString(
  value: string | boolean | undefined,
  flag: string,
): string {
  const normalized = getOptionalString(value);
  if (!normalized) {
    throw new Error(`${flag} is required.`);
  }

  return normalized;
}

function getRequiredNumber(
  value: string | boolean | undefined,
  flag: string,
): number {
  const parsed = getOptionalNumber(value);
  if (parsed === undefined) {
    throw new Error(`${flag} is required.`);
  }
  return parsed;
}

function getOptionalString(
  value: string | boolean | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function getOptionalNumber(
  value: string | boolean | undefined,
): number | undefined {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function getCsvList(value: string | boolean | undefined): string[] {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function basenameSafe(path: string): string {
  const name = basename(path).trim();
  return name || "project";
}

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printHelp(): void {
  const lines = [
    `${APP_NAME}: personal memory, RAG, and agent graph engine for Codex and Claude Code`,
    "",
    "Usage:",
    `  ${APP_NAME} install [--client codex|claude-code] [--name retentia] [--data-file <path>] [--dry-run]`,
    `  ${APP_NAME} mcp [--data-file <path>]`,
    `  ${APP_NAME} init [--data-file <path>]`,
    `  ${APP_NAME} event --type <type> --source <codex|claude-code> [--summary <text>]`,
    `  ${APP_NAME} memory --kind <kind> --title <text> --body <text> [--tags <a,b>]`,
    `  ${APP_NAME} memory-get --id <id>`,
    `  ${APP_NAME} memory-update --id <id> [--title <text>] [--body <text>] [--pinned|--unpinned]`,
    `  ${APP_NAME} memory-archive --id <id> [--restore]`,
    `  ${APP_NAME} memory-delete --id <id> --yes`,
    `  ${APP_NAME} memory-merge --primary-id <id> --duplicate-ids <a,b>`,
    `  ${APP_NAME} memory-stale [--older-than-days <n>] [--project <name>]`,
    `  ${APP_NAME} evidence --source-type <type> --source-id <id> --content <text> [--uri <path>]`,
    `  ${APP_NAME} evidence-search [--query <text>] [--source-type <type>] [--source-id <id>]`,
    `  ${APP_NAME} search [--query <text>] [--project <name>] [--kind <kind>] [--retrieval fts|hybrid] [--explain]`,
    `  ${APP_NAME} context [--query <text>] [--mode ids|brief|task-primer|full-evidence] [--max-chars <n>]`,
    `  ${APP_NAME} edge --from-type <type> --from-id <id> --to-type <type> --to-id <id> --relation <name>`,
    `  ${APP_NAME} graph --node-type <type> --node-id <id>`,
    `  ${APP_NAME} dashboard [--limit <n>]`,
    `  ${APP_NAME} doctor [--data-file <path>]`,
    "",
    "Global options:",
    "  --data-file <path>   Override SQLite DB path (default: ~/.retentia/retentia-v2.db)",
    `  --name <mcp-name>    MCP server name used by install (default: ${DEFAULT_V2_MCP_SERVER_NAME})`,
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

function resolveCodexRunner(): CodexRunner {
  if (commandExists("codex")) {
    return {
      command: "codex",
      prefixArgs: [],
      label: "codex",
    };
  }

  if (commandExists("npx")) {
    return {
      command: "npx",
      prefixArgs: ["--yes", "@openai/codex"],
      label: "npx @openai/codex",
    };
  }

  throw new Error(
    "Neither `codex` nor `npx` is available. Install @openai/codex or ensure npx is on PATH.",
  );
}

function commandExists(command: string): boolean {
  const check = spawnSync(command, ["--version"], { encoding: "utf8" });
  return !check.error && check.status === 0;
}

function runCodexCommand(
  runner: CodexRunner,
  args: string[],
): { stdout: string; stderr: string } {
  const result = spawnSync(runner.command, [...runner.prefixArgs, ...args], {
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      [
        `Codex command failed: ${runner.command} ${[...runner.prefixArgs, ...args].join(" ")}`,
        result.stderr?.trim(),
        result.stdout?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function parseCodexMcpList(json: string): CodexMcpServerConfig[] {
  if (!json.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as CodexMcpServerConfig[];
  } catch {
    return [];
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${APP_NAME} error: ${message}\n`);
  process.exit(1);
});
