#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_DIR = process.env.RETENTIA_HOOK_STATE_DIR || join(homedir(), ".retentia", "hooks", "state");
const ACTIVE_TURN_DIR = join(STATE_DIR, "active-turns");
const RETENTIA_READ_MARKERS = [
  "memory_search",
  "memory_context",
  "dashboard_snapshot",
];
const RETENTIA_WRITE_MARKERS = ["memory_add", "agent_event"];
const TOOL_DISCOVERY_MARKERS = ["tool_search", "tools_search"];
const RETENTIA_POLICY_MESSAGE =
  "Retentia is the mandatory local working memory for technical tasks. Before using technical tools, inspect Retentia with memory_search, memory_context, or dashboard_snapshot. If Retentia tools are not initially visible, inspect ALL_TOOLS for mcp__retentia__ tools or use tool_search; then call mcp__retentia__health_check. A health check alone does not replace memory inspection. During execution, keep durable findings, blockers, decisions, and progress in Retentia. Before finishing the task, write a completion log to Retentia with agent_event or memory_add. If Retentia remains unavailable, stop and report that blocker explicitly. Exception: when the task is specifically to diagnose, repair, or restore Retentia itself, Retentia may be skipped if unavailable; proceed with local config, transport, and connectivity checks and document the bypass.";

function readPayload() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function output(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function cleanToken(value, fallback) {
  const raw = String(value || fallback || "unknown").trim() || fallback || "unknown";
  const cleaned = raw.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96);
  return cleaned || fallback || "unknown";
}

function sessionKey(payload) {
  const raw =
    payload.session_id ||
    payload.sessionId ||
    payload.transcript_path ||
    payload.cwd ||
    "unknown-session";
  return cleanToken(raw, "unknown-session") + "-" + hash(raw);
}

function incomingTurnId(payload) {
  return (
    payload.turn_id ||
    payload.turnId ||
    payload.request_id ||
    payload.requestId ||
    payload.message_id ||
    payload.messageId ||
    ""
  );
}

function activeTurnPath(session) {
  return join(ACTIVE_TURN_DIR, session + ".json");
}

function readJsonFile(path, fallback) {
  try {
    if (!existsSync(path)) {
      return fallback;
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = path + ".tmp";
  writeFileSync(tempPath, JSON.stringify(value));
  renameSync(tempPath, path);
}

function startTurn(payload) {
  const session = sessionKey(payload);
  const rawTurn =
    incomingTurnId(payload) ||
    Date.now() + "-" + hash(payload.prompt || JSON.stringify(payload));
  const turn = cleanToken(rawTurn, "unknown-turn");
  writeJsonFile(activeTurnPath(session), { turn });
  return { session, turn };
}

function resolveTurn(payload) {
  const session = sessionKey(payload);
  const directTurn = incomingTurnId(payload);
  if (directTurn) {
    return { session, turn: cleanToken(directTurn, "unknown-turn") };
  }

  const active = readJsonFile(activeTurnPath(session), {});
  return {
    session,
    turn: cleanToken(active.turn || "unknown-turn", "unknown-turn"),
  };
}

function statePath(payload) {
  const { session, turn } = resolveTurn(payload);
  return turnStatePath(session, turn);
}

function turnStatePath(session, turn) {
  return join(STATE_DIR, session + "__" + turn + ".json");
}

function defaultState() {
  return {
    retentiaInspected: false,
    retentiaUpdated: false,
    pendingUpdate: false,
    substantiveToolUsed: false,
    retentiaRepairTask: false,
    availabilityChecked: false,
  };
}

function loadState(path) {
  return { ...defaultState(), ...readJsonFile(path, defaultState()) };
}

function saveState(path, state) {
  writeJsonFile(path, state);
}

function textFromPayload(payload) {
  const direct = [
    payload.prompt,
    payload.message,
    payload.input,
    payload.text,
    payload.user_prompt,
    payload.userPrompt,
  ]
    .filter((value) => typeof value === "string")
    .join(" ");

  if (direct.trim()) {
    return direct;
  }

  try {
    return JSON.stringify(payload).slice(0, 8000);
  } catch {
    return "";
  }
}

function isRetentiaRepairTask(payload) {
  // The repair action must target Retentia itself, not a nearby config task.
  const text = textFromPayload(payload).toLowerCase();
  return /^(?:(?:per favore|please|puoi|can you|help me|aiutami a)\s+)*(?:diagnos\w*|ripar\w*|ripristin\w*|repair|restore|fix|debug|troubleshoot)\s+(?:(?:il|la|the|server|servizio|connessione|connection|configurazione|configuration|di|a)\s+){0,3}retentia\b/.test(text)
    || /^retentia\s+(?:stess[ao]|itself|non\s+(?:funziona|risponde)|(?:is\s+)?(?:broken|unavailable|unreachable))\b/.test(text);
}

function discoveryInput(payload) {
  const name = String(payload.tool_name || payload.toolName || '');
  const input = payload.tool_input ?? payload.toolInput;
  if (!/(?:^|\.)exec$/.test(name)) return false;
  const source = typeof input === 'string' ? input : input?.source;
  // Discovery only: no invocation of a nested tool or arbitrary statements.
  return typeof source === 'string'
    && /ALL_TOOLS/.test(source) && /retentia/.test(source)
    && !/\btools\s*(?:\.|\[)|\b(?:eval|Function|import|fetch)\b|await/.test(source);
}

function successfulResult(payload) {
  let result = payload.tool_response ?? payload.toolResponse;
  if (result === undefined || result === null) return false;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { return false; } }
  if (result.isError === true || result.error || result.ok === false) return false;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type !== 'text') continue;
      try { const value = JSON.parse(block.text); if (value?.ok === false || value?.isError || value?.error) return false; } catch {}
    }
  }
  return true;
}

