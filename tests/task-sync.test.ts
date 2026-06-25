import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { buildExecutionReport } from "../src/execution-report.js";
import { MemoryStore } from "../src/store.js";
import { syncTaskExecutions } from "../src/task-sync.js";

function withTempStore(
  run: (ctx: {
    rootDir: string;
    store: MemoryStore;
    codexDir: string;
    claudeDir: string;
  }) => void
): void {
  const rootDir = mkdtempSync(join(tmpdir(), "retentia-sync-test-"));
  const dbFile = join(rootDir, "memory.db");
  const codexDir = join(rootDir, "codex-sessions");
  const claudeDir = join(rootDir, "claude-projects");
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });

  const store = new MemoryStore(dbFile, join(rootDir, "fred-client"));
  try {
    run({ rootDir, store, codexDir, claudeDir });
  } finally {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

describe("task sync", () => {
  test("imports codex and claude task execution events", () => {
    withTempStore(({ store, codexDir, claudeDir }) => {
      writeFileSync(
        join(codexDir, "rollout-1.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-03-02T10:00:00.000Z",
            type: "event_msg",
            payload: {
              type: "task_complete",
              turn_id: "turn-codex-1",
              last_agent_message: "Implemented auth fix and tests."
            }
          })
        ].join("\n")
      );

      writeFileSync(
        join(claudeDir, "session-1.jsonl"),
        [
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-03-02T10:01:00.000Z",
            sessionId: "claude-session-1",
            cwd: "/tmp/fred-client",
            message: {
              model: "claude-sonnet-4-6",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_sync_1",
                  name: "Task",
                  input: {
                    description: "Run backend migration checks",
                    subagent_type: "backend"
                  }
                }
              ]
            }
          }),
          JSON.stringify({
            type: "user",
            timestamp: "2026-03-02T10:01:22.000Z",
            sessionId: "claude-session-1",
            cwd: "/tmp/fred-client",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_sync_1",
                  is_error: false,
                  content: "Migration checks completed successfully."
                }
              ]
            }
          })
        ].join("\n")
      );

      const result = syncTaskExecutions(store, {
        providers: ["codex", "claude"],
        codexPath: codexDir,
        claudePath: claudeDir,
        lookbackDays: 30,
        maxImport: 50,
        fallbackProject: "fred-client"
      });

      expect(result.detectedTasks).toBe(2);
      expect(result.importedTasks).toBe(2);
      expect(result.failedTasks).toBe(0);
      expect(result.newestTaskAt).toBe("2026-03-02T10:01:22.000Z");
      expect(store.hasExternalKey("codex:turn-codex-1")).toBe(true);
      expect(store.hasExternalKey("claude:claude-session-1:toolu_sync_1")).toBe(true);

      const report = buildExecutionReport(store.listEntries({ limit: 20 }));
      expect(report.total).toBe(2);
      expect(report.providers.map((item) => item.key)).toContain("codex");
      expect(report.providers.map((item) => item.key)).toContain("claude");
      expect(report.agents.map((item) => item.key)).toContain("backend");
      expect(report.trends.daily[report.trends.daily.length - 1]).toMatchObject({
        count: 2,
        completed: 2
      });
      expect(report.trends.daily[report.trends.daily.length - 1]?.key).toMatch(
        /^\d{4}-\d{2}-\d{2}$/
      );
    });
  });
});
