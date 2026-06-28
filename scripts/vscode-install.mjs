#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const VSCODE_EXTENSION_DIR = join(ROOT_DIR, "vscode-extension");
const EXTENSION_PACKAGE_JSON = join(VSCODE_EXTENSION_DIR, "package.json");
const RETENTIA_HOOK_SCRIPT = `#!/usr/bin/env node
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

const STATE_DIR = join(homedir(), ".retentia", "hooks", "state");
const ACTIVE_TURN_DIR = join(STATE_DIR, "active-turns");
const RETENTIA_READ_MARKERS = [
  "memory_search",
  "memory_context",
  "dashboard_snapshot",
];
const RETENTIA_WRITE_MARKERS = ["memory_add", "agent_event"];
const TOOL_DISCOVERY_MARKERS = ["tool_search", "tools_search"];
const RETENTIA_REPAIR_MARKERS = [
  "diagnos",
  "repair",
  "restore",
  "fix",
  "broken",
  "fail",
  "unavailable",
  "connectivity",
  "connection",
  "transport",
  "transporter",
  "config",
  "mcp",
  "fallisce",
  "falliscono",
  "rotto",
  "ripara",
  "ripristina",
  "connettiv",
];
const RETENTIA_POLICY_MESSAGE =
  "Retentia is the mandatory local working memory for technical tasks. Before using technical tools, inspect Retentia with memory_search, memory_context, or dashboard_snapshot. If Retentia tools are not initially visible, first use available tool discovery such as tool_search to expose them. During execution, keep durable findings, blockers, decisions, and progress in Retentia. Before finishing the task, write a completion log to Retentia with agent_event or memory_add. If Retentia remains unavailable, stop and report that blocker explicitly. Exception: when the task is specifically to diagnose, repair, or restore Retentia itself, Retentia may be skipped if unavailable; proceed with local config, transport, and connectivity checks and document the bypass.";

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
  const text = textFromPayload(payload).toLowerCase();
  return (
    text.includes("retentia") &&
    RETENTIA_REPAIR_MARKERS.some((marker) => text.includes(marker))
  );
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
    !isSubstantiveTool(toolName)
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

  if (isSubstantiveTool(toolName)) {
    state.substantiveToolUsed = true;
  }
  if (isSubstantiveTool(toolName) && !isRetentiaTool(toolName)) {
    state.pendingUpdate = true;
  }
  if (isRetentiaRead(toolName)) {
    state.retentiaInspected = true;
  }
  if (isRetentiaWrite(toolName)) {
    state.retentiaUpdated = true;
    state.pendingUpdate = false;
  }

  saveState(path, state);
}

function stop(payload) {
  const path = statePath(payload);
  const state = loadState(path);

  if (payload.stop_hook_active || payload.stopHookActive) {
    cleanupState(payload, path);
    return;
  }

  if (state.retentiaRepairTask) {
    cleanupState(payload, path);
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

  const reason = !state.retentiaInspected
    ? "This technical task must start from Retentia. Inspect Retentia first, then continue. If Retentia is unavailable, stop and report that blocker explicitly."
    : "Before completing this task, write the current task log to Retentia with agent_event or memory_add, including completed progress, decisions, blockers, and validation status. If Retentia is unavailable, stop and report that blocker explicitly.";

  output({ decision: "block", reason });
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
`;
let codeCliResolutionHint = "";

const mode = (process.argv[2] || "install").trim().toLowerCase();
if (mode !== "install" && mode !== "reinstall") {
  fail(`Unknown mode '${mode}'. Use 'install' or 'reinstall'.`);
}

