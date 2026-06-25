import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { V2MemoryEngine } from "./v2-engine.js";
import type { V2EventInput } from "./v2-types.js";

export type V2IngestProvider = "copilot" | "codex" | "claude-code";

export interface V2TaskIngestOptions {
  providers?: string[];
  copilotPath?: string;
  codexPath?: string;
  claudePath?: string;
  lookbackDays?: number;
  maxFilesPerProvider?: number;
  maxImport?: number;
  fallbackProject?: string;
}

export interface V2TaskIngestProviderResult {
  provider: V2IngestProvider;
  detected: number;
  imported: number;
  skipped: number;
  failed: number;
}

export interface V2TaskIngestResult {
  ok: true;
  providers: V2IngestProvider[];
  detectedEvents: number;
  importedEvents: number;
  skippedEvents: number;
  failedEvents: number;
  newestEventAt?: string;
  byProvider: V2TaskIngestProviderResult[];
}

interface ProviderCounters {
  detected: number;
  imported: number;
  skipped: number;
  failed: number;
}

interface CandidateEvent {
  provider: V2IngestProvider;
  externalKey: string;
  timestamp: string;
  input: V2EventInput;
}

interface ClaudeTaskPending {
  sessionId?: string;
  cwd?: string;
  model?: string;
  timestamp?: string;
  description?: string;
  subagentType?: string;
  prompt?: string;
  toolUseId: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_MAX_FILES_PER_PROVIDER = 80;
const DEFAULT_MAX_IMPORT = 300;
const DEFAULT_CODEX_PATH = join(homedir(), ".codex", "sessions");
const DEFAULT_CLAUDE_PATH = join(homedir(), ".claude", "projects");
const DEFAULT_COPILOT_WORKSPACE_PATHS = [
  join(homedir(), ".config", "Code", "User", "workspaceStorage"),
  join(homedir(), ".config", "Code - Insiders", "User", "workspaceStorage"),
  join(homedir(), ".vscode-server", "data", "User", "workspaceStorage"),
];

export function ingestV2TaskEvents(
  engine: V2MemoryEngine,
  options: V2TaskIngestOptions = {},
): V2TaskIngestResult {
  const providers = normalizeProviders(options.providers);
  const lookbackDays = clampNumber(
    options.lookbackDays,
    DEFAULT_LOOKBACK_DAYS,
    1,
    30,
  );
  const maxFilesPerProvider = clampNumber(
    options.maxFilesPerProvider,
    DEFAULT_MAX_FILES_PER_PROVIDER,
    1,
    500,
  );
  const maxImport = clampNumber(options.maxImport, DEFAULT_MAX_IMPORT, 1, 5000);
  const fallbackProject = options.fallbackProject?.trim() || undefined;
  const counters = new Map<V2IngestProvider, ProviderCounters>();
  const candidatesByKey = new Map<string, CandidateEvent>();

  for (const provider of providers) {
    counters.set(provider, { detected: 0, imported: 0, skipped: 0, failed: 0 });
    const events = collectProviderEvents(provider, {
      copilotPath: options.copilotPath,
      codexPath: options.codexPath,
      claudePath: options.claudePath,
      lookbackDays,
      maxFilesPerProvider,
      fallbackProject,
    });
    counters.get(provider)!.detected = events.length;
    for (const event of events) {
      const existing = candidatesByKey.get(event.externalKey);
      if (!existing || event.timestamp > existing.timestamp) {
        candidatesByKey.set(event.externalKey, event);
      }
    }
  }

  const ordered = [...candidatesByKey.values()].sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp),
  );

  let importedEvents = 0;
  let skippedEvents = 0;
  let failedEvents = 0;

  for (const event of ordered) {
    const counter = counters.get(event.provider);
    if (!counter) {
      continue;
    }

    if (importedEvents >= maxImport) {
      skippedEvents += 1;
      counter.skipped += 1;
      continue;
    }

    if (engine.hasImportedEvent(event.externalKey)) {
      skippedEvents += 1;
      counter.skipped += 1;
      continue;
    }

    try {
      const saved = engine.addImportedEvent(event.externalKey, event.input);
      if (saved.imported) {
        importedEvents += 1;
        counter.imported += 1;
      } else {
        skippedEvents += 1;
        counter.skipped += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE constraint failed")) {
        skippedEvents += 1;
        counter.skipped += 1;
        continue;
      }
      failedEvents += 1;
      counter.failed += 1;
    }
  }

  return {
    ok: true,
    providers,
    detectedEvents: ordered.length,
    importedEvents,
    skippedEvents,
    failedEvents,
    newestEventAt: ordered[0]?.timestamp,
    byProvider: providers.map((provider) => ({
      provider,
      detected: counters.get(provider)?.detected ?? 0,
      imported: counters.get(provider)?.imported ?? 0,
      skipped: counters.get(provider)?.skipped ?? 0,
      failed: counters.get(provider)?.failed ?? 0,
    })),
  };
}

