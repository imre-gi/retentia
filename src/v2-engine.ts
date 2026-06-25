import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  V2ContextMode,
  V2ContextOptions,
  V2ContextPack,
  V2DashboardActivity,
  V2DashboardAgent,
  V2DashboardData,
  V2DashboardTask,
  V2DashboardTrends,
  V2Event,
  V2EventInput,
  V2ImportedEventResult,
  V2GraphEdge,
  V2GraphEdgeInput,
  V2Memory,
  V2MemoryInput,
  V2SearchOptions,
  V2SearchResult,
} from "./v2-types.js";

interface EventRow {
  id: number;
  created_at: string;
  type: string;
  source: string;
  actor: string | null;
  role: string | null;
  task_id: string | null;
  parent_task_id: string | null;
  project: string | null;
  summary: string | null;
  tags_json: string;
  artifacts_json: string;
  payload_json: string | null;
}

interface MemoryRow {
  id: number;
  created_at: string;
  updated_at: string;
  kind: V2Memory["kind"];
  project: string;
  title: string;
  body: string;
  tags_json: string;
  source_event_ids_json: string;
  confidence: number;
  pinned: number;
}

interface SearchRow extends MemoryRow {
  score: number | null;
}

interface EdgeRow {
  id: number;
  created_at: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation: string;
  weight: number;
  metadata_json: string | null;
}

interface EventImportRow {
  external_key: string;
  event_id: number;
  source: string;
  imported_at: string;
}

interface ExecutionTrendTask {
  lastSeenAt: string;
  status: string;
}

const DEFAULT_PROJECT = "global";
const DEFAULT_CONTEXT_CHARS = 1600;
const DAY_MS = 24 * 60 * 60 * 1000;

export class V2MemoryEngine {
  private readonly db: Database.Database;
  private readonly dbFile: string;