try {
  if (mode === "reinstall") {
    log("Reinstall mode: resetting extension and MCP config");
    resetEnvironment();
  }

  installFlow();
  log("Install complete");
  log(
    "If VS Code commands do not appear immediately, run 'Developer: Reload Window' in VS Code.",
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
}

function installFlow() {
  log("Installing root dependencies");
  runNpm(["install"], ROOT_DIR);

  log("Rebuilding native dependencies for current Node runtime");
  runNpm(["rebuild", "better-sqlite3"], ROOT_DIR);

  log("Building Retentia CLI");
  runNpm(["run", "build"], ROOT_DIR);

  log("Installing Retentia MCP for Codex when available");
  run(
    process.execPath,
    [join(ROOT_DIR, "dist", "cli.js"), "install", "--client", "codex"],
    ROOT_DIR,
    true,
  );

  log("Writing Claude Code MCP config reference");
  writeClaudeCodeConfigReference();

  log("Installing Retentia MCP for VS Code when available");
  writeVsCodeMcpConfigs();

  log("Installing Retentia-first hooks for Codex and Claude Code");
  installRetentiaHooks();

  const codeCli = resolveCodeCli();
  if (!codeCli) {
    log(
      "VS Code CLI not found; core Retentia is installed and MCP config is ready.",
    );
    log(
      codeCliResolutionHint ||
        "Run this installer from inside VS Code, or set RETENTIA_VSCODE_CLI, to install the extension too.",
    );
    return;
  }

  log("Installing VS Code extension dependencies");
  runNpm(["install"], VSCODE_EXTENSION_DIR);

  log("Packaging VS Code extension");
  runNpm(["run", "package"], VSCODE_EXTENSION_DIR);

  const vsixFile = resolveVsixPath();
  if (!existsSync(vsixFile)) {
    throw new Error(`VSIX file not found: ${vsixFile}`);
  }

  log(`Using VS Code CLI: ${codeCli}`);
  uninstallKnownExtensions(codeCli);
  installExtensionEverywhere(codeCli, vsixFile);
  log("VS Code extension installed");
}

function writeClaudeCodeConfigReference() {
  const result = run(
    process.execPath,
    [join(ROOT_DIR, "dist", "cli.js"), "mcp-config", "--client", "claude-code"],
    ROOT_DIR,
    true,
  );
  if (result.status !== 0) {
    log("Could not generate Claude Code MCP config reference.");
    return;
  }
  const outputFile = join(homedir(), ".retentia", "claude-code-mcp.json");
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, result.stdout, "utf8");
  log(`Claude Code MCP config reference: ${outputFile}`);
}

function writeVsCodeMcpConfigs() {
  const config = {
    type: "stdio",
    command: "node",
    args: [
      join(ROOT_DIR, "dist", "cli.js"),
      "mcp",
      "--data-file",
      join(homedir(), ".retentia", "retentia-v2.db"),
    ],
  };

  for (const configPath of resolveVsCodeMcpConfigPaths()) {
    const parsed = readJsonObject(configPath, { servers: {}, inputs: [] });
    if (
      !parsed.servers ||
      typeof parsed.servers !== "object" ||
      Array.isArray(parsed.servers)
    ) {
      parsed.servers = {};
    }
    if (!Array.isArray(parsed.inputs)) {
      parsed.inputs = [];
    }

    parsed.servers.retentia = config;
    writeJson(configPath, parsed);
    log(`VS Code Retentia MCP config: ${configPath}`);
  }
}

function resolveVsCodeMcpConfigPaths() {
  const explicit = (process.env.RETENTIA_VSCODE_MCP_CONFIG || "").trim();
  if (explicit) {
    return [explicit];
  }

  const paths = [defaultVsCodeMcpFile()];
  const profilesDir = join(dirname(defaultVsCodeMcpFile()), "profiles");
  try {
    for (const entry of readdirSync(profilesDir)) {
      const candidate = join(profilesDir, entry, "mcp.json");
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        paths.push(candidate);
      }
    }
  } catch {}

  return unique(paths);
}

function installRetentiaHooks() {
  const hookScriptPath = writeRetentiaHookScript();
  installCodexHooks(hookScriptPath);
  installClaudeCodeHooks(hookScriptPath);
}

function writeRetentiaHookScript() {
  const hookScriptPath = join(
    homedir(),
    ".retentia",
    "hooks",
    "retentia-enforcement.mjs",
  );
  mkdirSync(dirname(hookScriptPath), { recursive: true });
  writeFileSync(hookScriptPath, RETENTIA_HOOK_SCRIPT, "utf8");
  chmodSync(hookScriptPath, 0o755);
  log(`Retentia enforcement hook: ${hookScriptPath}`);
  return hookScriptPath;
}

function installCodexHooks(hookScriptPath) {
  const codexDir = join(homedir(), ".codex");
  mkdirSync(codexDir, { recursive: true });

  const hooksPath = join(codexDir, "hooks.json");
  const hooksConfig = readJsonObject(hooksPath, { hooks: {} });
  upsertRetentiaHooks(hooksConfig, buildRetentiaHookSpecs(hookScriptPath), {
    includeHandlerMetadata: true,
  });
  writeJson(hooksPath, hooksConfig);

  log(`Codex Retentia hooks: ${hooksPath}`);
}