function collectProviderEvents(
  provider: V2IngestProvider,
  options: Required<
    Pick<V2TaskIngestOptions, "lookbackDays" | "maxFilesPerProvider">
  > & {
    copilotPath?: string;
    codexPath?: string;
    claudePath?: string;
    fallbackProject?: string;
  },
): CandidateEvent[] {
  const roots = resolveProviderRoots(provider, options);
  const files = listRecentSessionFiles(
    roots,
    provider,
    options.maxFilesPerProvider,
    options.lookbackDays,
  );
  const events: CandidateEvent[] = [];

  for (const filePath of files) {
    if (provider === "copilot") {
      events.push(...parseCopilotEvents(filePath, options.fallbackProject));
    } else if (provider === "codex") {
      events.push(...parseCodexEvents(filePath, options.fallbackProject));
    } else {
      events.push(...parseClaudeEvents(filePath, options.fallbackProject));
    }
  }

  return events;
}

function resolveProviderRoots(
  provider: V2IngestProvider,
  options: {
    copilotPath?: string;
    codexPath?: string;
    claudePath?: string;
  },
): string[] {
  if (provider === "copilot") {
    return options.copilotPath?.trim()
      ? [options.copilotPath.trim()]
      : DEFAULT_COPILOT_WORKSPACE_PATHS;
  }
  if (provider === "codex") {
    return [options.codexPath?.trim() || DEFAULT_CODEX_PATH];
  }
  return [options.claudePath?.trim() || DEFAULT_CLAUDE_PATH];
}

