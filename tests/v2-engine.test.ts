import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { V2MemoryEngine } from "../src/v2-engine.js";
import { ingestV2TaskEvents } from "../src/v2-task-ingest.js";

function withEngine(run: (engine: V2MemoryEngine) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "retentia-v2-test-"));
  const engine = new V2MemoryEngine(join(dir, "memory.db"));
  try {
    run(engine);
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("V2MemoryEngine", () => {
  test("stores events, distilled memories, and graph edges", () => {
    withEngine((engine) => {
      const event = engine.addEvent({
        type: "task_started",
        source: "mcp",
        actor: "codex",
        role: "primary",
        taskId: "task-1",
        project: "retentia",
        summary: "Design low-token memory retrieval",
        tags: ["agent:codex", "task:design"],
        payload: { model: "gpt-5-codex" },
      });

      const memory = engine.addMemory({
        kind: "decision",
        project: "retentia",
        title: "Use staged retrieval by default",
        body: "Search should return compact IDs and snippets first, then hydrate full evidence only when the model asks for it.",
        tags: ["rag", "tokens"],
        sourceEventIds: [event.id],
        confidence: 0.94,
        pinned: true,
      });

      const edge = engine.addEdge({
        fromType: "agent",
        fromId: "codex",
        toType: "task",
        toId: "task-1",
        relation: "works_on",
      });

      expect(event.id).toBeGreaterThan(0);
      expect(memory.sourceEventIds).toEqual([event.id]);
      expect(memory.pinned).toBe(true);
      expect(edge.relation).toBe("works_on");
    });
  });

  test("searches memories with FTS and metadata filters", () => {
    withEngine((engine) => {
      engine.addMemory({
        kind: "procedure",
        project: "retentia",
        title: "Debug auth callbacks",
        body: "Inspect redirect middleware, expired token refresh, and session cookie propagation.",
        tags: ["auth", "debug"],
      });
      engine.addMemory({
        kind: "fact",
        project: "portfolio",
        title: "Hero image rule",
        body: "Landing pages need real visual assets above the fold.",
        tags: ["frontend"],
      });

      const results = engine.search({
        query: "expired token",
        project: "retentia",
        tags: ["auth"],
      });

      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe("Debug auth callbacks");
      expect(results[0]?.snippet).toContain("token");
    });
  });

  test("stores redacted evidence chunks and searches them", () => {
    withEngine((engine) => {
      const evidence = engine.addEvidence({
        sourceType: "memory",
        sourceId: "42",
        project: "retentia",
        uri: "session.jsonl",
        offsetStart: 12,
        offsetEnd: 90,
        content:
          "The callback failed with api_key=secret123 and Authorization: Bearer abc.def.ghi while processing evidence.",
        metadata: { line: 7 },
      });

      const results = engine.searchEvidence({
        query: "callback evidence",
        sourceType: "memory",
        sourceId: "42",
      });
      const edges = engine.listEdgesForNode("memory", "42");

      expect(evidence.redacted).toBe(true);
      expect(evidence.content).toContain("[REDACTED_SECRET]");
      expect(evidence.content).toContain("[REDACTED_TOKEN]");
      expect(results).toHaveLength(1);
      expect(results[0]?.snippet).toContain("callback");
      expect(edges.some((edge) => edge.toId === String(evidence.id))).toBe(
        true,
      );
    });
  });

  test("builds budgeted context packs", () => {
    withEngine((engine) => {
      engine.addMemory({
        kind: "episode",
        project: "retentia",
        title: "Token economy design session",
        body: "The system should preserve raw events but retrieve compact derived memories by default to minimize repeated context cost.",
        tags: ["tokens", "architecture"],
      });
      engine.addMemory({
        kind: "decision",
        project: "retentia",
        title: "Prefer SQLite FTS first",
        body: "FTS5 and BM25 provide fast local ranking without requiring hosted vector databases for the personal version.",
        tags: ["search", "local-first"],
      });

      const context = engine.buildContext({
        query: "retrieval tokens",
        project: "retentia",
        mode: "brief",
        maxChars: 220,
      });

      expect(context.text).toContain("<retentia-v2-context");
      expect(context.usedChars).toBeLessThanOrEqual(220);
      expect(context.memoryIds.length).toBeGreaterThan(0);
    });
  });

  test("explains hybrid retrieval boosts from graph and evidence", () => {
    withEngine((engine) => {
      const memory = engine.addMemory({
        kind: "decision",
        project: "retentia",
        title: "Hybrid retrieval needs evidence boosts",
        body: "Evidence-linked memories should rank higher when the lexical match is comparable.",
        tags: ["retrieval"],
        confidence: 0.8,
      });
      engine.addEvidence({
        sourceType: "memory",
        sourceId: String(memory.id),
        project: "retentia",
        content: "The benchmark showed evidence-linked retrieval improved recall.",
      });

      const results = engine.search({
        query: "evidence retrieval",
        project: "retentia",
        retrieval: "hybrid",
        explain: true,
      });

      expect(results[0]?.id).toBe(memory.id);
      expect(results[0]?.explanation?.retrieval).toBe("hybrid");
      expect(results[0]?.explanation?.evidenceBoost).toBeGreaterThan(0);
      expect(results[0]?.explanation?.graphBoost).toBeGreaterThan(0);
      expect(results[0]?.score).toBeGreaterThan(100);
    });
  });

  test("updates, archives, merges, and lists stale memories", () => {
    withEngine((engine) => {
      const oldMemory = engine.addMemory({
        kind: "fact",
        project: "retentia",
        title: "Stale install note",
        body: "The install flow writes MCP configuration directly.",
        tags: ["install"],
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      const duplicate = engine.addMemory({
        kind: "fact",
        project: "retentia",
        title: "Duplicate install note",
        body: "The MCP configuration note is duplicate context.",
        tags: ["duplicate"],
      });
      engine.addEvidence({
        sourceType: "memory",
        sourceId: String(duplicate.id),
        project: "retentia",
        content: "Duplicate evidence should move to the primary memory.",
      });

      const staleBeforeUpdate = engine.listStaleMemories({
        olderThanDays: 365,
        project: "retentia",
      });
      const pinned = engine.setMemoryPinned(oldMemory.id, true);
      const archived = engine.archiveMemory(oldMemory.id, true);
      const searchWithoutArchived = engine.search({
        query: "install",
        project: "retentia",
      });
      const searchWithArchived = engine.search({
        query: "install",
        project: "retentia",
        includeArchived: true,
      });
      const restored = engine.archiveMemory(oldMemory.id, false);
      const merged = engine.mergeMemories(oldMemory.id, [duplicate.id]);
      const evidence = engine.listEvidenceForSource(
        "memory",
        String(oldMemory.id),
      );

      expect(staleBeforeUpdate.some((item) => item.id === oldMemory.id)).toBe(true);
      expect(pinned.pinned).toBe(true);
      expect(archived.archived).toBe(true);
      expect(searchWithoutArchived.some((item) => item.id === oldMemory.id)).toBe(false);
      expect(searchWithArchived.some((item) => item.id === oldMemory.id)).toBe(true);
      expect(restored.archived).toBe(false);
      expect(merged.body).toContain("Merged memory");
      expect(evidence).toHaveLength(1);
      expect(() => engine.getMemoryById(duplicate.id)).toThrow();
      expect(engine.deleteMemory(oldMemory.id)).toEqual({
        deleted: true,
        id: oldMemory.id,
      });
    });
  });

  test("lists graph edges around an agent or task", () => {
    withEngine((engine) => {
      engine.addEdge({
        fromType: "agent",
        fromId: "primary",
        toType: "agent",
        toId: "backend-subagent",
        relation: "delegated_to",
        metadata: { task: "schema checks" },
      });

      const edges = engine.listEdgesForNode("agent", "primary");
      expect(edges).toHaveLength(1);
      expect(edges[0]?.toId).toBe("backend-subagent");
      expect(edges[0]?.metadata).toEqual({ task: "schema checks" });
    });
  });

  test("builds live dashboard activity with task descriptions and reasoning summaries", () => {
    withEngine((engine) => {
      engine.addEvent({
        type: "task_started",
        source: "codex",
        actor: "primary",
        role: "primary",
        taskId: "task-root",
        project: "retentia",
        summary: "Implement live agent dashboard",
        payload: {
          taskDescription: "Render agents and subagents from v2 events.",
          reasoningSummary:
            "Use explicit event payload summaries, not session log scraping.",
        },
      });
      engine.addEvent({
        type: "task_started",
        source: "codex",
        actor: "ui-subagent",
        role: "subagent",
        taskId: "task-child",
        parentTaskId: "task-root",
        project: "retentia",
        summary: "Build graph UI",
        payload: {
          rationale: "Separate parent task edges from agent ownership edges.",
        },
      });

      const dashboard = engine.buildDashboard(20);
      const childTask = dashboard.tasks.find(
        (task) => task.id === "task-child",
      );

      expect(dashboard.activities).toHaveLength(2);
      expect(childTask?.reasoning).toContain("Separate parent");
      expect(
        dashboard.tasks.find((task) => task.id === "task-root")?.description,
      ).toContain("Render agents");
      expect(
        dashboard.agents.find((agent) => agent.id === "ui-subagent")?.status,
      ).toBe("active");
    });
  });

  test("ingests Copilot, Codex, and Claude Code events into the v2 dashboard", () => {
    withEngine((engine) => {
      const dir = mkdtempSync(join(tmpdir(), "retentia-v2-ingest-test-"));
      const copilotDir = join(
        dir,
        "workspaceStorage",
        "abc",
        "GitHub.copilot-chat",
        "transcripts",
      );
      const codexDir = join(dir, "codex");
      const claudeDir = join(dir, "claude");
      mkdirSync(copilotDir, { recursive: true });
      mkdirSync(codexDir, { recursive: true });
      mkdirSync(claudeDir, { recursive: true });

      writeFileSync(
        join(copilotDir, "copilot-session.jsonl"),
        [
          JSON.stringify({
            type: "session.start",
            data: { sessionId: "copilot-session" },
            id: "copilot-session-start",
            timestamp: "2026-05-20T20:00:00.000Z",
            parentId: null,
          }),
          JSON.stringify({
            type: "assistant.turn_start",
            data: {
              turnId: "turn-1",
              model: "gpt-4.1",
              conversationId: "copilot-conversation-1",
              requestId: "copilot-request-1",
              workspaceFolder: "/workspace/retentia",
            },
            id: "copilot-turn-start",
            timestamp: "2026-05-20T20:00:01.000Z",
            parentId: "copilot-session-start",
          }),
          JSON.stringify({
            type: "assistant.message",
            data: {
              messageId: "message-1",
              content: "I will inspect the Retentia importer.",
              reasoningText:
                "Use a shared v2 ingest path so UI and CLI see the same data.",
            },
            id: "copilot-message",
            timestamp: "2026-05-20T20:00:02.000Z",
            parentId: "copilot-turn-start",
          }),
          JSON.stringify({
            type: "assistant.turn_end",
            data: { turnId: "turn-1" },
            id: "copilot-turn-end",
            timestamp: "2026-05-20T20:00:03.000Z",
            parentId: "copilot-message",
          }),
        ].join("\n"),
      );

      writeFileSync(
        join(codexDir, "codex-session.jsonl"),
        [
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: "codex-session",
              model: "gpt-5-codex",
              cwd: "/workspace/retentia",
              approval_policy: "never",
              sandbox_mode: "danger-full-access",
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-20T20:00:04.000Z",
            payload: {
              type: "task_complete",
              turn_id: "codex-turn-1",
              last_agent_message: "Codex completed the ingestion bridge.",
            },
          }),
        ].join("\n"),
      );

      writeFileSync(
        join(claudeDir, "claude-session.jsonl"),
        [
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-05-20T20:00:05.000Z",
            sessionId: "claude-session",
            cwd: "/workspace/retentia",
            uuid: "claude-uuid-1",
            parentUuid: "claude-parent-uuid-1",
            version: "1.2.3",
            permissionMode: "acceptEdits",
            message: {
              id: "claude-message-1",
              model: "claude-code",
              usage: {
                input_tokens: 12,
                output_tokens: 34,
              },
              content: [
                {
                  type: "tool_use",
                  name: "Task",
                  id: "claude-task-1",
                  input: {
                    description: "Validate universal importer",
                    prompt: "Check Copilot, Codex, and Claude Code ingestion.",
                    subagent_type: "explore",
                  },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            timestamp: "2026-05-20T20:00:06.000Z",
            sessionId: "claude-session",
            cwd: "/workspace/retentia",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "claude-task-1",
                  content: "Universal importer works across providers.",
                },
              ],
            },
          }),
        ].join("\n"),
      );

      try {
        const first = ingestV2TaskEvents(engine, {
          providers: ["all"],
          copilotPath: join(dir, "workspaceStorage"),
          codexPath: codexDir,
          claudePath: claudeDir,
          fallbackProject: "retentia",
          maxImport: 50,
        });
        const second = ingestV2TaskEvents(engine, {
          providers: ["all"],
          copilotPath: join(dir, "workspaceStorage"),
          codexPath: codexDir,
          claudePath: claudeDir,
          fallbackProject: "retentia",
          maxImport: 50,
        });
        const dashboard = engine.buildDashboard(50);

        expect(first.importedEvents).toBe(7);
        expect(second.importedEvents).toBe(0);
        expect(second.skippedEvents).toBe(7);
        expect(dashboard.tasks.some((task) => task.source === "copilot")).toBe(
          true,
        );
        expect(dashboard.tasks.some((task) => task.source === "codex")).toBe(
          true,
        );
        expect(
          dashboard.tasks.some((task) => task.source === "claude-code"),
        ).toBe(true);
        expect(
          dashboard.tasks.find((task) => task.source === "claude-code")
            ?.description,
        ).toContain("Check Copilot");
        expect(dashboard.trends.daily[dashboard.trends.daily.length - 1]).toMatchObject({
          key: "2026-05-20",
          count: 3,
          completed: 3,
        });
        expect(dashboard.trends.weekly[dashboard.trends.weekly.length - 1]?.count).toBe(3);

        const copilotPayload = dashboard.recentEvents.find(
          (event) => event.source === "copilot" && event.type === "task_started",
        )?.payload as Record<string, unknown> | undefined;
        expect(copilotPayload?.metadata).toMatchObject({
          model: "gpt-4.1",
          conversationId: "copilot-conversation-1",
          requestId: "copilot-request-1",
        });

        const codexPayload = dashboard.recentEvents.find(
          (event) => event.source === "codex",
        )?.payload as Record<string, unknown> | undefined;
        expect(codexPayload?.metadata).toMatchObject({
          model: "gpt-5-codex",
          cwd: "/workspace/retentia",
        });

        const claudePayload = dashboard.recentEvents.find(
          (event) => event.source === "claude-code" && event.type === "task_started",
        )?.payload as Record<string, unknown> | undefined;
        expect(claudePayload?.metadata).toMatchObject({
          uuid: "claude-uuid-1",
          permissionMode: "acceptEdits",
          messageId: "claude-message-1",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
