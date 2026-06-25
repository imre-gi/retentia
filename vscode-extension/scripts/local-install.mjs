#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..");
const PACKAGE_JSON = join(EXT_DIR, "package.json");
let codeCliResolutionHint = "";

try {
  runNpm(["run", "package"], EXT_DIR);

  const extensionPackage = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  const vsixFile = join(EXT_DIR, `${extensionPackage.name}-${extensionPackage.version}.vsix`);
  if (!existsSync(vsixFile)) {
    throw new Error(`VSIX file not found: ${vsixFile}`);
  }

  const codeCli = resolveCodeCli();
  if (!codeCli) {
    throw new Error(
      [
      "VS Code CLI not found.",
      "Install the 'code' command and retry, or set RETENTIA_VSCODE_CLI.",
      codeCliResolutionHint,
      `Generated VSIX: ${vsixFile}`
    ]
        .filter(Boolean)
        .join("\n")
    );
  }

  uninstallKnownExtensions(codeCli);
  installExtensionEverywhere(codeCli, vsixFile);

  log("Local extension install complete.");
  log("If commands are not visible, run 'Developer: Reload Window'.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
}

function uninstallKnownExtensions(codeCli) {
  const extensionIds = csv(process.env.RETENTIA_VSCODE_EXTENSION_IDS).length
    ? csv(process.env.RETENTIA_VSCODE_EXTENSION_IDS)
    : ["local.retentia-vscode"];

  for (const extensionId of extensionIds) {
    run(codeCli, ["--uninstall-extension", extensionId], EXT_DIR, true);
    for (const profile of listProfiles()) {
      run(
        codeCli,
        ["--uninstall-extension", extensionId, "--profile", profile],
        EXT_DIR,
        true
      );
    }
  }
}

function installExtensionEverywhere(codeCli, vsixFile) {
  run(codeCli, ["--install-extension", vsixFile, "--force"], EXT_DIR);

  for (const profile of listProfiles()) {
    run(
      codeCli,
      ["--install-extension", vsixFile, "--force", "--profile", profile],
      EXT_DIR,
      true
    );
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
            item && typeof item.name === "string" ? item.name.trim() : ""
          )
          .filter(Boolean)
      : [];
    return [...new Set(profiles)];
  } catch {
    return [];
  }
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
  const result = run(candidate, ["--version"], EXT_DIR, true);
  return result.status === 0;
}

function ensureCodeCliUsable(candidate) {
  const firstProbe = run(candidate, ["--list-extensions"], EXT_DIR, true);
  if (firstProbe.status === 0) {
    return { ok: true };
  }

  if (!looksLikeIpcSocketFailure(firstProbe)) {
    return {
      ok: false,
      hint:
        "Detected a VS Code CLI candidate, but it could not be used. Set RETENTIA_VSCODE_CLI to a working 'code' command/path."
    };
  }

  const sockets = resolveVsCodeIpcSocketCandidates();
  if (!sockets.length) {
    return {
      ok: false,
      hint:
        "Detected a VS Code remote CLI, but no active VS Code IPC socket was found. Open a VS Code remote window and retry, or set RETENTIA_VSCODE_CLI to a local 'code' command."
    };
  }

  for (const socket of sockets) {
    if (process.env.VSCODE_IPC_HOOK_CLI !== socket) {
      process.env.VSCODE_IPC_HOOK_CLI = socket;
      log(`Using VS Code IPC socket: ${socket}`);
    }

    const retryProbe = run(candidate, ["--list-extensions"], EXT_DIR, true);
    if (retryProbe.status === 0) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    hint:
      "Detected a VS Code remote CLI, but the IPC socket could not be reached. Open/reload the remote VS Code window and retry, or set RETENTIA_VSCODE_CLI."
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
        "code"
      )
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
      join(programFilesX86, "Microsoft VS Code", "bin", "code.cmd")
    ];
  }

  return [
    "/usr/bin/code",
    "/usr/local/bin/code",
    "/snap/bin/code",
    ...wslRemoteCodeCandidates()
  ];
}

function wslRemoteCodeCandidates() {
  const candidates = [];
  const serverDirs = [
    join(homedir(), ".vscode-server", "bin"),
    join(homedir(), ".vscode-server-insiders", "bin")
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
        candidates.push(join(serverDir, entry.name, "bin", "remote-cli", "code"));
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
      "storage.json"
    );
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Code", "User", "globalStorage", "storage.json");
  }

  return join(homedir(), ".config", "Code", "User", "globalStorage", "storage.json");
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
    encoding: "utf8"
  });

  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
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
  process.stdout.write(`[retentia:vscode] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[retentia:vscode] ${message}\n`);
  process.exit(1);
}