function parseCopilotEvents(
  filePath: string,
  fallbackProject?: string,
): CandidateEvent[] {
  const records = readJsonLines(filePath);
  const events: CandidateEvent[] = [];
  let sessionId = inferSessionIdFromPath(filePath) || "copilot-session";
  let currentTurnId = "";

  for (const root of records) {
    const type = asText(root.type);
    const data = asRecord(root.data);
    const timestamp = asText(root.timestamp);
    if (!type || !timestamp) {
      continue;
    }

    const dataSessionId = asText(data.sessionId);
    if (dataSessionId) {
      sessionId = dataSessionId;
    }

    const recordId =
      asText(root.id) || sha1(`${filePath}:${timestamp}:${type}`);
    const turnId =
      asText(data.turnId) || currentTurnId || asText(root.parentId) || recordId;
    const model = asText(data.model) || asText(root.model);
    const conversationId =
      asText(data.conversationId) ||
      asText(data.conversation_id) ||
      asText(root.conversationId);
    const requestId =
      asText(data.requestId) ||
      asText(data.request_id) ||
      asText(root.requestId);
    const workspaceFolder =
      asText(data.workspaceFolder) ||
      asText(data.workspace_folder) ||
      asText(data.cwd) ||
      asText(root.workspaceFolder);
    const taskId = `copilot:${sessionId}:turn:${turnId}`;
    const project =
      fallbackProject ||
      inferProjectFromRecord(root) ||
      (workspaceFolder ? basename(workspaceFolder) : undefined);
    const tags = [
      "provider:copilot",
      `session:${toTagValue(sessionId)}`,
      `type:${toTagValue(type)}`,
      ...tagIf("model", model),
      ...tagIf("conversation", conversationId),
      ...tagIf("request", requestId),
    ];
    const basePayload = {
      provider: "copilot",
      sessionId,
      transcriptFile: filePath,
      transcriptRecordId: recordId,
      transcriptType: type,
      model,
      conversationId,
      requestId,
      workspaceFolder,
      turnId,
      metadata: {
        provider: "copilot",
        recordId,
        sessionId,
        turnId,
        model,
        conversationId,
        requestId,
        workspaceFolder,
        parentId: asText(root.parentId),
        messageId: asText(data.messageId),
      },
      data,
    };

    if (type === "session.start") {
      events.push({
        provider: "copilot",
        externalKey: `copilot:${sessionId}:${recordId}`,
        timestamp,
        input: {
          type: "observation",
          source: "copilot",
          actor: "copilot",
          role: "agent",
          taskId: `copilot:${sessionId}`,
          project,
          summary: "Copilot session started",
          tags,
          payload: basePayload,
          createdAt: timestamp,
        },
      });
      continue;
    }

    if (type === "assistant.turn_start") {
      currentTurnId = asText(data.turnId) || currentTurnId || recordId;
      events.push({
        provider: "copilot",
        externalKey: `copilot:${sessionId}:${recordId}`,
        timestamp,
        input: {
          type: "task_started",
          source: "copilot",
          actor: "copilot",
          role: "agent",
          taskId,
          project,
          summary: `Copilot turn ${currentTurnId} started`,
          tags,
          payload: {
            ...basePayload,
            taskTitle: `Copilot turn ${currentTurnId}`,
            taskDescription: `Copilot chat turn ${currentTurnId}`,
          },
          createdAt: timestamp,
        },
      });
      continue;
    }

    if (type === "assistant.turn_end") {
      events.push({
        provider: "copilot",
        externalKey: `copilot:${sessionId}:${recordId}`,
        timestamp,
        input: {
          type: "task_completed",
          source: "copilot",
          actor: "copilot",
          role: "agent",
          taskId,
          project,
          summary: `Copilot turn ${turnId} completed`,
          tags,
          payload: basePayload,
          createdAt: timestamp,
        },
      });
      continue;
    }

    if (type === "tool.execution_start" || type === "tool.execution_complete") {
      const toolName = asText(data.toolName) || "tool";
      const toolCallId = asText(data.toolCallId);
      const success = data.success === false ? "failed" : "completed";
      events.push({
        provider: "copilot",
        externalKey: `copilot:${sessionId}:${recordId}`,
        timestamp,
        input: {
          type: "tool_call",
          source: "copilot",
          actor: "copilot",
          role: "agent",
          taskId,
          project,
          summary:
            type === "tool.execution_start"
              ? `Started ${toolName}`
              : `${toolName} ${success}`,
          tags: [
            ...tags,
            `tool:${toTagValue(toolName)}`,
            ...tagIf("tool_call", toolCallId),
          ],
          payload: {
            ...basePayload,
            toolName,
            toolCallId,
            status: type === "tool.execution_start" ? "running" : success,
            metadata: {
              ...basePayload.metadata,
              toolName,
              toolCallId,
              status: type === "tool.execution_start" ? "running" : success,
              success: data.success,
            },
          },
          createdAt: timestamp,
        },
      });
      continue;
    }

    if (type === "assistant.message" || type === "user.message") {
      const content = extractTextFromValue(data.content);
      const reasoningSummary = clip(asText(data.reasoningText) || "", 900);
      const toolRequestMetadata = asArray(data.toolRequests).map((item) => {
        const request = asRecord(item);
        return {
          id: asText(request.id),
          name: asText(request.name),
          status: asText(request.status),
        };
      });
      const toolRequests = toolRequestMetadata
        .map((item) => item.name)
        .filter(Boolean)
        .join(", ");
      const summary =
        clip(
          content || reasoningSummary || toolRequests || `${type} recorded`,
          240,
        ) || `${type} recorded`;
      events.push({
        provider: "copilot",
        externalKey: `copilot:${sessionId}:${recordId}`,
        timestamp,
        input: {
          type: "message",
          source: "copilot",
          actor: type === "user.message" ? "user" : "copilot",
          role: type === "user.message" ? "user" : "agent",
          taskId,
          project,
          summary,
          tags,
          payload: {
            ...basePayload,
            content: clip(content, 5000),
            reasoningSummary,
            toolRequests,
            toolRequestMetadata,
            taskDescription: content ? clip(content, 1200) : undefined,
          },
          createdAt: timestamp,
        },
      });
    }
  }

  return events;
}