function installClaudeCodeHooks(hookScriptPath) {
  const claudeDir = join(homedir(), ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, "settings.json");
  const settings = readJsonObject(settingsPath, {});
  upsertRetentiaHooks(settings, buildRetentiaHookSpecs(hookScriptPath, true));
  writeJson(settingsPath, settings);

  log(`Claude Code Retentia hooks: ${settingsPath}`);
}

function buildRetentiaHookSpecs(hookScriptPath, includeToolMatchers = false) {
  const base = shellCommand([process.execPath, hookScriptPath]);
  return {
    UserPromptSubmit: {
      command: `${base} user-prompt-submit`,
      statusMessage: "Applying Retentia task policy",
    },
    PreToolUse: {
      matcher: includeToolMatchers ? "*" : undefined,
      command: `${base} pre-tool-use`,
      statusMessage: "Checking Retentia-first policy",
    },
    PostToolUse: {
      matcher: includeToolMatchers ? "*" : undefined,
      command: `${base} post-tool-use`,
      statusMessage: "Tracking Retentia usage",
    },
    Stop: {
      command: `${base} stop`,
      statusMessage: "Enforcing Retentia completion log",
    },
  };
}

function upsertRetentiaHooks(
  config,
  specs,
  { includeHandlerMetadata = false } = {},
) {
  if (
    !config.hooks ||
    typeof config.hooks !== "object" ||
    Array.isArray(config.hooks)
  ) {
    config.hooks = {};
  }

  for (const [eventName, spec] of Object.entries(specs)) {
    const existingGroups = Array.isArray(config.hooks[eventName])
      ? config.hooks[eventName]
      : [];
    const filteredGroups = removeRetentiaHookHandlers(existingGroups);
    const handler = {
      type: "command",
      command: spec.command,
    };
    if (includeHandlerMetadata) {
      handler.timeout = 30;
      handler.statusMessage = spec.statusMessage;
    }

    const group = {
      hooks: [handler],
    };

    if (spec.matcher !== undefined) {
      group.matcher = spec.matcher;
    }

    config.hooks[eventName] = [...filteredGroups, group];
  }
}

function removeRetentiaHookHandlers(groups) {
  return groups
    .map((group) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
        return group;
      }

      return {
        ...group,
        hooks: group.hooks.filter((hook) => !isRetentiaEnforcementHook(hook)),
      };
    })
    .filter((group) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
        return true;
      }
      return group.hooks.length > 0;
    });
}

function isRetentiaEnforcementHook(hook) {
  if (!hook || typeof hook !== "object" || typeof hook.command !== "string") {
    return false;
  }

  return (
    hook.command.includes("retentia-enforcement.mjs") ||
    hook.command.includes("retentia_enforcement.py")
  );
}

function shellCommand(args) {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value) {
  const raw = String(value);
  if (process.platform === "win32") {
    return `"${raw.replace(/(["\\])/g, "\\$1")}"`;
  }
  return `'${raw.replace(/'/g, "'\\''")}'`;
}

