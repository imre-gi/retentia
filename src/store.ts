import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type {
  AddObservationInput,
  AddSummaryInput,
  IoTraceEntry,
  IoTraceOp,
  ListEntriesOptions,
  ListIoTraceOptions,
  MemoryKpis,
  MemoryEntry,
  ObservationEntry,
  SearchOptions,
  SearchResult,
  SummaryEntry,
  TimelineOptions,
  TimelineResult
} from "./types.js";

const PRIMARY_DATA_DIR = join(homedir(), ".retentia");
const PRIMARY_DB_FILE = join(PRIMARY_DATA_DIR, "retentia.db");
const MAX_SEARCH_LIMIT = 100;
const MAX_LIST_LIMIT = 2000;

interface EntryRow {
  id: number;
  kind: "observation" | "summary";
  project: string;
  session_id: string | null;
  external_key: string | null;
  created_at: string;
  tags_json: string;
  observation_type: string | null;
  title: string | null;
  content: string | null;
  files_json: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read_json: string | null;
  files_edited_json: string | null;
}

interface KpiRow {
  entries_total: number;
  observations_total: number | null;
  summaries_total: number | null;
  projects_total: number;
  latest_entry_at: string | null;
  oldest_entry_at: string | null;
}

interface IoTraceRow {
  id: number;
  created_at: string;
  source: string;
  op: IoTraceOp;
  req: string;
  res: string;
}

export class MemoryStore {
  private readonly dbFile: string;
  private readonly cwd: string;
  private readonly db: Database.Database;

  constructor(dbFile?: string, cwd?: string) {
    this.dbFile =
      dbFile ||
      process.env.RETENTIA_DB_FILE ||
      process.env.RETENTIA_DATA_FILE ||
      PRIMARY_DB_FILE;
    this.cwd = cwd || process.cwd();

    mkdirSync(dirname(this.dbFile), { recursive: true });
    this.db = new Database(this.dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.initializeSchema();
  }

  getDataFilePath(): string {
    return this.dbFile;
  }

  close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }

