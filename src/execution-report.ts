import type {
  ExecutionReport,
  ExecutionReportCount,
  ExecutionReportProjectSummary,
  ExecutionReportTask,
  ExecutionReportTrends,
  MemoryEntry,
  TaskStatus
} from "./types.js";

interface ExecutionMetadata {
  provider: string;
  model: string;
  agent: string;
  role: string;
  pipeline: string;
  status: TaskStatus;
  taskId?: string;
  sourceFile?: string;
}

const DEFAULT_PROVIDER = "unknown";
const DEFAULT_MODEL = "unknown";
const DEFAULT_AGENT = "unassigned";
const DEFAULT_ROLE = "unassigned";
const DEFAULT_PIPELINE = "none";
const DAY_MS = 24 * 60 * 60 * 1000;

export function buildExecutionReport(entries: MemoryEntry[]): ExecutionReport {
  const tasks = entries.map((entry) => mapTask(entry));
  const projects = buildProjectSummaries(tasks);

  return {
    total: tasks.length,
    projects,
    providers: toCountList(tasks.map((task) => task.provider)),
    agents: toCountList(tasks.map((task) => task.agent)),
    models: toCountList(tasks.map((task) => task.model)),
    statuses: toCountList(tasks.map((task) => task.status)),
    trends: buildExecutionTrends(tasks),
    tasks
  };
}

export function mapTask(entry: MemoryEntry): ExecutionReportTask {
  const metadata = extractExecutionMetadata(entry);
  return {
    id: entry.id,
    kind: entry.kind,
    project: entry.project,
    sessionId: entry.sessionId,
    createdAt: entry.createdAt,
    title: getEntryTitle(entry),
    excerpt: getExcerpt(entry),
    provider: metadata.provider,
    model: metadata.model,
    agent: metadata.agent,
    role: metadata.role,
    pipeline: metadata.pipeline,
    status: metadata.status,
    taskId: metadata.taskId,
    sourceFile: metadata.sourceFile,
    tags: entry.tags
  };
}

export function extractExecutionMetadata(entry: MemoryEntry): ExecutionMetadata {
  const tagMap = new Map<string, string>();
  for (const tag of entry.tags) {
    const separator = tag.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const key = tag.slice(0, separator).trim().toLowerCase();
    const value = tag.slice(separator + 1).trim();
    if (!key || !value) {
      continue;
    }

    tagMap.set(key, value);
  }

  const contentMap = new Map<string, string>();
  if (entry.kind === "observation") {
    for (const line of entry.content.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        continue;
      }
      const key = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (!key || !value) {
        continue;
      }
      contentMap.set(key, value);
    }
  }

  const provider =
    normalizeLower(tagMap.get("provider")) ||
    normalizeLower(tagMap.get("source")) ||
    normalizeLower(contentMap.get("provider")) ||
    DEFAULT_PROVIDER;
  const model =
    normalizeLower(tagMap.get("model")) ||
    normalizeLower(contentMap.get("model")) ||
    DEFAULT_MODEL;
  const agent =
    normalizeLower(tagMap.get("agent")) ||
    normalizeLower(contentMap.get("agent")) ||
    DEFAULT_AGENT;
  const role =
    normalizeLower(tagMap.get("role")) ||
    normalizeLower(contentMap.get("agent role")) ||
    DEFAULT_ROLE;
  const pipeline =
    normalizeLower(tagMap.get("pipeline")) ||
    normalizeLower(contentMap.get("pipeline")) ||
    entry.sessionId ||
    DEFAULT_PIPELINE;

  const rawStatus =
    normalizeLower(tagMap.get("status")) ||
    normalizeLower(contentMap.get("status")) ||
    "unknown";
  const status: TaskStatus =
    rawStatus === "completed" || rawStatus === "failed" || rawStatus === "running"
      ? rawStatus
      : "unknown";

  return {
    provider,
    model,
    agent,
    role,
    pipeline,
    status,
    taskId: tagMap.get("task") || contentMap.get("task id") || undefined,
    sourceFile:
      tagMap.get("source_file") ||
      tagMap.get("source-file") ||
      contentMap.get("source file") ||
      undefined
  };
}

function buildProjectSummaries(tasks: ExecutionReportTask[]): ExecutionReportProjectSummary[] {
  const byProject = new Map<string, ExecutionReportTask[]>();
  for (const task of tasks) {
    if (!byProject.has(task.project)) {
      byProject.set(task.project, []);
    }
    byProject.get(task.project)?.push(task);
  }

  const summaries: ExecutionReportProjectSummary[] = [];
  for (const [project, projectTasks] of byProject.entries()) {
    const latestAt = [...projectTasks]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      ?.createdAt;

    summaries.push({
      project,
      total: projectTasks.length,
      completed: projectTasks.filter((task) => task.status === "completed").length,
      failed: projectTasks.filter((task) => task.status === "failed").length,
      providers: unique(projectTasks.map((task) => task.provider)),
      agents: unique(projectTasks.map((task) => task.agent)),
      models: unique(projectTasks.map((task) => task.model)),
      latestAt
    });
  }

  return summaries.sort((left, right) => right.total - left.total);
}

function buildExecutionTrends(tasks: ExecutionReportTask[]): ExecutionReportTrends {
  return {
    daily: buildTrendBuckets(tasks, "daily", 14),
    weekly: buildTrendBuckets(tasks, "weekly", 8)
  };
}

function buildTrendBuckets(
  tasks: ExecutionReportTask[],
  grain: "daily" | "weekly",
  bucketCount: number
): ExecutionReportTrends["daily"] {
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
      failed: 0
    });
  }

  for (const task of tasks) {
    const timestampMs = Date.parse(task.createdAt);
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

function resolveTrendAnchorMs(tasks: ExecutionReportTask[]): number {
  const latest = tasks
    .map((task) => Date.parse(task.createdAt))
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => right - left)[0];
  return latest ?? Date.now();
}

function startOfUtcDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
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
  const week =
    Math.floor((startOfUtcWeek(timestampMs) - firstWeekStart) / (7 * DAY_MS)) +
    1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function toCountList(values: string[]): ExecutionReportCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.key.localeCompare(right.key);
    });
}

function getEntryTitle(entry: MemoryEntry): string {
  if (entry.kind === "observation") {
    return entry.title;
  }

  return entry.request || clip(entry.learned, 80);
}

function getExcerpt(entry: MemoryEntry): string {
  if (entry.kind === "observation") {
    return clip(entry.content, 220);
  }

  const sections = [entry.learned, entry.completed, entry.nextSteps]
    .map((part) => part.trim())
    .filter(Boolean);

  return clip(sections.join(" | "), 220);
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 1)}…`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeLower(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}
