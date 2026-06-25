#!/usr/bin/env node
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildContextPack } from "./context-pack.js";
import { buildExecutionReport } from "./execution-report.js";
import { startMcpServer } from "./mcp-server.js";
import { MemoryStore } from "./store.js";
import { syncTaskExecutions, type LlmProvider } from "./task-sync.js";
import { getV2DataFilePath } from "./v2-config.js";
import { V2MemoryEngine } from "./v2-engine.js";
import { startV2McpServer } from "./v2-mcp-server.js";
import { ingestV2TaskEvents } from "./v2-task-ingest.js";
import type { V2ContextMode, V2MemoryKind } from "./v2-types.js";
import { startWorkerService } from "./worker-service.js";
import { WorkerManager } from "./worker-manager.js";
import {
  DEFAULT_WORKER_HOST,
  DEFAULT_WORKER_PORT,
  getWorkerBaseUrl,
} from "./worker-config.js";

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
const DEFAULT_MCP_SERVER_NAME = "retentia";
const DEFAULT_V2_MCP_SERVER_NAME = "retentia";
const SUPPORTED_CLIENTS = ["codex", "claude-code"] as const;
const V2_TOP_LEVEL_ACTIONS = new Set([
  "init",
  "install",
  "mcp-config",
  "event",
  "memory",
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
  "migrate",
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
  const host = getOptionalString(parsed.options.host) || DEFAULT_WORKER_HOST;
  const port = getOptionalNumber(parsed.options.port) || DEFAULT_WORKER_PORT;
  const scriptPath = resolve(process.argv[1] || "");

  const manager = new WorkerManager({
    host,
    port,
    dataFile,
    scriptPath,
  });

  switch (command) {
    case "setup": {
      printJson(installV2Mcp(parsed, scriptPath, getV2DataFilePath(dataFile)));
      return;
    }

    case "install":
    case "enable": {
      printJson(installV2Mcp(parsed, scriptPath, getV2DataFilePath(dataFile)));
      return;
    }

    case "mcp":
    case "v2-mcp": {
      await startV2McpServer({ dataFile });
      return;
    }

    case "v2": {
      await handleV2Command(parsed, scriptPath, dataFile);
      return;
    }

    case "v1":
    case "legacy": {
      await handleStoreCommand(
        parsed,
        parsed.positional[1] || "help",
        dataFile,
        manager,
      );
      return;
    }

    case "worker": {
      await handleWorkerCommand(parsed, manager, { host, port, dataFile });
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
    printV2Help();
    return;
  }

  const engine = new V2MemoryEngine(v2DataFile);
  try {
    switch (action) {
      case "init":
        printJson({
          ok: true,
          engine: "retentia-v2",
          dataFile: v2DataFile,
          clients: SUPPORTED_CLIENTS,
          message: "Retentia v2 store is ready",
        });
        return;

      case "migrate": {
        const fromDataFile = getOptionalString(
          parsed.options["from-data-file"],
        );
        const result = migrateLegacyStore(engine, fromDataFile);
        printJson({
          ok: true,
          fromDataFile: result.fromDataFile,
          toDataFile: v2DataFile,
          migrated: result,
        });
        return;
      }

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
        throw new Error(`Unknown v2 action: ${action}`);
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

function migrateLegacyStore(
  engine: V2MemoryEngine,
  fromDataFile?: string,
): {
  fromDataFile: string;
  entriesRead: number;
  eventsCreated: number;
  memoriesCreated: number;
  edgesCreated: number;
} {
  const legacyStore = new MemoryStore(fromDataFile);
  const fromPath = legacyStore.getDataFilePath();
  let entriesRead = 0;
  let eventsCreated = 0;
  let memoriesCreated = 0;
  let edgesCreated = 0;
  let offset = 0;
  const limit = 2000;

  try {
    while (true) {
      const entries = legacyStore.listEntries({ limit, offset });
      if (entries.length === 0) {
        break;
      }

      for (const entry of entries) {
        entriesRead += 1;
        const event = engine.addEvent({
          type: "observation",
          source: "legacy-migration",
          project: entry.project,
          summary: buildLegacyEventSummary(entry),
          tags: ["migrated:v1", `v1:${entry.kind}`, ...entry.tags],
          artifacts:
            entry.kind === "observation" ? entry.files : entry.filesEdited,
          payload: {
            legacyId: entry.id,
            legacyKind: entry.kind,
            sessionId: entry.sessionId,
            externalKey: entry.externalKey,
            createdAt: entry.createdAt,
          },
          createdAt: entry.createdAt,
        });
        eventsCreated += 1;

        const memory = engine.addMemory({
          kind: mapLegacyMemoryKind(entry),
          project: entry.project,
          title: buildLegacyMemoryTitle(entry),
          body: buildLegacyMemoryBody(entry),
          tags: ["migrated:v1", `v1:${entry.kind}`, ...entry.tags],
          sourceEventIds: [event.id],
          confidence: 0.8,
          createdAt: entry.createdAt,
        });
        memoriesCreated += 1;

        engine.addEdge({
          fromType: "event",
          fromId: String(event.id),
          toType: "memory",
          toId: String(memory.id),
          relation: "distilled_into",
          weight: 1,
          createdAt: entry.createdAt,
          metadata: { legacyId: entry.id, legacyKind: entry.kind },
        });
        edgesCreated += 1;
      }

      if (entries.length < limit) {
        break;
      }
      offset += entries.length;
    }
  } finally {
    legacyStore.close();
  }

  return {
    fromDataFile: fromPath,
    entriesRead,
    eventsCreated,
    memoriesCreated,
    edgesCreated,
  };
}

function buildLegacyEventSummary(
  entry: import("./types.js").MemoryEntry,
): string {
  if (entry.kind === "observation") {
    return `${entry.title}: ${entry.content}`;
  }
  return [entry.request, entry.learned, entry.completed, entry.nextSteps]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" | ");
}

function mapLegacyMemoryKind(
  entry: import("./types.js").MemoryEntry,
): V2MemoryKind {
  if (entry.kind === "summary") {
    return "episode";
  }
  if (entry.observationType === "decision") {
    return "decision";
  }
  if (entry.observationType === "discovery") {
    return "fact";
  }
  if (entry.observationType === "bugfix") {
    return "procedure";
  }
  return "episode";
}

function buildLegacyMemoryTitle(
  entry: import("./types.js").MemoryEntry,
): string {
  if (entry.kind === "observation") {
    return entry.title;
  }
  return (
    entry.request ||
    clipText(entry.learned, 90) ||
    `Migrated summary #${entry.id}`
  );
}

function buildLegacyMemoryBody(
  entry: import("./types.js").MemoryEntry,
): string {
  if (entry.kind === "observation") {
    return [
      entry.content,
      entry.files.length > 0 ? `Files: ${entry.files.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    entry.request ? `Request: ${entry.request}` : "",
    entry.investigated ? `Investigated: ${entry.investigated}` : "",
    entry.learned ? `Learned: ${entry.learned}` : "",
    entry.completed ? `Completed: ${entry.completed}` : "",
    entry.nextSteps ? `Next steps: ${entry.nextSteps}` : "",
    entry.filesRead.length > 0
      ? `Files read: ${entry.filesRead.join(", ")}`
      : "",
    entry.filesEdited.length > 0
      ? `Files edited: ${entry.filesEdited.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function clipText(value: string, maxLength: number): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
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

function printV2Help(): void {
  const lines = [
    `${APP_NAME} v2: local-first memory, RAG, and agent graph engine`,
    "",
    "Usage:",
    `  ${APP_NAME} v2 init [--data-file <path>]`,
    `  ${APP_NAME} v2 install [--client codex|claude-code] [--name retentia] [--data-file <path>] [--dry-run]`,
    `  ${APP_NAME} v2 mcp-config [--client codex|claude-code] [--name retentia] [--data-file <path>]`,
    `  ${APP_NAME} v2 migrate [--from-data-file <old-retentia.db>] [--data-file <new-retentia-v2.db>]`,
    `  ${APP_NAME} v2 event --type <type> --source <source> [--actor <id>] [--task-id <id>] [--summary <text>]`,
    `  ${APP_NAME} v2 memory --kind <kind> --title <text> --body <text> [--tags <a,b>] [--pinned]`,
    `  ${APP_NAME} v2 evidence --source-type <type> --source-id <id> --content <text> [--uri <path>]`,
    `  ${APP_NAME} v2 evidence-search [--query <text>] [--source-type <type>] [--source-id <id>]`,
    `  ${APP_NAME} v2 search [--query <text>] [--project <name>] [--kind <kind>] [--tags <a,b>]`,
    `  ${APP_NAME} v2 context [--query <text>] [--mode ids|brief|task-primer|full-evidence] [--max-chars <n>]`,
    `  ${APP_NAME} v2 edge --from-type <type> --from-id <id> --to-type <type> --to-id <id> --relation <name>`,
    `  ${APP_NAME} v2 graph --node-type <type> --node-id <id>`,
    `  ${APP_NAME} v2 dashboard [--limit <n>]`,
    `  ${APP_NAME} v2 doctor [--data-file <path>]`,
    `  ${APP_NAME} v2 ingest [--providers copilot,codex,claude-code] [--max-import <n>]`,
    `  ${APP_NAME} mcp [--data-file <path>]`,
    "",
    `Memory kinds: ${V2_MEMORY_KINDS.join(", ")}`,
    `Context modes: ${V2_CONTEXT_MODES.join(", ")}`,
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function handleSetupCommand(
  parsed: ParsedArgs,
  scriptPath: string,
  host: string,
  port: number,
  dataFile: string | undefined,
  manager: WorkerManager,
): Promise<void> {
  const enableResult = await ensureEnabled(
    parsed,
    scriptPath,
    host,
    port,
    dataFile,
  );
  const workerStatus = await manager.start();
  printJson({
    ok: true,
    setup: true,
    enable: enableResult,
    worker: workerStatus,
    message: "Setup complete. You can now run `codex` directly.",
  });
}

async function ensureEnabled(
  parsed: ParsedArgs,
  scriptPath: string,
  host: string,
  port: number,
  dataFile: string | undefined,
): Promise<Record<string, unknown>> {
  const name =
    getOptionalString(parsed.options.name) || DEFAULT_MCP_SERVER_NAME;
  const runner = resolveCodexRunner();
  const addArgs = [
    "mcp",
    "add",
    name,
    "--",
    "node",
    scriptPath,
    "mcp",
    "--host",
    host,
    "--port",
    String(port),
    ...(dataFile ? ["--data-file", dataFile] : []),
  ];

  const listResult = runCodexCommand(runner, ["mcp", "list", "--json"]);
  const configured = parseCodexMcpList(listResult.stdout).find(
    (item) => item.name === name,
  );
  const targetArgs = [
    scriptPath,
    "mcp",
    "--host",
    host,
    "--port",
    String(port),
    ...(dataFile ? ["--data-file", dataFile] : []),
  ];
  const alreadyConfigured =
    configured?.transport?.type === "stdio" &&
    configured.transport.command === "node" &&
    JSON.stringify(configured.transport.args || []) ===
      JSON.stringify(targetArgs);

  if (alreadyConfigured) {
    return {
      ok: true,
      enabled: true,
      changed: false,
      name,
      using: runner.label,
      message: `${APP_NAME} MCP server already configured`,
    };
  }

  if (configured) {
    runCodexCommand(runner, ["mcp", "remove", name]);
  }

  runCodexCommand(runner, addArgs);
  return {
    ok: true,
    enabled: true,
    changed: true,
    name,
    using: runner.label,
    command: [runner.command, ...runner.prefixArgs, ...addArgs].join(" "),
  };
}

async function handleWorkerCommand(
  parsed: ParsedArgs,
  manager: WorkerManager,
  options: { host: string; port: number; dataFile?: string },
): Promise<void> {
  const action = parsed.positional[1] || "status";

  switch (action) {
    case "start":
      printJson(await manager.start());
      return;

    case "stop":
      await manager.stop();
      printJson({ ok: true, message: "worker stopped" });
      return;

    case "restart":
      printJson(await manager.restart());
      return;

    case "status":
      printJson(await manager.status());
      return;

    case "run": {
      const instance = await startWorkerService(options);
      printJson({
        ok: true,
        mode: "foreground",
        host: instance.host,
        port: instance.port,
        baseUrl: getWorkerBaseUrl(instance.host, instance.port),
      });
      await new Promise<void>(() => {
        // keep process alive until externally terminated
      });
      return;
    }

    default:
      throw new Error(`Unknown worker action: ${action}`);
  }
}

async function handleStoreCommand(
  parsed: ParsedArgs,
  command: string,
  dataFile: string | undefined,
  manager: WorkerManager,
): Promise<void> {
  const store = new MemoryStore(dataFile);

  try {
    switch (command) {
      case "init": {
        printJson({
          ok: true,
          dataFile: store.getDataFilePath(),
          worker: await manager.status(),
          message: `${APP_NAME} store is ready`,
        });
        return;
      }

      case "kpis": {
        printJson({
          ok: true,
          dataFile: store.getDataFilePath(),
          worker: await manager.status(),
          kpis: store.getKpis(),
        });
        return;
      }

      case "add-observation": {
        const title = getRequiredString(parsed.options.title, "--title");
        const content = getRequiredString(parsed.options.content, "--content");
        const saved = store.addObservation({
          project: getOptionalString(parsed.options.project),
          sessionId: getOptionalString(parsed.options["session-id"]),
          externalKey: getOptionalString(parsed.options["external-key"]),
          observationType: getOptionalString(parsed.options.type) as
            | "bugfix"
            | "feature"
            | "refactor"
            | "discovery"
            | "decision"
            | "change"
            | "note"
            | undefined,
          title,
          content,
          tags: getCsvList(parsed.options.tags),
          files: getCsvList(parsed.options.files),
        });
        printJson(saved);
        return;
      }

      case "add-summary": {
        const learned = getRequiredString(parsed.options.learned, "--learned");
        const saved = store.addSummary({
          project: getOptionalString(parsed.options.project),
          sessionId: getOptionalString(parsed.options["session-id"]),
          externalKey: getOptionalString(parsed.options["external-key"]),
          request: getOptionalString(parsed.options.request),
          investigated: getOptionalString(parsed.options.investigated),
          learned,
          completed: getOptionalString(parsed.options.completed),
          nextSteps: getOptionalString(parsed.options["next-steps"]),
          tags: getCsvList(parsed.options.tags),
          filesRead: getCsvList(parsed.options["files-read"]),
          filesEdited: getCsvList(parsed.options["files-edited"]),
        });
        printJson(saved);
        return;
      }

      case "search": {
        const results = store.search({
          query: getOptionalString(parsed.options.query),
          project: getOptionalString(parsed.options.project),
          kind: getOptionalString(parsed.options.kind) as
            | "observation"
            | "summary"
            | undefined,
          since: getOptionalString(parsed.options.since),
          until: getOptionalString(parsed.options.until),
          limit: getOptionalNumber(parsed.options.limit),
        });
        printJson({ total: results.length, results });
        return;
      }

      case "timeline": {
        const timeline = store.timeline({
          id: getOptionalNumber(parsed.options.id),
          query: getOptionalString(parsed.options.query),
          project: getOptionalString(parsed.options.project),
          before: getOptionalNumber(parsed.options.before),
          after: getOptionalNumber(parsed.options.after),
        });
        printJson(timeline);
        return;
      }

      case "get": {
        const ids = getCsvList(parsed.options.ids).map((value) =>
          Number(value),
        );
        const clean = ids.filter((value) => !Number.isNaN(value));
        if (clean.length === 0) {
          throw new Error("--ids is required (comma-separated numeric ids).");
        }

        const entries = store.getEntries(clean);
        printJson({ total: entries.length, entries });
        return;
      }

      case "context": {
        const context = buildContextPack(store, {
          query: getOptionalString(parsed.options.query),
          project: getOptionalString(parsed.options.project),
          limit: getOptionalNumber(parsed.options.limit),
          fullCount: getOptionalNumber(parsed.options["full-count"]),
        });
        process.stdout.write(`${context}\n`);
        return;
      }

      case "list-projects":
        printJson({ projects: store.listProjects() });
        return;

      case "list-entries": {
        const entries = store.listEntries({
          project: getOptionalString(parsed.options.project),
          kind: getOptionalString(parsed.options.kind) as
            | "observation"
            | "summary"
            | undefined,
          since: getOptionalString(parsed.options.since),
          until: getOptionalString(parsed.options.until),
          limit: getOptionalNumber(parsed.options.limit),
          offset: getOptionalNumber(parsed.options.offset),
        });
        printJson({ total: entries.length, entries });
        return;
      }

      case "io-trace": {
        const events = store.listIoTrace({
          source: getOptionalString(parsed.options.source),
          op: getOptionalString(parsed.options.op) as
            | "w_obs"
            | "w_sum"
            | "q_search"
            | "q_timeline"
            | "r_entries"
            | "r_context"
            | "r_projects"
            | undefined,
          since: getOptionalString(parsed.options.since),
          until: getOptionalString(parsed.options.until),
          limit: getOptionalNumber(parsed.options.limit),
          offset: getOptionalNumber(parsed.options.offset),
        });
        printJson({
          total: events.length,
          events,
          legend: {
            ops: {
              w_obs: "write observation",
              w_sum: "write summary",
              q_search: "search query",
              q_timeline: "timeline query",
              r_entries: "read entries by ids",
              r_context: "read context pack",
              r_projects: "read projects",
            },
            compactKeys: {
              p: "project",
              sid: "sessionId",
              ek: "externalKey",
              q: "query",
              k: "kind",
              l: "limit",
              o: "offset",
              n: "count",
              ids: "entry ids",
              at: "createdAt",
              chars: "context character length",
            },
          },
        });
        return;
      }

      case "execution-report": {
        const entries = store.listEntries({
          project: getOptionalString(parsed.options.project),
          kind: getOptionalString(parsed.options.kind) as
            | "observation"
            | "summary"
            | undefined,
          since: getOptionalString(parsed.options.since),
          until: getOptionalString(parsed.options.until),
          limit: getOptionalNumber(parsed.options.limit),
          offset: getOptionalNumber(parsed.options.offset),
        });
        const report = buildExecutionReport(entries);
        printJson(report);
        return;
      }

      case "sync-tasks": {
        const rawProviders = getCsvList(parsed.options.providers);
        const providers = normalizeProviders(rawProviders);
        const result = syncTaskExecutions(store, {
          providers,
          codexPath: getOptionalString(parsed.options["codex-path"]),
          claudePath: getOptionalString(parsed.options["claude-path"]),
          qwenPath: getOptionalString(parsed.options["qwen-path"]),
          gwenPath: getOptionalString(parsed.options["gwen-path"]),
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
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    store.close();
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

function normalizeProviders(rawProviders: string[]): LlmProvider[] {
  if (rawProviders.length === 0) {
    return ["codex", "claude", "qwen", "gwen"];
  }

  const expanded = rawProviders
    .flatMap((value) => value.trim().toLowerCase())
    .flatMap((value) =>
      value === "all" ? ["codex", "claude", "qwen", "gwen"] : [value],
    );
  const allowed = new Set<LlmProvider>(["codex", "claude", "qwen", "gwen"]);
  const deduped = [...new Set(expanded)].filter((value): value is LlmProvider =>
    allowed.has(value as LlmProvider),
  );

  return deduped.length > 0 ? deduped : ["codex", "claude", "qwen", "gwen"];
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
    `  ${APP_NAME} setup [--client codex|claude-code] [--name retentia] [--data-file <path>]`,
    `  ${APP_NAME} install [--client codex|claude-code] [--name retentia] [--data-file <path>] [--dry-run]`,
    `  ${APP_NAME} mcp [--data-file <path>]`,
    `  ${APP_NAME} init [--data-file <path>]`,
    `  ${APP_NAME} migrate [--from-data-file <old-retentia.db>] [--data-file <new-retentia-v2.db>]`,
    `  ${APP_NAME} event --type <type> --source <codex|claude-code> [--summary <text>]`,
    `  ${APP_NAME} memory --kind <kind> --title <text> --body <text> [--tags <a,b>]`,
    `  ${APP_NAME} evidence --source-type <type> --source-id <id> --content <text> [--uri <path>]`,
    `  ${APP_NAME} evidence-search [--query <text>] [--source-type <type>] [--source-id <id>]`,
    `  ${APP_NAME} search [--query <text>] [--project <name>] [--kind <kind>]`,
    `  ${APP_NAME} context [--query <text>] [--mode ids|brief|task-primer|full-evidence] [--max-chars <n>]`,
    `  ${APP_NAME} edge --from-type <type> --from-id <id> --to-type <type> --to-id <id> --relation <name>`,
    `  ${APP_NAME} graph --node-type <type> --node-id <id>`,
    `  ${APP_NAME} dashboard [--limit <n>]`,
    `  ${APP_NAME} doctor [--data-file <path>]`,
    "",
    "Global options:",
    "  --data-file <path>   Override v2 SQLite DB path (default: ~/.retentia/retentia-v2.db)",
    `  --name <mcp-name>    MCP server name used by install/setup (default: ${DEFAULT_MCP_SERVER_NAME})`,
    "",
    "Legacy v1 commands are only available under `retentia legacy <command>` for emergency inspection. Use `retentia migrate` to move old data into v2.",
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