function parseCodexEvents(
  filePath: string,
  fallbackProject?: string,
): CandidateEvent[] {
  const events: CandidateEvent[] = [];
  let sessionId = inferSessionIdFromPath(filePath) || "codex-session";
  let sessionMetadata: Record<string, unknown> = {};
  let turnMetadata: Record<string, unknown> = {};

  for (const root of readJsonLines(filePath)) {
    const recordType = asText(root.type);
    if (recordType === "session_meta") {
      const payload = asRecord(root.payload);
      sessionId =
        asText(payload.id) ||
        asText(payload.session_id) ||
        asText(root.session_id) ||
        sessionId;
      sessionMetadata = {
        provider: "codex",
        sessionId,
        model: asText(payload.model) || asText(root.model),
        cwd:
          asText(payload.cwd) ||
          asText(payload.project_path) ||
          asText(root.cwd),
        cliVersion: asText(payload.version) || asText(root.version),
        approvalPolicy:
          asText(payload.approval_policy) || asText(payload.approvalPolicy),
        sandboxMode: asText(payload.sandbox_mode) || asText(payload.sandboxMode),
      };
      continue;
    }

    if (recordType === "turn_context") {
      const payload = asRecord(root.payload);
      turnMetadata = {
        provider: "codex",
        sessionId,
        turnId:
          asText(payload.turn_id) ||
          asText(payload.turnId) ||
          asText(root.turn_id) ||
          asText(root.id),
        cwd:
          asText(payload.cwd) ||
          asText(payload.project_path) ||
          asText(root.cwd),
        model: asText(payload.model) || asText(root.model),
        promptId:
          asText(payload.prompt_id) ||
          asText(payload.promptId) ||
          asText(root.prompt_id),
      };
      continue;
    }

    if (recordType === "response_item") {
      const payload = asRecord(root.payload);
      const itemType =
        asText(payload.type) || asText(root.item_type) || "response_item";
      const timestamp =
        asText(root.timestamp) ||
        asText(payload.timestamp) ||
        asText(root.created_at);
      const turnId =
        asText(payload.turn_id) ||
        asText(payload.turnId) ||
        asText(turnMetadata.turnId) ||
        asText(root.id);
      if (!timestamp || !turnId) {
        continue;
      }

      const toolName =
        asText(payload.name) ||
        asText(payload.tool_name) ||
        asText(payload.toolName);
      const itemId = asText(payload.id) || asText(root.id) || sha1(`${filePath}:${timestamp}:${itemType}`);
      const model =
        asText(payload.model) ||
        asText(root.model) ||
        asText(turnMetadata.model) ||
        asText(sessionMetadata.model);
      const cwd =
        asText(payload.cwd) ||
        asText(turnMetadata.cwd) ||
        asText(sessionMetadata.cwd);
      const project =
        fallbackProject ||
        inferProjectFromRecord(root) ||
        (cwd ? basename(cwd) : undefined);
      const summary =
        extractTextFromValue(payload.arguments) ||
        extractTextFromValue(payload.output) ||
        extractTextFromValue(payload.content) ||
        extractTextFromValue(payload.message) ||
        (toolName ? `Codex called ${toolName}` : `Codex ${itemType}`);
      const normalizedItemType = itemType.toLowerCase();
      const eventType =
        normalizedItemType.includes("tool") ||
        normalizedItemType.includes("function")
          ? "tool_call"
          : "message";
      const taskId = `codex:${sessionId}:turn:${turnId}`;
      const tags = [
        "provider:codex",
        `session:${toTagValue(sessionId)}`,
        `type:${toTagValue(itemType)}`,
        ...tagIf("model", model),
        ...tagIf("tool", toolName),
      ];

      events.push({
        provider: "codex",
        externalKey: `codex:${sessionId}:${turnId}:response:${itemId}`,
        timestamp,
        input: {
          type: eventType,
          source: "codex",
          actor: "codex",
          role: "agent",
          taskId,
          project,
          summary: clip(summary, 240),
          tags,
          payload: {
            provider: "codex",
            sessionId,
            sessionFile: filePath,
            turnId,
            itemId,
            itemType,
            model,
            cwd,
            toolName,
            content: clip(summary, 5000),
            taskDescription: clip(summary, 1200),
            metadata: {
              provider: "codex",
              sessionId,
              turnId,
              itemId,
              itemType,
              model,
              cwd,
              toolName,
              session: sessionMetadata,
              turn: turnMetadata,
            },
            payload,
          },
          createdAt: timestamp,
        },
      });
      continue;
    }

    if (recordType !== "event_msg") {
      continue;
    }

    const payload = asRecord(root.payload);
    const payloadType = asText(payload.type);
    const timestamp = asText(root.timestamp) || asText(payload.timestamp);
    const turnId =
      asText(payload.turn_id) || asText(payload.turnId) || asText(root.id);
    if (!payloadType || !timestamp || !turnId) {
      continue;
    }

    const normalizedType = payloadType.toLowerCase();
    if (!normalizedType.includes("task") && !normalizedType.includes("turn")) {
      continue;
    }

    const summary =
      asText(payload.last_agent_message) ||
      extractTextFromValue(payload.message) ||
      extractTextFromValue(payload.error) ||
      `Codex ${payloadType}`;
    const eventType =
      normalizedType.includes("fail") || normalizedType.includes("error")
        ? "task_failed"
        : normalizedType.includes("complete") || normalizedType.includes("end")
          ? "task_completed"
          : "task_started";
    const taskId = `codex:${sessionId}:turn:${turnId}`;
    const model =
      asText(payload.model) ||
      asText(root.model) ||
      asText(turnMetadata.model) ||
      asText(sessionMetadata.model);
    const cwd =
      asText(payload.cwd) ||
      asText(turnMetadata.cwd) ||
      asText(sessionMetadata.cwd);
    const project =
      fallbackProject ||
      inferProjectFromRecord(root) ||
      (cwd ? basename(cwd) : undefined);

    events.push({
      provider: "codex",
      externalKey: `codex:${sessionId}:${turnId}:${payloadType}`,
      timestamp,
      input: {
        type: eventType,
        source: "codex",
        actor: "codex",
        role: "agent",
        taskId,
        project,
        summary: clip(summary, 240),
        tags: [
          "provider:codex",
          `session:${toTagValue(sessionId)}`,
          `type:${toTagValue(payloadType)}`,
          ...tagIf("model", model),
        ],
        payload: {
          provider: "codex",
          sessionId,
          sessionFile: filePath,
          turnId,
          model,
          cwd,
          payload,
          taskDescription: clip(summary, 1200),
          reasoningSummary: clip(
            asText(payload.reasoning) ||
              asText(payload.reasoning_summary) ||
              "",
            900,
          ),
          metadata: {
            provider: "codex",
            sessionId,
            turnId,
            eventType: payloadType,
            model,
            cwd,
            session: sessionMetadata,
            turn: turnMetadata,
          },
        },
        createdAt: timestamp,
      },
    });
  }

  return events;
}

