export type V2EventType =
  | "message"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "tool_call"
  | "file_change"
  | "decision"
  | "error"
  | "memory_used"
  | "observation";

export type V2MemoryKind =
  | "episode"
  | "fact"
  | "decision"
  | "preference"
  | "procedure"
  | "constraint"
  | "artifact"
  | "todo";

export type V2ContextMode = "ids" | "brief" | "task-primer" | "full-evidence";

export type V2HealthStatus = "pass" | "warn" | "fail";

export interface V2EventInput {
  type: V2EventType | string;
  source: string;
  actor?: string;
  role?: string;
  taskId?: string;
  parentTaskId?: string;
  project?: string;
  summary?: string;
  tags?: string[];
  artifacts?: string[];
  payload?: unknown;
  createdAt?: string;
}

export interface V2Event extends Required<Omit<V2EventInput, "payload">> {
  id: number;
  payload?: unknown;
}

export interface V2ImportedEventResult {
  event: V2Event;
  imported: boolean;
  externalKey: string;
}

export interface V2MemoryInput {
  kind: V2MemoryKind;
  title: string;
  body: string;
  project?: string;
  tags?: string[];
  sourceEventIds?: number[];
  confidence?: number;
  pinned?: boolean;
  createdAt?: string;
}

export interface V2Memory {
  id: number;
  kind: V2MemoryKind;
  project: string;
  title: string;
  body: string;
  tags: string[];
  sourceEventIds: number[];
  confidence: number;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface V2EvidenceInput {
  sourceType: string;
  sourceId: string;
  content: string;
  project?: string;
  uri?: string;
  offsetStart?: number;
  offsetEnd?: number;
  metadata?: unknown;
  redact?: boolean;
  createdAt?: string;
}

export interface V2EvidenceChunk {
  id: number;
  createdAt: string;
  sourceType: string;
  sourceId: string;
  project: string;
  uri: string;
  offsetStart: number;
  offsetEnd: number;
  content: string;
  contentHash: string;
  redacted: boolean;
  metadata?: unknown;
}

export interface V2EvidenceSearchOptions {
  query?: string;
  project?: string;
  sourceType?: string;
  sourceId?: string;
  limit?: number;
}

export interface V2EvidenceSearchResult extends V2EvidenceChunk {
  snippet: string;
  score: number;
}

export interface V2GraphEdgeInput {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relation: string;
  weight?: number;
  metadata?: unknown;
  createdAt?: string;
}

export interface V2GraphEdge extends Required<
  Omit<V2GraphEdgeInput, "metadata">
> {
  id: number;
  metadata?: unknown;
}

export interface V2SearchOptions {
  query?: string;
  project?: string;
  kind?: V2MemoryKind;
  tags?: string[];
  limit?: number;
}

export interface V2SearchResult {
  id: number;
  kind: V2MemoryKind;
  project: string;
  title: string;
  snippet: string;
  tags: string[];
  confidence: number;
  pinned: boolean;
  score: number;
  createdAt: string;
}

export interface V2ContextOptions extends V2SearchOptions {
  mode?: V2ContextMode;
  maxChars?: number;
}

export interface V2ContextPack {
  mode: V2ContextMode;
  maxChars: number;
  usedChars: number;
  truncated: boolean;
  memoryIds: number[];
  text: string;
}

export interface V2HealthCheck {
  name: string;
  status: V2HealthStatus;
  summary: string;
  details?: unknown;
  recommendation?: string;
}

export interface V2HealthReport {
  ok: boolean;
  status: V2HealthStatus;
  generatedAt: string;
  dataFile: string;
  checks: V2HealthCheck[];
  totals: {
    events: number;
    memories: number;
    graphEdges: number;
    imports: number;
    evidenceChunks: number;
  };
}

export interface V2DashboardAgent {
  id: string;
  source: string;
  role: string;
  status: string;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
  lastSeenAt: string;
}

export interface V2DashboardTask {
  id: string;
  title: string;
  description: string;
  reasoning: string;
  source: string;
  actor: string;
  role: string;
  status: string;
  project: string;
  parentTaskId: string;
  latestEventType: string;
  eventCount: number;
  lastSeenAt: string;
}

export interface V2DashboardActivity {
  id: number;
  createdAt: string;
  type: string;
  source: string;
  actor: string;
  role: string;
  taskId: string;
  parentTaskId: string;
  project: string;
  summary: string;
  reasoning: string;
  artifacts: string[];
  tags: string[];
  payloadPreview: string;
}

export interface V2TrendBucket {
  key: string;
  count: number;
  completed: number;
  failed: number;
  delta: number;
}

export interface V2DashboardTrends {
  daily: V2TrendBucket[];
  weekly: V2TrendBucket[];
}

export interface V2DashboardData {
  generatedAt: string;
  dataFile: string;
  totals: {
    events: number;
    memories: number;
      graphEdges: number;
      evidenceChunks: number;
      agents: number;
    tasks: number;
    projects: number;
  };
  agents: V2DashboardAgent[];
  tasks: V2DashboardTask[];
  trends: V2DashboardTrends;
  activities: V2DashboardActivity[];
  memories: V2Memory[];
  edges: V2GraphEdge[];
  recentEvents: V2Event[];
  contextPreview: V2ContextPack;
}
