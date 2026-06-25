export type ObservationType =
  | "bugfix"
  | "feature"
  | "refactor"
  | "discovery"
  | "decision"
  | "change"
  | "note";

export type EntryKind = "observation" | "summary";

export interface BaseEntry {
  id: number;
  kind: EntryKind;
  project: string;
  sessionId?: string;
  externalKey?: string;
  createdAt: string;
  tags: string[];
}

export interface ObservationEntry extends BaseEntry {
  kind: "observation";
  observationType: ObservationType;
  title: string;
  content: string;
  files: string[];
}

export interface SummaryEntry extends BaseEntry {
  kind: "summary";
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  nextSteps: string;
  filesRead: string[];
  filesEdited: string[];
}

export type MemoryEntry = ObservationEntry | SummaryEntry;

export interface MemoryData {
  version: 1;
  lastId: number;
  entries: MemoryEntry[];
}

export interface AddObservationInput {
  project?: string;
  sessionId?: string;
  externalKey?: string;
  observationType?: ObservationType;
  title: string;
  content: string;
  tags?: string[];
  files?: string[];
}

export interface AddSummaryInput {
  project?: string;
  sessionId?: string;
  externalKey?: string;
  request?: string;
  investigated?: string;
  learned: string;
  completed?: string;
  nextSteps?: string;
  filesRead?: string[];
  filesEdited?: string[];
  tags?: string[];
}

export interface SearchOptions {
  query?: string;
  project?: string;
  kind?: EntryKind;
  since?: string;
  until?: string;
  limit?: number;
}

export interface ListEntriesOptions {
  project?: string;
  kind?: EntryKind;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  id: number;
  kind: EntryKind;
  project: string;
  title: string;
  excerpt: string;
  createdAt: string;
  score: number;
}

export interface TimelineOptions {
  id?: number;
  query?: string;
  project?: string;
  before?: number;
  after?: number;
}

export interface TimelineResult {
  anchorId: number;
  entries: MemoryEntry[];
}

export type IoTraceOp =
  | "w_obs"
  | "w_sum"
  | "q_search"
  | "q_timeline"
  | "r_entries"
  | "r_context"
  | "r_projects";

export interface IoTraceEntry {
  id: number;
  createdAt: string;
  source: string;
  op: IoTraceOp;
  req: string;
  res: string;
}

export interface ListIoTraceOptions {
  source?: string;
  op?: IoTraceOp;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryKpis {
  entriesTotal: number;
  observationsTotal: number;
  summariesTotal: number;
  projectsTotal: number;
  latestEntryAt?: string;
  oldestEntryAt?: string;
}

export type TaskStatus = "completed" | "failed" | "running" | "unknown";

export interface ExecutionReportTask {
  id: number;
  kind: EntryKind;
  project: string;
  sessionId?: string;
  createdAt: string;
  title: string;
  excerpt: string;
  provider: string;
  model: string;
  agent: string;
  role: string;
  pipeline: string;
  status: TaskStatus;
  taskId?: string;
  sourceFile?: string;
  tags: string[];
}

export interface ExecutionReportCount {
  key: string;
  count: number;
}

export interface ExecutionReportProjectSummary {
  project: string;
  total: number;
  completed: number;
  failed: number;
  providers: string[];
  agents: string[];
  models: string[];
  latestAt?: string;
}

export interface ExecutionTrendBucket {
  key: string;
  count: number;
  completed: number;
  failed: number;
  delta: number;
}

export interface ExecutionReportTrends {
  daily: ExecutionTrendBucket[];
  weekly: ExecutionTrendBucket[];
}

export interface ExecutionReport {
  total: number;
  projects: ExecutionReportProjectSummary[];
  providers: ExecutionReportCount[];
  agents: ExecutionReportCount[];
  models: ExecutionReportCount[];
  statuses: ExecutionReportCount[];
  trends: ExecutionReportTrends;
  tasks: ExecutionReportTask[];
}