function parseClaudeEvents(
  filePath: string,
  fallbackProject?: string,
): CandidateEvent[] {
  const events: CandidateEvent[] = [];
  const pendingByToolUseId = new Map<string, ClaudeTaskPending>();

  for (const root of readJsonLines(filePath)) {
    const recordType = asText(root.type)?.toLowerCase();
    const timestamp = asText(root.timestamp);
    const sessionId =
      asText(root.sessionId) ||
      inferSessionIdFromPath(filePath) ||
      "claude-session";
    const cwd = asText(root.cwd);
    const uuid = asText(root.uuid);
    const parentUuid = asText(root.parentUuid);
    const version = asText(root.version);
    const permissionMode = asText(root.permissionMode);
    const message = asRecord(root.message);
    const model = asText(message.model);
    const messageId = asText(message.id);
    const usage = asRecord(message.usage);
    const stopReason = asText(message.stop_reason);
    const content = asArray(message.content);
    const recordMetadata = {
      provider: "claude-code",
      sessionId,
      cwd,
      uuid,
      parentUuid,
      version,
      permissionMode,
      messageId,
      model,
      usage,
      stopReason,
    };

    if (recordType === "assistant") {
      for (const item of content) {
        const toolUse = asRecord(item);
        if (
          asText(toolUse.type) !== "tool_use" ||
          asText(toolUse.name) !== "Task"
        ) {
          continue;
        }

        const input = asRecord(toolUse.input);
        const toolUseId = asText(toolUse.id);
        if (!toolUseId) {
          continue;
        }

        const description = asText(input.description);
        const prompt = asText(input.prompt);
        const subagentType = asText(input.subagent_type);
        pendingByToolUseId.set(toolUseId, {
          sessionId,
          cwd,
          model,
          timestamp,
          description,
          prompt,
          subagentType,
          toolUseId,
          metadata: {
            ...recordMetadata,
            toolName: "Task",
            toolUseId,
            taskDescription: description,
            subagentType,
            promptLength: (prompt || "").length,
          },
        });

        if (timestamp) {
          events.push({
            provider: "claude-code",
            externalKey: `claude-code:${sessionId}:${toolUseId}:start`,
            timestamp,
            input: {
              type: "task_started",
              source: "claude-code",
              actor: normalizeAgentLabel(subagentType) || "claude-code",
              role: subagentType ? "subagent" : "agent",
              taskId: `claude-code:${sessionId}:task:${toolUseId}`,
              project: fallbackProject || (cwd ? basename(cwd) : undefined),
              summary: clip(
                description || prompt || `Claude Code task ${toolUseId}`,
                240,
              ),
              tags: [
                "provider:claude-code",
                `session:${toTagValue(sessionId)}`,
                "tool:task",
                ...tagIf("model", model),
                subagentType
                  ? `agent:${toTagValue(subagentType)}`
                  : "agent:claude-code",
              ],
              payload: {
                provider: "claude-code",
                sessionId,
                sessionFile: filePath,
                toolUseId,
                model,
                cwd,
                taskTitle: description || `Claude Code task ${toolUseId}`,
                taskDescription: prompt || description,
                subagentType,
                metadata: pendingByToolUseId.get(toolUseId)?.metadata,
              },
              createdAt: timestamp,
            },
          });
        }
      }
      continue;
    }

    if (recordType !== "user") {
      continue;
    }

    for (const item of content) {
      const toolResult = asRecord(item);
      if (asText(toolResult.type) !== "tool_result") {
        continue;
      }

      const toolUseId = asText(toolResult.tool_use_id);
      if (!toolUseId) {
        continue;
      }

      const pending = pendingByToolUseId.get(toolUseId);
      const taskTimestamp = timestamp || pending?.timestamp;
      if (!taskTimestamp) {
        continue;
      }

      const resultText =
        extractTextFromValue(toolResult.content) ||
        extractTextFromValue(root.toolUseResult) ||
        "";
      const isError = toolResult.is_error === true;
      const effectiveSessionId = pending?.sessionId || sessionId;
      const projectPath = pending?.cwd || cwd;
      const subagentType = pending?.subagentType;

      events.push({
        provider: "claude-code",
        externalKey: `claude-code:${effectiveSessionId}:${toolUseId}:result`,
        timestamp: taskTimestamp,
        input: {
          type: isError ? "task_failed" : "task_completed",
          source: "claude-code",
          actor: normalizeAgentLabel(subagentType) || "claude-code",
          role: subagentType ? "subagent" : "agent",
          taskId: `claude-code:${effectiveSessionId}:task:${toolUseId}`,
          project:
            fallbackProject ||
            (projectPath ? basename(projectPath) : undefined),
          summary: clip(
            resultText ||
              pending?.description ||
              `Claude Code task ${toolUseId} completed`,
            240,
          ),
          tags: [
            "provider:claude-code",
            `session:${toTagValue(effectiveSessionId)}`,
            isError ? "status:failed" : "status:completed",
            "tool:task",
            ...tagIf("model", pending?.model || model),
            subagentType
              ? `agent:${toTagValue(subagentType)}`
              : "agent:claude-code",
          ],
          payload: {
            provider: "claude-code",
            sessionId: effectiveSessionId,
            sessionFile: filePath,
            toolUseId,
            model: pending?.model || model,
            cwd: projectPath,
            result: clip(resultText, 5000),
            taskTitle: pending?.description || `Claude Code task ${toolUseId}`,
            taskDescription: pending?.prompt || pending?.description,
            subagentType,
            isError,
            metadata: {
              ...(pending?.metadata || {}),
              resultRecord: recordMetadata,
              isError,
              resultContentType: Array.isArray(toolResult.content)
                ? "array"
                : typeof toolResult.content,
            },
          },
          createdAt: taskTimestamp,
        },
      });
    }
  }

  return events;
}