  constructor(dbFile: string) {
    mkdirSync(dirname(dbFile), { recursive: true });
    this.dbFile = dbFile;
    this.db = new Database(dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  addEvent(input: V2EventInput): V2Event {
    const createdAt = input.createdAt || new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO events (
          created_at, type, source, actor, role, task_id, parent_task_id,
          project, summary, tags_json, artifacts_json, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createdAt,
        cleanRequired(input.type, "event"),
        cleanRequired(input.source, "manual"),
        cleanOptional(input.actor),
        cleanOptional(input.role),
        cleanOptional(input.taskId),
        cleanOptional(input.parentTaskId),
        cleanOptional(input.project),
        cleanOptional(input.summary),
        toJson(cleanList(input.tags)),
        toJson(cleanList(input.artifacts)),
        input.payload === undefined ? null : toJson(input.payload),
      );

    return this.getEvent(Number(info.lastInsertRowid));
  }

  addImportedEvent(
    externalKey: string,
    input: V2EventInput,
  ): V2ImportedEventResult {
    const cleanExternalKey = cleanRequired(externalKey, "external import");
    const existing = this.db
      .prepare("SELECT * FROM event_imports WHERE external_key = ?")
      .get(cleanExternalKey) as EventImportRow | undefined;

    if (existing) {
      return {
        event: this.getEvent(existing.event_id),
        imported: false,
        externalKey: cleanExternalKey,
      };
    }

    const event = this.addEvent(input);
    this.db
      .prepare(
        `INSERT INTO event_imports (external_key, event_id, source, imported_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        cleanExternalKey,
        event.id,
        cleanRequired(input.source, "manual"),
        new Date().toISOString(),
      );

    return { event, imported: true, externalKey: cleanExternalKey };
  }

  hasImportedEvent(externalKey: string): boolean {
    const cleanExternalKey = cleanOptional(externalKey);
    if (!cleanExternalKey) {
      return false;
    }
    const row = this.db
      .prepare("SELECT 1 FROM event_imports WHERE external_key = ? LIMIT 1")
      .get(cleanExternalKey);
    return Boolean(row);
  }

  addMemory(input: V2MemoryInput): V2Memory {
    const now = input.createdAt || new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO memories (
          created_at, updated_at, kind, project, title, body, tags_json,
          source_event_ids_json, confidence, pinned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now,
        now,
        input.kind,
        cleanOptional(input.project) || DEFAULT_PROJECT,
        cleanRequired(input.title, "Untitled memory"),
        cleanRequired(input.body, ""),
        toJson(cleanList(input.tags)),
        toJson(cleanNumberList(input.sourceEventIds)),
        clamp(input.confidence ?? 0.7, 0, 1),
        input.pinned ? 1 : 0,
      );

    return this.getMemory(Number(info.lastInsertRowid));
  }

  addEdge(input: V2GraphEdgeInput): V2GraphEdge {
    const info = this.db
      .prepare(
        `INSERT INTO graph_edges (
          created_at, from_type, from_id, to_type, to_id, relation, weight, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.createdAt || new Date().toISOString(),
        cleanRequired(input.fromType, "node"),
        cleanRequired(input.fromId, "unknown"),
        cleanRequired(input.toType, "node"),
        cleanRequired(input.toId, "unknown"),
        cleanRequired(input.relation, "related_to"),
        clamp(input.weight ?? 1, 0, 1),
        input.metadata === undefined ? null : toJson(input.metadata),
      );

    const row = this.db
      .prepare("SELECT * FROM graph_edges WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as EdgeRow;
    return mapEdge(row);
  }

  search(options: V2SearchOptions = {}): V2SearchResult[] {
    const limit = clampInteger(options.limit ?? 10, 1, 50);
    const tags = cleanList(options.tags);
    const params: Array<string | number> = [];
    const filters: string[] = [];

    if (options.project?.trim()) {
      filters.push("m.project = ?");
      params.push(options.project.trim());
    }

    if (options.kind) {
      filters.push("m.kind = ?");
      params.push(options.kind);
    }

    for (const tag of tags) {
      filters.push("m.tags_json LIKE ?");
      params.push(`%\"${escapeLike(tag)}\"%`);
    }

    const matchQuery = buildFtsQuery(options.query);
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = matchQuery
      ? (this.db
          .prepare(
            `SELECT m.*, bm25(memory_fts) AS score
             FROM memory_fts
             JOIN memories m ON m.id = memory_fts.rowid
             ${where ? `${where} AND` : "WHERE"} memory_fts MATCH ?
             ORDER BY m.pinned DESC, score ASC, m.confidence DESC, m.updated_at DESC
             LIMIT ?`,
          )
          .all(...params, matchQuery, limit) as SearchRow[])
      : (this.db
          .prepare(
            `SELECT m.*, NULL AS score
             FROM memories m
             ${where}
             ORDER BY m.pinned DESC, m.confidence DESC, m.updated_at DESC
             LIMIT ?`,
          )
          .all(...params, limit) as SearchRow[]);

    return rows.map((row) => mapSearchResult(row, options.query));
  }

  buildContext(options: V2ContextOptions = {}): V2ContextPack {
    const mode = options.mode || "brief";
    const maxChars = clampInteger(
      options.maxChars ?? DEFAULT_CONTEXT_CHARS,
      120,
      24000,
    );
    const results = this.search({
      ...options,
      limit: options.limit ?? defaultLimitForMode(mode),
    });
    const lines = renderContextLines(mode, results);
    const { text, truncated } = fitLines(lines, maxChars);

    return {
      mode,
      maxChars,
      usedChars: text.length,
      truncated,
      memoryIds: results.map((result) => result.id),
      text,
    };
  }

  listEdgesForNode(
    nodeType: string,
    nodeId: string,
    limit = 50,
  ): V2GraphEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM graph_edges
         WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(
        nodeType,
        nodeId,
        nodeType,
        nodeId,
        clampInteger(limit, 1, 250),
      ) as EdgeRow[];
    return rows.map(mapEdge);
  }

  listEvents(limit = 100): V2Event[] {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(clampInteger(limit, 1, 1000)) as EventRow[];
    return rows.map(mapEvent);
  }

  listMemories(limit = 100): V2Memory[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?",
      )
      .all(clampInteger(limit, 1, 1000)) as MemoryRow[];
    return rows.map(mapMemory);
  }

  listEdges(limit = 200): V2GraphEdge[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM graph_edges ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(clampInteger(limit, 1, 2000)) as EdgeRow[];
    return rows.map(mapEdge);
  }

  buildDashboard(limit = 80): V2DashboardData {
    const recentEvents = this.listEvents(limit);
    const trendEvents = this.listEvents(Math.max(limit, 500));
    const memories = this.listMemories(limit);
    const edges = this.listEdges(limit * 2);
    const tasks = buildTasks(recentEvents);
    const trends = buildExecutionTrends(trendEvents);
    const agents = buildAgents(recentEvents, tasks);
    const activities = buildActivities(recentEvents);
    const projects = new Set([
      ...recentEvents.map((event) => event.project).filter(Boolean),
      ...memories.map((memory) => memory.project).filter(Boolean),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      dataFile: this.dbFile,
      totals: {
        events: countRows(this.db, "events"),
        memories: countRows(this.db, "memories"),
        graphEdges: countRows(this.db, "graph_edges"),
        agents: agents.length,
        tasks: tasks.length,
        projects: projects.size,
      },
      agents,
      tasks,
      trends,
      activities,
      memories,
      edges,
      recentEvents,
      contextPreview: this.buildContext({
        mode: "brief",
        maxChars: 900,
        limit: 6,
      }),
    };
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        actor TEXT,
        role TEXT,
        task_id TEXT,
        parent_task_id TEXT,
        project TEXT,
        summary TEXT,
        tags_json TEXT NOT NULL,
        artifacts_json TEXT NOT NULL,
        payload_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor, role);
      CREATE INDEX IF NOT EXISTS idx_events_project_time ON events(project, created_at);

      CREATE TABLE IF NOT EXISTS event_imports (
        external_key TEXT PRIMARY KEY,
        event_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_event_imports_event ON event_imports(event_id);

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        project TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_memories_project_kind ON memories(project, kind);
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        title,
        body,
        tags,
        content='memories',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memory_fts(rowid, title, body, tags)
        VALUES (new.id, new.title, new.body, new.tags_json);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, body, tags)
        VALUES ('delete', old.id, old.title, old.body, old.tags_json);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, body, tags)
        VALUES ('delete', old.id, old.title, old.body, old.tags_json);
        INSERT INTO memory_fts(rowid, title, body, tags)
        VALUES (new.id, new.title, new.body, new.tags_json);
      END;

      CREATE TABLE IF NOT EXISTS graph_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        from_type TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_graph_from ON graph_edges(from_type, from_id);
      CREATE INDEX IF NOT EXISTS idx_graph_to ON graph_edges(to_type, to_id);
      CREATE INDEX IF NOT EXISTS idx_graph_relation ON graph_edges(relation);
    `);
  }

  private getEvent(id: number): V2Event {
    const row = this.db
      .prepare("SELECT * FROM events WHERE id = ?")
      .get(id) as EventRow;
    return mapEvent(row);
  }

  private getMemory(id: number): V2Memory {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as MemoryRow;
    return mapMemory(row);
  }
}

function mapEvent(row: EventRow): V2Event {
  return {
    id: row.id,
    createdAt: row.created_at,
    type: row.type,
    source: row.source,
    actor: row.actor || "",
    role: row.role || "",
    taskId: row.task_id || "",
    parentTaskId: row.parent_task_id || "",
    project: row.project || "",
    summary: row.summary || "",
    tags: parseStringArray(row.tags_json),
    artifacts: parseStringArray(row.artifacts_json),
    payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
  };
}

function buildAgents(
  events: V2Event[],
  tasks: V2DashboardTask[],
): V2DashboardAgent[] {
  const agents = new Map<string, V2DashboardAgent>();
  for (const event of events) {
    const id = event.actor || event.source || "unknown";
    const current = agents.get(id) || {
      id,
      source: event.source,
      role: event.role || "primary",
      status: "idle",
      activeTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      lastSeenAt: event.createdAt,
    };

    if (event.createdAt > current.lastSeenAt) {
      current.lastSeenAt = event.createdAt;
    }
    agents.set(id, current);
  }

  for (const task of tasks) {
    const id = task.actor || task.source || "unknown";
    const current = agents.get(id) || {
      id,
      source: task.source,
      role: task.role || "primary",
      status: "idle",
      activeTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      lastSeenAt: task.lastSeenAt,
    };

    if (task.status === "completed") {
      current.completedTasks += 1;
    } else if (task.status === "failed") {
      current.failedTasks += 1;
    } else {
      current.activeTasks += 1;
    }
    if (task.lastSeenAt > current.lastSeenAt) {
      current.lastSeenAt = task.lastSeenAt;
    }
    current.status = current.activeTasks > 0 ? "active" : "idle";
    agents.set(id, current);
  }

  return [...agents.values()].sort((left, right) =>
    right.lastSeenAt.localeCompare(left.lastSeenAt),
  );
}

function buildTasks(events: V2Event[]): V2DashboardTask[] {
  const tasks = new Map<string, V2DashboardTask>();
  const orderedEvents = [...events].sort((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt);
    return byTime !== 0 ? byTime : left.id - right.id;
  });

  for (const event of orderedEvents) {
    if (!event.taskId) {
      continue;
    }
    const taskTitle = extractPayloadText(event.payload, [
      "taskTitle",
      "title",
      "objective",
      "goal",
    ]);
    const description = extractPayloadText(event.payload, [
      "taskDescription",
      "description",
      "request",
      "instruction",
      "objective",
      "goal",
    ]);
    const reasoning = extractReasoning(event.payload);
    const current = tasks.get(event.taskId) || {
      id: event.taskId,
      title: taskTitle || event.summary || event.taskId,
      description: description || event.summary || "",
      reasoning: reasoning || "",
      source: event.source,
      actor: event.actor || event.source,
      role: event.role || "primary",
      status: "active",
      project: event.project || "global",
      parentTaskId: event.parentTaskId,
      latestEventType: event.type,
      eventCount: 0,
      lastSeenAt: event.createdAt,
    };
    if (taskTitle || (event.summary && event.type === "task_started")) {
      current.title = taskTitle || event.summary;
    }
    if (description) {
      current.description = description;
    } else if (!current.description && event.summary) {
      current.description = event.summary;
    }
    if (reasoning) {
      current.reasoning = reasoning;
    }
    if (event.parentTaskId) {
      current.parentTaskId = event.parentTaskId;
    }
    current.latestEventType = event.type;
    current.eventCount += 1;
    current.lastSeenAt =
      event.createdAt > current.lastSeenAt
        ? event.createdAt
        : current.lastSeenAt;
    if (event.type === "task_completed") {
      current.status = "completed";
    } else if (event.type === "task_failed") {
      current.status = "failed";
    } else if (event.type === "task_started") {
      current.status = "active";
    }
    tasks.set(event.taskId, current);
  }
  return [...tasks.values()].sort((left, right) =>
    right.lastSeenAt.localeCompare(left.lastSeenAt),
  );
}

function buildExecutionTrends(events: V2Event[]): V2DashboardTrends {
  const tasks = buildExecutionTrendTasks(events);
  return {
    daily: buildTrendBuckets(tasks, "daily", 14),
    weekly: buildTrendBuckets(tasks, "weekly", 8),
  };
}

function buildExecutionTrendTasks(events: V2Event[]): ExecutionTrendTask[] {
  const tasks = new Map<string, ExecutionTrendTask>();
  const orderedEvents = [...events].sort((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt);
    return byTime !== 0 ? byTime : left.id - right.id;
  });

  for (const event of orderedEvents) {
    if (!event.taskId || !event.type.startsWith("task_")) {
      continue;
    }

    const current = tasks.get(event.taskId) || {
      lastSeenAt: event.createdAt,
      status: "active",
    };
    current.lastSeenAt =
      event.createdAt > current.lastSeenAt
        ? event.createdAt
        : current.lastSeenAt;
    if (event.type === "task_completed") {
      current.status = "completed";
    } else if (event.type === "task_failed") {
      current.status = "failed";
    } else if (event.type === "task_started") {
      current.status = "active";
    }
    tasks.set(event.taskId, current);
  }

  return [...tasks.values()];
}

function buildTrendBuckets(
  tasks: ExecutionTrendTask[],
  grain: "daily" | "weekly",
  bucketCount: number,
): V2DashboardTrends["daily"] {
  const anchorMs = resolveTrendAnchorMs(tasks);
  const anchorStart =
    grain === "daily"
      ? startOfUtcDay(anchorMs)
      : startOfUtcWeek(anchorMs);
  const stepMs = grain === "daily" ? DAY_MS : DAY_MS * 7;
  const buckets = new Map<
    number,
    { key: string; count: number; completed: number; failed: number }
  >();

  for (let index = bucketCount - 1; index >= 0; index -= 1) {
    const startMs = anchorStart - index * stepMs;
    buckets.set(startMs, {
      key:
        grain === "daily"
          ? formatUtcDateKey(startMs)
          : formatUtcWeekKey(startMs),
      count: 0,
      completed: 0,
      failed: 0,
    });
  }

  for (const task of tasks) {
    const timestampMs = Date.parse(task.lastSeenAt);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }
    const bucketStart =
      grain === "daily"
        ? startOfUtcDay(timestampMs)
        : startOfUtcWeek(timestampMs);
    const bucket = buckets.get(bucketStart);
    if (!bucket) {
      continue;
    }
    bucket.count += 1;
    if (task.status === "completed") {
      bucket.completed += 1;
    } else if (task.status === "failed") {
      bucket.failed += 1;
    }
  }

  let previousCount = 0;
  return [...buckets.values()].map((bucket) => {
    const delta = bucket.count - previousCount;
    previousCount = bucket.count;
    return { ...bucket, delta };
  });
}

function resolveTrendAnchorMs(tasks: ExecutionTrendTask[]): number {
  const latest = tasks
    .map((task) => Date.parse(task.lastSeenAt))
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => right - left)[0];
  return latest ?? Date.now();
}

function startOfUtcDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
}

function startOfUtcWeek(timestampMs: number): number {
  const dayStart = startOfUtcDay(timestampMs);
  const day = new Date(dayStart).getUTCDay();
  const mondayOffset = (day + 6) % 7;
  return dayStart - mondayOffset * DAY_MS;
}

function formatUtcDateKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function formatUtcWeekKey(timestampMs: number): string {
  const thursday = new Date(startOfUtcWeek(timestampMs) + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const firstThursday = Date.UTC(year, 0, 4);
  const firstWeekStart = startOfUtcWeek(firstThursday);
  const week = Math.floor((startOfUtcWeek(timestampMs) - firstWeekStart) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function buildActivities(events: V2Event[]): V2DashboardActivity[] {
  return events.map((event) => ({
    id: event.id,
    createdAt: event.createdAt,
    type: event.type,
    source: event.source,
    actor: event.actor || event.source,
    role: event.role || "primary",
    taskId: event.taskId,
    parentTaskId: event.parentTaskId,
    project: event.project || "global",
    summary:
      event.summary ||
      extractPayloadText(event.payload, ["message", "content", "title"]),
    reasoning: extractReasoning(event.payload),
    artifacts: event.artifacts,
    tags: event.tags,
    payloadPreview: buildPayloadPreview(event.payload),
  }));
}

function extractReasoning(payload: unknown): string {
  const value = extractPayloadText(payload, [
    "reasoningSummary",
    "reasoning_summary",
    "rationale",
    "decisionReason",
    "decision_reason",
    "plan",
    "nextStep",
    "next_step",
    "traceSummary",
    "trace_summary",
    "visibleReasoning",
    "visible_reasoning",
  ]);
  return clipText(value, 900);
}

function extractPayloadText(payload: unknown, keys: string[]): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const text = value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
        .join("\n");
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function buildPayloadPreview(payload: unknown): string {
  if (payload === undefined) {
    return "";
  }
  return clipText(JSON.stringify(payload, null, 2), 1200);
}

function clipText(value: string, maxLength: number): string {
  const clean = value.trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function countRows(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return Number(row.count || 0);
}

function mapMemory(row: MemoryRow): V2Memory {
  return {
    id: row.id,
    kind: row.kind,
    project: row.project,
    title: row.title,
    body: row.body,
    tags: parseStringArray(row.tags_json),
    sourceEventIds: parseNumberArray(row.source_event_ids_json),
    confidence: row.confidence,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSearchResult(row: SearchRow, query?: string): V2SearchResult {
  const tags = parseStringArray(row.tags_json);
  return {
    id: row.id,
    kind: row.kind,
    project: row.project,
    title: row.title,
    snippet: buildSnippet(row.body, query),
    tags,
    confidence: row.confidence,
    pinned: row.pinned === 1,
    score:
      row.score === null
        ? row.confidence
        : Math.max(0, 100 - Math.abs(row.score)),
    createdAt: row.created_at,
  };
}

function mapEdge(row: EdgeRow): V2GraphEdge {
  return {
    id: row.id,
    createdAt: row.created_at,
    fromType: row.from_type,
    fromId: row.from_id,
    toType: row.to_type,
    toId: row.to_id,
    relation: row.relation,
    weight: row.weight,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
  };
}

function renderContextLines(
  mode: V2ContextMode,
  results: V2SearchResult[],
): string[] {
  if (results.length === 0) {
    return [
      "<retentia-v2-context>",
      "No matching memory.",
      "</retentia-v2-context>",
    ];
  }

  if (mode === "ids") {
    return [
      '<retentia-v2-context mode="ids">',
      ...results.map(
        (result) =>
          `#${result.id} ${result.kind} ${result.project} ${result.title}`,
      ),
      "</retentia-v2-context>",
    ];
  }

  const lines = [`<retentia-v2-context mode=\"${mode}\">`];
  for (const result of results) {
    if (mode === "brief") {
      lines.push(
        `- #${result.id} [${result.kind}] ${result.title}: ${result.snippet}`,
      );
      continue;
    }

    lines.push(`## #${result.id} ${result.title}`);
    lines.push(
      `kind=${result.kind} project=${result.project} confidence=${result.confidence}`,
    );
    if (result.tags.length > 0) {
      lines.push(`tags=${result.tags.join(",")}`);
    }
    lines.push(result.snippet);

    if (mode === "full-evidence") {
      lines.push(`source-memory-id=${result.id}`);
    }
  }

  lines.push("</retentia-v2-context>");
  return lines;
}

