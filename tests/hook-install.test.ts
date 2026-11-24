import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { installRetentiaHooks } from "../scripts/vscode-install.mjs";

test("a reinstall upgrades the hook and preserves registrations and silent completion", () => {
  const dir = mkdtempSync(join(tmpdir(), "retentia-hook-install-"));
  try {
    installRetentiaHooks(dir);
    const hook = join(dir, ".retentia/hooks/retentia-enforcement.mjs");
    const source = readFileSync(new URL("../scripts/retentia-enforcement.mjs", import.meta.url));
    expect(readFileSync(hook)).toEqual(source);
    const configs = [join(dir, ".codex/hooks.json"), join(dir, ".claude/settings.json")];
    const priorNode = join(dir, "previous version", "node");
    if (process.platform !== "win32") {
      mkdirSync(join(dir, "previous version"));
      symlinkSync(process.execPath, priorNode);
    }
    const originals = configs.map(path => {
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      cfg.hooks.Stop.push({ hooks: [{ type: "command", command: "'/opt/audit-hook' '" + hook + "' stop" }] });
      if (existsSync("/usr/bin/node") && process.platform !== "win32") {
        cfg.hooks.Stop[0].hooks[0].command = "'/usr/bin/node' '" + hook + "' stop";
      }
      if (process.platform !== "win32") {
        cfg.hooks.UserPromptSubmit[0].hooks[0].command = "'" + priorNode + "' '" + hook + "' user-prompt-submit";
      }
      const original = JSON.stringify(cfg);
      cfg.hooks.Stop.push(cfg.hooks.Stop[0]);
      writeFileSync(path, JSON.stringify(cfg));
      return original;
    });
    writeFileSync(hook, "// old installed version");
    for (let attempt = 0; attempt < 2; attempt++) {
      installRetentiaHooks(dir);
      expect(readFileSync(hook)).toEqual(source);
      configs.forEach((path, i) => expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(originals[i])));
    }
    function event(name: string, extra: Record<string, unknown> = {}) {
      const input = join(dir, "event.json");
      writeFileSync(input, JSON.stringify({ session_id: "s", turn_id: "t", ...extra }));
      const fd = openSync(input, "r");
      try {
        return execFileSync(process.execPath, [hook, name], {
          env: { ...process.env, RETENTIA_HOOK_STATE_DIR: join(dir, "state") },
          stdio: [fd, "pipe", "pipe"], encoding: "utf8", timeout: 5000,
        });
      } finally {
        closeSync(fd);
      }
    }
    event("user-prompt-submit", { prompt: "Verifica il pacchetto." });
    event("post-tool-use", { tool_name: "mcp__retentia__memory_search", tool_response: { ok: true } });
    event("post-tool-use", { tool_name: "exec_command", tool_response: { exit_code: 0 } });
    expect(JSON.parse(event("stop"))).toEqual({ continue: false, stopReason: expect.any(String) });
    event("post-tool-use", { tool_name: "mcp__retentia__agent_event", tool_response: { ok: true } });
    expect(event("stop")).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