function listRecentSessionFiles(
  roots: string[],
  provider: V2IngestProvider,
  maxFiles: number,
  lookbackDays: number,
): string[] {
  const cutoffMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const files: Array<{ path: string; mtimeMs: number }> = [];

  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    collectFiles(root, provider, cutoffMs, files);
  }

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles)
    .map((item) => item.path);
}

function collectFiles(
  root: string,
  provider: V2IngestProvider,
  cutoffMs: number,
  files: Array<{ path: string; mtimeMs: number }>,
): void {
  const pending = [root];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      break;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isProviderSessionFile(absolutePath, provider)) {
        continue;
      }

      try {
        const stats = statSync(absolutePath);
        if (stats.mtimeMs >= cutoffMs) {
          files.push({ path: absolutePath, mtimeMs: stats.mtimeMs });
        }
      } catch {
        continue;
      }
    }
  }
}

function isProviderSessionFile(
  filePath: string,
  provider: V2IngestProvider,
): boolean {
  if (!/\.(jsonl|ndjson|log)$/i.test(filePath)) {
    return false;
  }
  if (provider !== "copilot") {
    return true;
  }
  return (
    filePath.includes("GitHub.copilot-chat") && filePath.includes("transcripts")
  );
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const records: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return records;
}

function inferSessionIdFromPath(filePath: string): string | undefined {
  const fileName = basename(filePath);
  const match = fileName.match(/^(.*)\.(jsonl|ndjson|log)$/i);
  return match?.[1];
}