function fitLines(
  lines: string[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const kept: string[] = [];
  let used = 0;
  let truncated = false;

  for (const line of lines) {
    const next = kept.length === 0 ? line.length : line.length + 1;
    if (used + next > maxChars) {
      truncated = true;
      break;
    }
    kept.push(line);
    used += next;
  }

  if (truncated && kept.length > 0) {
    const marker = "[truncated]";
    if (used + marker.length + 1 <= maxChars) {
      kept.push(marker);
    }
  }

  return { text: kept.join("\n"), truncated };
}

function defaultLimitForMode(mode: V2ContextMode): number {
  if (mode === "ids") {
    return 20;
  }
  if (mode === "full-evidence") {
    return 5;
  }
  return 8;
}

function buildSnippet(body: string, query?: string): string {
  const tokens = tokenize(query);
  const normalized = body.replace(/\s+/g, " ").trim();
  if (tokens.length === 0) {
    return clip(normalized, 180);
  }

  const lower = normalized.toLowerCase();
  const firstIndex = tokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  if (firstIndex === undefined) {
    return clip(normalized, 180);
  }

  const start = Math.max(0, firstIndex - 50);
  const prefix = start > 0 ? "..." : "";
  return `${prefix}${clip(normalized.slice(start), 180)}`;
}

function buildFtsQuery(query?: string): string | undefined {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens.map((token) => `${token}*`).join(" OR ");
}

function tokenize(value?: string): string[] {
  return [
    ...new Set(
      (value || "")
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ];
}

function cleanRequired(value: string | undefined, fallback: string): string {
  const cleaned = value?.trim();
  return cleaned || fallback;
}

function cleanOptional(value?: string): string | null {
  const cleaned = value?.trim();
  return cleaned || null;
}

function cleanList(values?: string[]): string[] {
  return [
    ...new Set((values || []).map((value) => value.trim()).filter(Boolean)),
  ];
}

function cleanNumberList(values?: number[]): number[] {
  return [
    ...new Set(
      (values || []).filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseNumberArray(json: string): number[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => Number.isInteger(item))
      : [];
  } catch {
    return [];
  }
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (part) => `\\${part}`);
}

function clip(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.floor(clamp(Number.isFinite(value) ? value : min, min, max));
}
