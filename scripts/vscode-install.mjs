#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  realpathSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const VSCODE_EXTENSION_DIR = join(ROOT_DIR, "vscode-extension");
const EXTENSION_PACKAGE_JSON = join(VSCODE_EXTENSION_DIR, "package.json");
let codeCliResolutionHint = "";

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
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
  log("Ensuring Codex config.toml contains Retentia MCP");
  const codexConfig = writeCodexMcpConfigToml();
  log(
    `Codex Retentia MCP config: ${codexConfig.path}${
      codexConfig.changed ? "" : " (already current)"
    }`,
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

function writeCodexMcpConfigToml() {
  const configPath =
    process.env.RETENTIA_CODEX_CONFIG ||
    join(homedir(), ".codex", "config.toml");
  const header = "[mcp_servers.retentia]";
  const body = [
    `command = "node"`,
    `args = ${formatTomlStringArray([
      join(ROOT_DIR, "dist", "cli.js"),
      "mcp",
      "--data-file",
      join(homedir(), ".retentia", "retentia-v2.db"),
    ])}`,
  ];

  mkdirSync(dirname(configPath), { recursive: true });
  const current = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : "";
  const next = upsertTomlSection(current, header, body);
  if (next !== current) {
    writeFileSync(configPath, next, "utf8");
  }

  return { path: configPath, changed: next !== current };
}

function upsertTomlSection(current, header, body) {
  const output = [];
  let skip = false;

  for (const line of current.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === header) {
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

  const prefix = output.join("\n").trimEnd();
  const section = [header, ...body].join("\n");
  return `${prefix}${prefix ? "\n\n" : ""}${section}\n`;
}

function formatTomlStringArray(values) {
  return `[${values.map((value) => `"${escapeTomlString(value)}"`).join(", ")}]`;
}

function escapeTomlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

export function installRetentiaHooks(userDirectory = homedir()) {
  const hookScriptPath = join(userDirectory, ".retentia", "hooks", "retentia-enforcement.mjs");
  const source = readFileSync(new URL("./retentia-enforcement.mjs", import.meta.url));
  mkdirSync(dirname(hookScriptPath), { recursive: true });
  if (!existsSync(hookScriptPath) || !source.equals(readFileSync(hookScriptPath))) {
    const temporary = hookScriptPath + "." + process.pid + ".tmp";
    writeFileSync(temporary, source, { mode: 0o755 });
    renameSync(temporary, hookScriptPath);
  }
  chmodSync(hookScriptPath, 0o755);
  installCodexHooks(hookScriptPath, userDirectory);
  installClaudeCodeHooks(hookScriptPath, userDirectory);
}

function installCodexHooks(hookScriptPath, userDirectory) {
  const codexDir = join(userDirectory, ".codex");
  mkdirSync(codexDir, { recursive: true });

  const hooksPath = join(codexDir, "hooks.json");
  const hooksConfig = readJsonObject(hooksPath, { hooks: {} });
  upsertRetentiaHooks(hooksConfig, buildRetentiaHookSpecs(hookScriptPath), {
    includeHandlerMetadata: true,
  });
  writeJson(hooksPath, hooksConfig);

  log(`Codex Retentia hooks: ${hooksPath}`);
}

function installClaudeCodeHooks(hookScriptPath, userDirectory) {
  const claudeDir = join(userDirectory, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, "settings.json");
  const settings = readJsonObject(settingsPath, {});
  upsertRetentiaHooks(settings, buildRetentiaHookSpecs(hookScriptPath, true));
  writeJson(settingsPath, settings);

  log(`Claude Code Retentia hooks: ${settingsPath}`);
}

function buildRetentiaHookSpecs(hookScriptPath, includeToolMatchers = false) {
  function definition(event, statusMessage, matcher) {
    return {
      command: shellCommand([process.execPath, hookScriptPath]) + " " + event,
      event,
      hookScriptPath,
      statusMessage,
      matcher,
    };
  }
  const tools = includeToolMatchers ? "*" : undefined;
  return {
    UserPromptSubmit: definition("user-prompt-submit", "Applying Retentia task policy"),
    PreToolUse: definition("pre-tool-use", "Checking Retentia-first policy", tools),
    PostToolUse: definition("post-tool-use", "Tracking Retentia usage", tools),
    Stop: definition("stop", "Enforcing Retentia completion log"),
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

    // Preserve the registered position: Codex keys hook trust by position and command.
    let placed = false;
    const groups = [];
    for (const existing of existingGroups) {
      if (!Array.isArray(existing?.hooks) || !existing.hooks.length) {
        groups.push(existing);
        continue;
      }
      const hooks = [];
      for (const entry of existing.hooks) {
        const registered = registeredCommand(entry, spec);
        if (registered === null) {
          hooks.push(entry);
        } else if (!placed && existing.matcher === spec.matcher) {
          hooks.push({ ...entry, ...handler, command: registered || handler.command });
          placed = true;
        }
      }
      if (hooks.length) groups.push({ ...existing, hooks });
    }
    if (!placed) groups.push(group);
    config.hooks[eventName] = groups;
  }
}

// null identifies an unrelated command; an empty string requests migration.
function registeredCommand(entry, spec) {
  if (entry?.type !== "command" || typeof entry.command !== "string") return null;
  const command = entry.command;
  const userDirectory = resolve(dirname(spec.hookScriptPath), "../..");
  const legacy = join(userDirectory, ".codex", "hooks", "retentia_enforcement.py");
  for (const script of [spec.hookScriptPath, legacy]) {
    const forms = [shellQuote(script)];
    if (/^[\w./:\\-]+$/.test(script)) forms.push(script);
    for (const form of forms) {
      const invocation = form + " " + spec.event;
      if (script === legacy && (command === invocation || command === form)) return "";
      const suffix = " " + invocation;
      if (!command.endsWith(suffix)) continue;
      const prefix = command.slice(0, -suffix.length);
      let executable = prefix;
      if (prefix.startsWith("'") || prefix.startsWith('"')) {
        executable = prefix.slice(1, -1);
        executable = process.platform === "win32" ? executable.replace(/\\(["\\])/g, "$1") : executable.replaceAll("'\\''", "'");
        if (shellQuote(executable) !== prefix) continue;
      } else if (!/^[\w./:\\-]+$/.test(executable)) continue;
      if (script === legacy && /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(basename(executable))) return "";
      if (script !== spec.hookScriptPath || !/^(?:node|nodejs)(?:\.exe)?$/i.test(basename(executable))) continue;
      if (!isAbsolute(executable)) return "";
      try {
        accessSync(executable, constants.X_OK);
        if (statSync(executable).isFile()) return command;
      } catch { /* Upgrade registrations whose interpreter was removed. */ }
      return "";
    }
  }
  return null;
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