function cleanupState(payload, path) {
  try {
    unlinkSync(path);
  } catch {}

  const { session, turn } = resolveTurn(payload);
  const activePath = activeTurnPath(session);
  const active = readJsonFile(activePath, {});
  if (active.turn === turn) {
    try {
      unlinkSync(activePath);
    } catch {}
  }
}

function isRetentiaTool(toolName) {
  const normalized = String(toolName || "").toLowerCase();
  return (
    normalized.startsWith("mcp__retentia__") ||
    normalized.includes("retentia")
  );
}

function isRetentiaRead(toolName) {
  const normalized = String(toolName || "").toLowerCase();
  return (
    isRetentiaTool(normalized) &&
    RETENTIA_READ_MARKERS.some((marker) => normalized.includes(marker))
  );
}

function isRetentiaWrite(toolName) {
  const normalized = String(toolName || "").toLowerCase();
  return (
    isRetentiaTool(normalized) &&
    RETENTIA_WRITE_MARKERS.some((marker) => normalized.includes(marker))
  );
}

function isToolDiscoveryTool(toolName) {
  const normalized = String(toolName || "").toLowerCase();
  return TOOL_DISCOVERY_MARKERS.some((marker) => normalized.includes(marker));
}

function isSubstantiveTool(toolName) {
  return (
    Boolean(toolName) &&
    !isRetentiaTool(toolName) &&
    !isToolDiscoveryTool(toolName)
  );
}

function userPromptSubmit(payload) {
  const { session, turn } = startTurn(payload);
  const path = turnStatePath(session, turn);
  const state = loadState(path);
  state.retentiaRepairTask = isRetentiaRepairTask(payload);
  saveState(path, state);

  output({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: RETENTIA_POLICY_MESSAGE,
    },
  });
}

function preToolUse(payload) {
  const toolName = payload.tool_name || payload.toolName || "";
  if (
    isRetentiaTool(toolName) ||
    isToolDiscoveryTool(toolName) ||
    !isSubstantiveTool(toolName) || discoveryInput(payload)
  ) {
    return;
  }

  const path = statePath(payload);
  const state = loadState(path);
  if (state.retentiaRepairTask) {
    return;
  }

  if (state.retentiaInspected) {
    return;
  }

  output({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Start technical tasks by inspecting Retentia first. Use memory_search, memory_context, or dashboard_snapshot before other technical tools. If Retentia is unavailable, stop and report that blocker explicitly.",
    },
  });
}

function postToolUse(payload) {
  const toolName = payload.tool_name || payload.toolName || "";
  const path = statePath(payload);
  const state = loadState(path);

  if (discoveryInput(payload) || isToolDiscoveryTool(toolName) || (isRetentiaTool(toolName) && /health_check/.test(toolName))) {
    state.availabilityChecked = true;
  }
  if (isSubstantiveTool(toolName) && !discoveryInput(payload)) {
    state.substantiveToolUsed = true;
  }
  if (isSubstantiveTool(toolName) && !isRetentiaTool(toolName) && !discoveryInput(payload)) {
    state.pendingUpdate = true;
  }
  if (isRetentiaRead(toolName) && successfulResult(payload)) {
    state.retentiaInspected = true;
  }
  if (isRetentiaWrite(toolName) && successfulResult(payload)) {
    state.retentiaUpdated = true;
    state.pendingUpdate = false;
  }

  saveState(path, state);
}

function stop(payload) {
  const path = statePath(payload);
  const state = loadState(path);

  if (state.retentiaRepairTask) {
    cleanupState(payload, path);
    return;
  }

  const finalText = payload.last_assistant_message || payload.final_response || '';
  const claimsUnavailable = /^(?:retentia\s+(?:non\s+(?:e[’']?|è)\s+disponibile|(?:is\s+)?unavailable)|non\s+(?:e[’']?|è)\s+disponibile\s+retentia)/im.test(finalText.trim());
  if (claimsUnavailable && !state.availabilityChecked && !state.retentiaInspected) {
    output({ continue: false, stopReason: "Disponibilità di Retentia da confermare." });
    return;
  }
  if (!state.substantiveToolUsed) {
    cleanupState(payload, path);
    return;
  }

  if (state.retentiaInspected && !state.pendingUpdate) {
    cleanupState(payload, path);
    return;
  }

  output({ continue: false, stopReason: "Registro Retentia incompleto per questo turno." });
}

const command = process.argv[2] || "";
const payload = readPayload();

if (command === "user-prompt-submit") {
  userPromptSubmit(payload);
} else if (command === "pre-tool-use") {
  preToolUse(payload);
} else if (command === "post-tool-use") {
  postToolUse(payload);
} else if (command === "stop") {
  stop(payload);
}