  addObservation(input: AddObservationInput): ObservationEntry {
    const createdAt = new Date().toISOString();
    const project = this.resolveProject(input.project);
    const sessionId = this.cleanOptional(input.sessionId) || null;
    const externalKey = this.cleanOptional(input.externalKey) || null;
    const tags = this.cleanList(input.tags);
    const files = this.cleanList(input.files);

    const info = this.db
      .prepare(
        `
      INSERT INTO entries (
        kind,
        project,
        session_id,
        external_key,
        created_at,
        tags_json,
        observation_type,
        title,
        content,
        files_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        "observation",
        project,
        sessionId,
        externalKey,
        createdAt,
        JSON.stringify(tags),
        input.observationType || "note",
        this.requireText(input.title, "title"),
        this.requireText(input.content, "content"),
        JSON.stringify(files)
      );

    return {
      id: Number(info.lastInsertRowid),
      kind: "observation",
      project,
      sessionId: sessionId || undefined,
      externalKey: externalKey || undefined,
      createdAt,
      tags,
      observationType: (input.observationType || "note") as ObservationEntry["observationType"],
      title: this.requireText(input.title, "title"),
      content: this.requireText(input.content, "content"),
      files
    };
  }

  addSummary(input: AddSummaryInput): SummaryEntry {
    const createdAt = new Date().toISOString();
    const project = this.resolveProject(input.project);
    const sessionId = this.cleanOptional(input.sessionId) || null;
    const externalKey = this.cleanOptional(input.externalKey) || null;
    const tags = this.cleanList(input.tags);
    const filesRead = this.cleanList(input.filesRead);
    const filesEdited = this.cleanList(input.filesEdited);

    const request = this.cleanOptional(input.request) || "";
    const investigated = this.cleanOptional(input.investigated) || "";
    const learned = this.requireText(input.learned, "learned");
    const completed = this.cleanOptional(input.completed) || "";
    const nextSteps = this.cleanOptional(input.nextSteps) || "";

    const info = this.db
      .prepare(
        `
      INSERT INTO entries (
        kind,
        project,
        session_id,
        external_key,
        created_at,
        tags_json,
        request,
        investigated,
        learned,
        completed,
        next_steps,
        files_read_json,
        files_edited_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        "summary",
        project,
        sessionId,
        externalKey,
        createdAt,
        JSON.stringify(tags),
        request,
        investigated,
        learned,
        completed,
        nextSteps,
        JSON.stringify(filesRead),
        JSON.stringify(filesEdited)
      );

    return {
      id: Number(info.lastInsertRowid),
      kind: "summary",
      project,
      sessionId: sessionId || undefined,
      externalKey: externalKey || undefined,
      createdAt,
      tags,
      request,
      investigated,
      learned,
      completed,
      nextSteps,
      filesRead,
      filesEdited
    };
  }

  getEntries(ids: number[]): MemoryEntry[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM entries WHERE id IN (${placeholders})`)
      .all(...ids) as EntryRow[];

    const byId = new Map(rows.map((row) => [row.id, this.mapRow(row)]));
    return ids
      .map((id) => byId.get(id))
      .filter((entry): entry is MemoryEntry => Boolean(entry));
  }

  listEntries(options: ListEntriesOptions = {}): MemoryEntry[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.project) {
      clauses.push("project = ?");
      params.push(options.project);
    }

    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }

    if (options.since) {
      clauses.push("created_at >= ?");
      params.push(options.since);
    }

    if (options.until) {
      clauses.push("created_at <= ?");
      params.push(options.until);
    }

    const limit = this.resolveListLimit(options.limit);
    const offset = this.resolveOffset(options.offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM entries ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as EntryRow[];

    return rows.map((row) => this.mapRow(row));
  }

  hasExternalKey(externalKey: string): boolean {
    const normalized = this.cleanOptional(externalKey);
    if (!normalized) {
      return false;
    }

    const row = this.db
      .prepare("SELECT id FROM entries WHERE external_key = ? LIMIT 1")
      .get(normalized) as { id: number } | undefined;
    return Boolean(row?.id);
  }

  search(options: SearchOptions): SearchResult[] {
    const limit = this.resolveSearchLimit(options.limit);
    const tokens = this.tokenize(options.query);
    const rows = this.fetchFilteredRows(options);

    return rows
      .map((row) => this.mapRow(row))
      .map((entry) => {
        const score = this.scoreEntry(entry, tokens);
        return {
          id: entry.id,
          kind: entry.kind,
          project: entry.project,
          title: this.getEntryTitle(entry),
          excerpt: this.getExcerpt(entry),
          createdAt: entry.createdAt,
          score
        } satisfies SearchResult;
      })
      .filter((result) => (tokens.length > 0 ? result.score > 0 : true))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }

        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, limit);
  }

  timeline(options: TimelineOptions): TimelineResult {
    const rows = this.db
      .prepare("SELECT * FROM entries ORDER BY created_at ASC, id ASC")
      .all() as EntryRow[];

    if (rows.length === 0) {
      throw new Error("No memory entries exist yet.");
    }

    const entries = rows.map((row) => this.mapRow(row));
    const anchorId = this.resolveAnchorId(entries, options);
    const anchorIndex = entries.findIndex((entry) => entry.id === anchorId);

    if (anchorIndex < 0) {
      throw new Error(`Entry #${anchorId} not found.`);
    }

    const before = this.resolveWindow(options.before, 5);
    const after = this.resolveWindow(options.after, 5);
    const start = Math.max(0, anchorIndex - before);
    const end = Math.min(entries.length, anchorIndex + after + 1);

    return {
      anchorId,
      entries: entries.slice(start, end)
    };
  }

  listProjects(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT project FROM entries ORDER BY project ASC")
      .all() as Array<{ project: string }>;
    return rows.map((row) => row.project);
  }

  getKpis(): MemoryKpis {
    const row = this.db
      .prepare(
        `
      SELECT
        COUNT(*) AS entries_total,
        SUM(CASE WHEN kind = 'observation' THEN 1 ELSE 0 END) AS observations_total,
        SUM(CASE WHEN kind = 'summary' THEN 1 ELSE 0 END) AS summaries_total,
        COUNT(DISTINCT project) AS projects_total,
        MAX(created_at) AS latest_entry_at,
        MIN(created_at) AS oldest_entry_at
      FROM entries
    `
      )
      .get() as KpiRow | undefined;

    return {
      entriesTotal: Number(row?.entries_total || 0),
      observationsTotal: Number(row?.observations_total || 0),
      summariesTotal: Number(row?.summaries_total || 0),
      projectsTotal: Number(row?.projects_total || 0),
      latestEntryAt: row?.latest_entry_at || undefined,
      oldestEntryAt: row?.oldest_entry_at || undefined
    };
  }