function inferProjectFromRecord(
  root: Record<string, unknown>,
): string | undefined {
  const cwd =
    asText(root.cwd) ||
    asText(root.project_path) ||
    asText(root.workspaceFolder) ||
    asText(asRecord(root.data).cwd) ||
    asText(asRecord(root.payload).cwd);
  return cwd ? basename(cwd) : undefined;
}

function extractTextFromValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map(extractTextFromValue).filter(Boolean).join("\n").trim();
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text.trim();
    }
    if (typeof record.content === "string") {
      return record.content.trim();
    }
    if (Array.isArray(record.content)) {
      return extractTextFromValue(record.content);
    }
    if (typeof record.message === "string") {
      return record.message.trim();
    }
  }

  return "";
}

function normalizeProviders(providers?: string[]): V2IngestProvider[] {
  const normalized = (providers && providers.length > 0 ? providers : ["all"])
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean)
    .map((provider) => {
      if (provider === "copilot-chat" || provider === "github-copilot") {
        return "copilot";
      }
      if (provider === "claude" || provider === "claude_code") {
        return "claude-code";
      }
      return provider;
    });

  if (normalized.includes("all")) {
    return ["copilot", "codex", "claude-code"];
  }

  const allowed = new Set<V2IngestProvider>([
    "copilot",
    "codex",
    "claude-code",
  ]);
  const deduped = [...new Set(normalized)].filter(
    (provider): provider is V2IngestProvider =>
      allowed.has(provider as V2IngestProvider),
  );
  return deduped.length > 0 ? deduped : ["copilot", "codex", "claude-code"];
}

function normalizeAgentLabel(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function toTagValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function tagIf(key: string, value?: string): string[] {
  const tagValue = value ? toTagValue(value) : "";
  return tagValue ? [`${key}:${tagValue}`] : [];
}

function clip(value: string, maxChars: number): string {
  if (!value) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clampNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}