function readJsonObject(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${filePath}: ${message}`);
  }
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function resetEnvironment() {
  const codeCli = resolveCodeCli();
  if (codeCli) {
    log(`Removing existing extension installations with: ${codeCli}`);
    uninstallKnownExtensions(codeCli);
  } else {
    log("VS Code CLI not found during reset; skipping extension uninstall");
  }

  resetCodexConfig();
  resetVsCodeMcpConfig();
}

function resetCodexConfig() {
  const configPath =
    process.env.RETENTIA_CODEX_CONFIG ||
    join(homedir(), ".codex", "config.toml");
  if (!existsSync(configPath)) {
    return;
  }

  const lines = readFileSync(configPath, "utf8").split(/\r?\n/);
  const output = [];
  let skip = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "[mcp_servers.retentia]") {
      skip = true;
      continue;
    }

    if (skip && /^\[.+\]$/.test(trimmed)) {
      skip = false;
    }

    if (!skip) {
      output.push(line);
    }
  }

  writeFileSync(configPath, `${output.join("\n")}\n`, "utf8");
}

function resetVsCodeMcpConfig() {
  const mcpConfigPath =
    process.env.RETENTIA_VSCODE_MCP_CONFIG || defaultVsCodeMcpFile();
  if (!existsSync(mcpConfigPath)) {
    return;
  }

  try {
    const raw = readFileSync(mcpConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.servers && typeof parsed.servers === "object") {
      for (const key of Object.keys(parsed.servers)) {
        const normalized = key.toLowerCase();
        if (normalized.includes("retentia")) {
          delete parsed.servers[key];
        }
      }
      writeFileSync(
        mcpConfigPath,
        `${JSON.stringify(parsed, null, 2)}\n`,
        "utf8",
      );
    }
  } catch {
    log(`Could not parse VS Code MCP config: ${mcpConfigPath}`);
  }
}

function uninstallKnownExtensions(codeCli) {
  const extensionIds = csv(process.env.RETENTIA_VSCODE_EXTENSION_IDS).length
    ? csv(process.env.RETENTIA_VSCODE_EXTENSION_IDS)
    : ["local.retentia-vscode"];

  for (const extensionId of extensionIds) {
    run(codeCli, ["--uninstall-extension", extensionId], ROOT_DIR, true);
    for (const profile of listProfiles()) {
      run(
        codeCli,
        ["--uninstall-extension", extensionId, "--profile", profile],
        ROOT_DIR,
        true,
      );
    }
  }
}

function installExtensionEverywhere(codeCli, vsixFile) {
  run(codeCli, ["--install-extension", vsixFile, "--force"], ROOT_DIR);

  for (const profile of listProfiles()) {
    const result = run(
      codeCli,
      ["--install-extension", vsixFile, "--force", "--profile", profile],
      ROOT_DIR,
      true,
    );

    if (result.status !== 0) {
      log(`Skipping profile '${profile}' because installation failed.`);
    }
  }
}

function listProfiles() {
  const explicit = (process.env.RETENTIA_VSCODE_PROFILE || "").trim();
  if (explicit) {
    return [explicit];
  }

  const storageFile =
    process.env.RETENTIA_VSCODE_STORAGE_FILE || defaultVsCodeStorageFile();
  if (!existsSync(storageFile)) {
    return [];
  }

  try {
    const raw = readFileSync(storageFile, "utf8");
    const parsed = JSON.parse(raw);
    const profiles = Array.isArray(parsed?.userDataProfiles)
      ? parsed.userDataProfiles
          .map((item) =>
            item && typeof item.name === "string" ? item.name.trim() : "",
          )
          .filter(Boolean)
      : [];
    return [...new Set(profiles)];
  } catch {
    return [];
  }
}

function resolveVsixPath() {
  const extensionPackage = JSON.parse(
    readFileSync(EXTENSION_PACKAGE_JSON, "utf8"),
  );
  return join(
    VSCODE_EXTENSION_DIR,
    `${extensionPackage.name}-${extensionPackage.version}.vsix`,
  );
}

function resolveCodeCli() {
  codeCliResolutionHint = "";
  const candidates = [];
  const envCli = (process.env.RETENTIA_VSCODE_CLI || "").trim();
  if (envCli) {
    candidates.push(envCli);
  }

  candidates.push("code");
  if (process.platform === "win32") {
    candidates.push("code.cmd");
  }

  candidates.push(...platformCodeCandidates());

  for (const candidate of unique(candidates)) {
    if (!canRunCodeCli(candidate)) {
      continue;
    }

    const probe = ensureCodeCliUsable(candidate);
    if (!probe.ok) {
      if (!codeCliResolutionHint && probe.hint) {
        codeCliResolutionHint = probe.hint;
      }
      continue;
    }

    return candidate;
  }

  return undefined;
}

function canRunCodeCli(candidate) {
  const result = run(candidate, ["--version"], ROOT_DIR, true);
  return result.status === 0;
}

function ensureCodeCliUsable(candidate) {
  const firstProbe = run(candidate, ["--list-extensions"], ROOT_DIR, true);
  if (firstProbe.status === 0) {
    return { ok: true };
  }

  if (!looksLikeIpcSocketFailure(firstProbe)) {
    return {
      ok: false,
      hint: "Detected a VS Code CLI candidate, but it could not be used. Set RETENTIA_VSCODE_CLI to a working 'code' command/path.",
    };
  }

  const sockets = resolveVsCodeIpcSocketCandidates();
  if (!sockets.length) {
    return {
      ok: false,
      hint: "Detected a VS Code remote CLI, but no active VS Code IPC socket was found. Open a VS Code remote window and retry, or set RETENTIA_VSCODE_CLI to a local 'code' command.",
    };
  }

  for (const socket of sockets) {
    if (process.env.VSCODE_IPC_HOOK_CLI !== socket) {
      process.env.VSCODE_IPC_HOOK_CLI = socket;
      log(`Using VS Code IPC socket: ${socket}`);
    }

    const retryProbe = run(candidate, ["--list-extensions"], ROOT_DIR, true);
    if (retryProbe.status === 0) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    hint: "Detected a VS Code remote CLI, but the IPC socket could not be reached. Open/reload the remote VS Code window and retry, or set RETENTIA_VSCODE_CLI.",
  };
}

function looksLikeIpcSocketFailure(result) {
  const output = `${result.stderr || ""}\n${result.stdout || ""}`;
  return (
    output.includes("Unable to connect to VS Code server") ||
    output.includes("connect ENOENT") ||
    /vscode-ipc-[\w-]+\.sock/.test(output)
  );
}

function resolveVsCodeIpcSocketCandidates() {
  const sockets = [];
  const envSocket = (process.env.VSCODE_IPC_HOOK_CLI || "").trim();
  if (envSocket && existsSync(envSocket)) {
    sockets.push(envSocket);
  }

  const runtimeDir = resolveRuntimeDir();
  if (!runtimeDir || !existsSync(runtimeDir)) {
    return unique(sockets);
  }

  try {
    const discovered = readdirSync(runtimeDir)
      .filter((name) => /^vscode-ipc-.*\.sock$/.test(name))
      .map((name) => join(runtimeDir, name))
      .filter((candidate) => existsSync(candidate))
      .sort((left, right) => getMtimeMs(right) - getMtimeMs(left));
    for (const candidate of discovered) {
      sockets.push(candidate);
    }
  } catch {
    return unique(sockets);
  }

  return unique(sockets);
}

function getMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function resolveRuntimeDir() {
  const explicit = (process.env.XDG_RUNTIME_DIR || "").trim();
  if (explicit) {
    return explicit;
  }

  if (typeof process.getuid === "function") {
    return `/run/user/${process.getuid()}`;
  }

  return undefined;
}

function platformCodeCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      join(
        homedir(),
        "Applications",
        "Visual Studio Code.app",
        "Contents",
        "Resources",
        "app",
        "bin",
        "code",
      ),
    ];
  }

  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

    return [
      join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
      join(programFiles, "Microsoft VS Code", "bin", "code.cmd"),
      join(programFilesX86, "Microsoft VS Code", "bin", "code.cmd"),
    ];
  }

  return [
    "/usr/bin/code",
    "/usr/local/bin/code",
    "/snap/bin/code",
    ...wslRemoteCodeCandidates(),
  ];
}

function wslRemoteCodeCandidates() {
  const candidates = [];
  const serverDirs = [
    join(homedir(), ".vscode-server", "bin"),
    join(homedir(), ".vscode-server-insiders", "bin"),
  ];

  for (const serverDir of serverDirs) {
    if (!existsSync(serverDir)) {
      continue;
    }

    try {
      const entries = readdirSync(serverDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        candidates.push(
          join(serverDir, entry.name, "bin", "remote-cli", "code"),
        );
      }
    } catch {
      continue;
    }
  }

  return candidates;
}

function defaultVsCodeStorageFile() {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "storage.json",
    );
  }

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Code", "User", "globalStorage", "storage.json");
  }

  return join(
    homedir(),
    ".config",
    "Code",
    "User",
    "globalStorage",
    "storage.json",
  );
}

function defaultVsCodeMcpFile() {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "mcp.json",
    );
  }

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Code", "User", "mcp.json");
  }

  return join(homedir(), ".config", "Code", "User", "mcp.json");
}

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    run(process.execPath, [npmExecPath, ...args], cwd);
    return;
  }

  run(process.platform === "win32" ? "npm.cmd" : "npm", args, cwd);
}

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: allowFailure ? "pipe" : "inherit",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    if (!allowFailure) {
      throw new Error(`Command failed: ${command} ${args.join(" ")}`);
    }
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function csv(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function log(message) {
  process.stdout.write(`[retentia] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[retentia] ${message}\n`);
  process.exit(1);
}