  addIoTrace(input: {
    source?: string;
    op: IoTraceOp;
    req: unknown;
    res: unknown;
  }): IoTraceEntry {
    const createdAt = new Date().toISOString();
    const source = this.cleanOptional(input.source) || "unknown";
    const req = this.toCompactJson(input.req);
    const res = this.toCompactJson(input.res);
    const info = this.db
      .prepare(
        `
      INSERT INTO io_trace (
        created_at,
        source,
        op,
        req,
        res
      ) VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(createdAt, source, input.op, req, res);

    return {
      id: Number(info.lastInsertRowid),
      createdAt,
      source,
      op: input.op,
      req,
      res
    };
  }

  listIoTrace(options: ListIoTraceOptions = {}): IoTraceEntry[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.source) {
      clauses.push("source = ?");
      params.push(options.source);
    }

    if (options.op) {
      clauses.push("op = ?");
      params.push(options.op);
    }

    if (options.since) {
      clauses.push("created_at >= ?");
      params.push(options.since);
    }

    if (options.until) {
      clauses.push("created_at <= ?");
      params.push(options.until);
    }

    const limit = this.resolveListLimit(options.limit);
    const offset = this.resolveOffset(options.offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM io_trace ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as IoTraceRow[];

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      source: row.source,
      op: row.op,
      req: row.req,
      res: row.res
    }));
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary')),
        project TEXT NOT NULL,
        session_id TEXT,
        external_key TEXT,
        created_at TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        observation_type TEXT,
        title TEXT,
        content TEXT,
        files_json TEXT,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read_json TEXT,
        files_edited_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project);
      CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind);
      CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC);

      CREATE TABLE IF NOT EXISTS io_trace (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL,
        op TEXT NOT NULL,
        req TEXT NOT NULL,
        res TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_io_trace_created ON io_trace(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_io_trace_source ON io_trace(source);
      CREATE INDEX IF NOT EXISTS idx_io_trace_op ON io_trace(op);
    `);

    this.ensureColumnExists("external_key", "TEXT");
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_external_key_unique
        ON entries(external_key)
        WHERE external_key IS NOT NULL;
    `);
  }

  private fetchFilteredRows(options: SearchOptions): EntryRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.project) {
      clauses.push("project = ?");
      params.push(options.project);
    }

    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }

    if (options.since) {
      clauses.push("created_at >= ?");
      params.push(options.since);
    }

    if (options.until) {
      clauses.push("created_at <= ?");
      params.push(options.until);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM entries ${whereClause} ORDER BY created_at DESC, id DESC`)
      .all(...params) as EntryRow[];
  }

  private mapRow(row: EntryRow): MemoryEntry {
    const tags = this.parseJsonArray(row.tags_json);

    if (row.kind === "observation") {
      return {
        id: row.id,
        kind: "observation",
        project: row.project,
        sessionId: row.session_id || undefined,
        externalKey: row.external_key || undefined,
        createdAt: row.created_at,
        tags,
        observationType: (row.observation_type || "note") as ObservationEntry["observationType"],
        title: row.title || "",
        content: row.content || "",
        files: this.parseJsonArray(row.files_json)
      };
    }

    return {
      id: row.id,
      kind: "summary",
      project: row.project,
      sessionId: row.session_id || undefined,
      externalKey: row.external_key || undefined,
      createdAt: row.created_at,
      tags,
      request: row.request || "",
      investigated: row.investigated || "",
      learned: row.learned || "",
      completed: row.completed || "",
      nextSteps: row.next_steps || "",
      filesRead: this.parseJsonArray(row.files_read_json),
      filesEdited: this.parseJsonArray(row.files_edited_json)
    };
  }

  private parseJsonArray(raw: string | null): string[] {
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private ensureColumnExists(columnName: string, columnTypeSql: string): void {
    const tableInfo = this.db
      .prepare("PRAGMA table_info(entries)")
      .all() as Array<{ name: string }>;
    const hasColumn = tableInfo.some((column) => column.name === columnName);
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE entries ADD COLUMN ${columnName} ${columnTypeSql};`);
    }
  }

  private resolveProject(project?: string): string {
    const explicit = this.cleanOptional(project);
    if (explicit) {
      return explicit;
    }

    return basename(this.cwd);
  }

  private cleanOptional(value?: string): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
  }

  private cleanList(values?: string[]): string[] {
    if (!Array.isArray(values)) {
      return [];
    }

    const seen = new Set<string>();
    for (const value of values) {
      const normalized = value.trim();
      if (normalized) {
        seen.add(normalized);
      }
    }

    return [...seen];
  }

  private requireText(value: string, fieldName: string): string {
    const normalized = value?.trim();
    if (!normalized) {
      throw new Error(`${fieldName} is required.`);
    }

    return normalized;
  }

  private resolveSearchLimit(limit?: number): number {
    if (!limit || Number.isNaN(limit)) {
      return 10;
    }

    return Math.max(1, Math.min(limit, MAX_SEARCH_LIMIT));
  }

  private resolveListLimit(limit?: number): number {
    if (!limit || Number.isNaN(limit)) {
      return 250;
    }

    return Math.max(1, Math.min(limit, MAX_LIST_LIMIT));
  }

  private resolveOffset(offset?: number): number {
    if (offset === undefined || Number.isNaN(offset)) {
      return 0;
    }

    return Math.max(0, Math.floor(offset));
  }

  private resolveWindow(value: number | undefined, fallback: number): number {
    if (value === undefined || Number.isNaN(value)) {
      return fallback;
    }

    return Math.max(0, Math.min(value, 50));
  }

  private tokenize(query?: string): string[] {
    if (!query?.trim()) {
      return [];
    }

    return query
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  private scoreEntry(entry: MemoryEntry, tokens: string[]): number {
    if (tokens.length === 0) {
      return 1;
    }

    const title = this.getEntryTitle(entry).toLowerCase();
    const body = this.getSearchBody(entry).toLowerCase();
    let score = 0;

    for (const token of tokens) {
      if (title.includes(token)) {
        score += 10;
      }

      if (body.includes(token)) {
        score += 4;
      }

      if (entry.tags.some((tag) => tag.toLowerCase() === token)) {
        score += 6;
      }
    }

    return score;
  }

  private getSearchBody(entry: MemoryEntry): string {
    if (entry.kind === "observation") {
      return [
        entry.content,
        entry.observationType,
        ...entry.files,
        ...entry.tags
      ].join(" ");
    }

    return [
      entry.request,
      entry.investigated,
      entry.learned,
      entry.completed,
      entry.nextSteps,
      ...entry.filesRead,
      ...entry.filesEdited,
      ...entry.tags
    ].join(" ");
  }

  private getEntryTitle(entry: MemoryEntry): string {
    if (entry.kind === "observation") {
      return entry.title;
    }

    return entry.request || this.clip(entry.learned, 80);
  }

  private getExcerpt(entry: MemoryEntry): string {
    if (entry.kind === "observation") {
      return this.clip(entry.content, 220);
    }

    const sections = [entry.learned, entry.completed, entry.nextSteps]
      .map((part) => part.trim())
      .filter(Boolean);

    return this.clip(sections.join(" | "), 220);
  }

  private clip(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
      return value;
    }

    return `${value.slice(0, maxChars - 1)}…`;
  }

  private resolveAnchorId(entries: MemoryEntry[], options: TimelineOptions): number {
    if (options.id !== undefined) {
      return options.id;
    }

    const [firstMatch] = this.search({
      query: options.query,
      project: options.project,
      limit: 1
    });

    if (!firstMatch) {
      throw new Error("Could not resolve timeline anchor. Provide an id or query.");
    }

    return firstMatch.id;
  }

  private toCompactJson(value: unknown): string {
    if (typeof value === "string") {
      return value.trim();
    }

    if (value === undefined) {
      return "{}";
    }

    try {
      return JSON.stringify(value) || "{}";
    } catch {
      return JSON.stringify({ error: "unserializable" });
    }
  }
}
