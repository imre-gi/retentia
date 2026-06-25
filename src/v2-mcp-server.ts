import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { getV2DataFilePath } from "./v2-config.js";
import { V2MemoryEngine } from "./v2-engine.js";
import type { V2ContextMode, V2MemoryKind } from "./v2-types.js";

const MCP_SERVER_NAME = "retentia";
const MEMORY_KINDS: V2MemoryKind[] = [
  "episode",
  "fact",
  "decision",
  "preference",
  "procedure",
  "constraint",
  "artifact",
  "todo",
];
const CONTEXT_MODES: V2ContextMode[] = [
  "ids",
  "brief",
  "task-primer",
  "full-evidence",
];

export interface StartV2McpServerOptions {
  dataFile?: string;
}

export async function startV2McpServer(
  options: StartV2McpServerOptions = {},
): Promise<void> {
  const engine = new V2MemoryEngine(getV2DataFilePath(options.dataFile));
  const server = new Server(
    {
      name: MCP_SERVER_NAME,
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "agent_event",
        description:
          "Record a live v2 event from an agent, subagent, task, tool call, or outcome. Put visible reasoning summaries in payload.reasoningSummary or payload.rationale.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string" },
            source: { type: "string" },
            actor: { type: "string" },
            role: { type: "string" },
            taskId: { type: "string" },
            parentTaskId: { type: "string" },
            project: { type: "string" },
            summary: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            artifacts: { type: "array", items: { type: "string" } },
            payload: { type: "object" },
          },
          required: ["type", "source"],
        },
      },
      {
        name: "memory_add",
        description:
          "Add a compact durable memory: fact, decision, preference, procedure, episode, constraint, artifact, or todo.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: MEMORY_KINDS },
            title: { type: "string" },
            body: { type: "string" },
            project: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            sourceEventIds: { type: "array", items: { type: "number" } },
            confidence: { type: "number" },
            pinned: { type: "boolean" },
          },
          required: ["kind", "title", "body"],
        },
      },
      {
        name: "memory_search",
        description:
          "Search compact memories with FTS, metadata filters, and low-token snippets.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            project: { type: "string" },
            kind: { type: "string", enum: MEMORY_KINDS },
            tags: { type: "array", items: { type: "string" } },
            limit: { type: "number" },
          },
        },
      },
      {
        name: "memory_context",
        description:
          "Build a hard-budgeted context pack. Use brief or ids by default; full-evidence is opt-in.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            project: { type: "string" },
            kind: { type: "string", enum: MEMORY_KINDS },
            tags: { type: "array", items: { type: "string" } },
            limit: { type: "number" },
            mode: { type: "string", enum: CONTEXT_MODES },
            maxChars: { type: "number" },
          },
        },
      },
      {
        name: "graph_edge",
        description:
          "Record a relationship between agents, subagents, tasks, artifacts, memories, or decisions.",
        inputSchema: {
          type: "object",
          properties: {
            fromType: { type: "string" },
            fromId: { type: "string" },
            toType: { type: "string" },
            toId: { type: "string" },
            relation: { type: "string" },
            weight: { type: "number" },
            metadata: { type: "object" },
          },
          required: ["fromType", "fromId", "toType", "toId", "relation"],
        },
      },
      {
        name: "graph_neighborhood",
        description:
          "List graph edges around a node, such as an agent, task, artifact, or memory.",
        inputSchema: {
          type: "object",
          properties: {
            nodeType: { type: "string" },
            nodeId: { type: "string" },
            limit: { type: "number" },
          },
          required: ["nodeType", "nodeId"],
        },
      },
      {
        name: "dashboard_snapshot",
        description:
          "Return the live Retentia v2 dashboard snapshot: agents, tasks, subtasks, activities, memories, graph edges, and context preview.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number" },
          },
        },
      },
      {
        name: "health_check",
        description:
          "Run a non-destructive Retentia v2 health check over the SQLite store, schema, FTS index, and writeability.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return handleToolCall(request, engine);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function handleToolCall(
  request: CallToolRequest,
  engine: V2MemoryEngine,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    const toolName = request.params.name;
    const args = toRecord(request.params.arguments);

    switch (toolName) {
      case "agent_event":
        return textResult(
          engine.addEvent({
            type: getString(args, "type", true),
            source: getString(args, "source", true),
            actor: getString(args, "actor", false) || undefined,
            role: getString(args, "role", false) || undefined,
            taskId: getString(args, "taskId", false) || undefined,
            parentTaskId: getString(args, "parentTaskId", false) || undefined,
            project: getString(args, "project", false) || undefined,
            summary: getString(args, "summary", false) || undefined,
            tags: getStringArray(args, "tags"),
            artifacts: getStringArray(args, "artifacts"),
            payload: args.payload,
          }),
        );

      case "memory_add":
        return textResult(
          engine.addMemory({
            kind: getMemoryKind(args),
            title: getString(args, "title", true),
            body: getString(args, "body", true),
            project: getString(args, "project", false) || undefined,
            tags: getStringArray(args, "tags"),
            sourceEventIds: getNumberArray(args, "sourceEventIds"),
            confidence: getNumber(args, "confidence"),
            pinned: getBoolean(args, "pinned"),
          }),
        );

      case "memory_search":
        return textResult(
          engine.search({
            query: getString(args, "query", false) || undefined,
            project: getString(args, "project", false) || undefined,
            kind: getOptionalMemoryKind(args),
            tags: getStringArray(args, "tags"),
            limit: getNumber(args, "limit"),
          }),
        );

      case "memory_context": {
        const context = engine.buildContext({
          query: getString(args, "query", false) || undefined,
          project: getString(args, "project", false) || undefined,
          kind: getOptionalMemoryKind(args),
          tags: getStringArray(args, "tags"),
          limit: getNumber(args, "limit"),
          mode: getOptionalContextMode(args),
          maxChars: getNumber(args, "maxChars"),
        });
        return {
          content: [{ type: "text", text: context.text }],
        };
      }

      case "graph_edge":
        return textResult(
          engine.addEdge({
            fromType: getString(args, "fromType", true),
            fromId: getString(args, "fromId", true),
            toType: getString(args, "toType", true),
            toId: getString(args, "toId", true),
            relation: getString(args, "relation", true),
            weight: getNumber(args, "weight"),
            metadata: args.metadata,
          }),
        );

      case "graph_neighborhood":
        return textResult(
          engine.listEdgesForNode(
            getString(args, "nodeType", true),
            getString(args, "nodeId", true),
            getNumber(args, "limit"),
          ),
        );

      case "dashboard_snapshot":
        return textResult(engine.buildDashboard(getNumber(args, "limit")));

      case "health_check":
        return textResult(engine.buildHealthReport());

      default:
        return errorResult(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function textResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    isError: true,
    content: [{ type: "text", text: `${MCP_SERVER_NAME} error: ${message}` }],
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function getString(
  args: Record<string, unknown>,
  key: string,
  required: boolean,
): string {
  const value = args[key];
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized && required) {
      throw new Error(`${key} is required.`);
    }
    return normalized;
  }
  if (required) {
    throw new Error(`${key} is required.`);
  }
  return "";
}

function getStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function getNumberArray(args: Record<string, unknown>, key: string): number[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "number" ? item : Number(item)))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function getBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function getMemoryKind(args: Record<string, unknown>): V2MemoryKind {
  const raw = getString(args, "kind", true);
  if (!MEMORY_KINDS.includes(raw as V2MemoryKind)) {
    throw new Error(`kind must be one of: ${MEMORY_KINDS.join(", ")}`);
  }
  return raw as V2MemoryKind;
}

function getOptionalMemoryKind(
  args: Record<string, unknown>,
): V2MemoryKind | undefined {
  const raw = getString(args, "kind", false);
  if (!raw) {
    return undefined;
  }
  if (!MEMORY_KINDS.includes(raw as V2MemoryKind)) {
    throw new Error(`kind must be one of: ${MEMORY_KINDS.join(", ")}`);
  }
  return raw as V2MemoryKind;
}

function getOptionalContextMode(
  args: Record<string, unknown>,
): V2ContextMode | undefined {
  const raw = getString(args, "mode", false);
  if (!raw) {
    return undefined;
  }
  if (!CONTEXT_MODES.includes(raw as V2ContextMode)) {
    throw new Error(`mode must be one of: ${CONTEXT_MODES.join(", ")}`);
  }
  return raw as V2ContextMode;
}
