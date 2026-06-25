import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import * as vscode from "vscode";

interface JsonResult {
  [key: string]: unknown;
}

interface CliResolution {
  command: string;
  baseArgs: string[];
}

interface DashboardTask {
  id?: number;
  kind: string;
  title: string;
  excerpt: string;
  createdAt: string;
}

interface DashboardDbEntry {
  id: number;
  kind: string;
  project: string;
  createdAt: string;
  title: string;
  observationType: string;
  tagsCount: number;
}

interface DashboardIoTraceEvent {
  id: number;
  createdAt: string;
  source: string;
  op: string;
  req: string;
  res: string;
}

interface DashboardTrendBucket {
  key: string;
  count: number;
  completed: number;
  failed: number;
  delta: number;
}

interface LiveAgentSnapshot {
  id: string;
  nickname: string;
  role: string;
  status: "active" | "completed";
  lastSeenAt: string;
  source: string;
  sessionFile: string;
}

interface DashboardData {
  generatedAt: string;
  dataFile: string;
  worker: {
    running: boolean;
    pid?: number;
    uptimeSeconds?: number;
    baseUrl: string;
    host: string;
    port?: number;
  };
  mcp: {
    configured: boolean;
    command: string;
    args: string[];
    configPath: string;
  };
  kpis: {
    entriesTotal: number;
    observationsTotal: number;
    summariesTotal: number;
    projectsTotal: number;
    latestEntryAt?: string;
    oldestEntryAt?: string;
  };
  ingestion: {
    autoSyncEnabled: boolean;
    detectedTasks: number;
    importedTasks: number;
    skippedTasks: number;
    failedTasks: number;
    newestTaskAt?: string;
    byProvider: Array<{
      provider: string;
      detected: number;
      imported: number;
      skipped: number;
      failed: number;
    }>;
  };
  execution: {
    total: number;
    projects: Array<{
      project: string;
      total: number;
      completed: number;
      failed: number;
      providers: string[];
      agents: string[];
      models: string[];
      latestAt?: string;
    }>;
    providers: Array<{ key: string; count: number }>;
    agents: Array<{ key: string; count: number }>;
    models: Array<{ key: string; count: number }>;
    statuses: Array<{ key: string; count: number }>;
    trends: {
      daily: DashboardTrendBucket[];
      weekly: DashboardTrendBucket[];
    };
    tasks: Array<{
      id: number;
      kind: string;
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
      status: string;
      taskId?: string;
      sourceFile?: string;
      tags: string[];
    }>;
  };
  db: {
    sampleSize: number;
    entriesLast24h: number;
    activeProjects: number;
    avgTagsPerEntry: number;
    summaryRatio: number;
    latestEntries: DashboardDbEntry[];
    kindCounts: Array<{ key: string; count: number }>;
    projectCounts: Array<{ key: string; count: number }>;
    observationTypeCounts: Array<{ key: string; count: number }>;
    dailyCounts: Array<{ key: string; count: number }>;
  };
  io: {
    sampleSize: number;
    sourceCounts: Array<{ key: string; count: number }>;
    operationCounts: Array<{ key: string; count: number }>;
    latestEvents: DashboardIoTraceEvent[];
  };
  liveAgents: LiveAgentSnapshot[];
  recentTasks: DashboardTask[];
  error?: string;
}

interface TaskSyncMetrics {
  autoSyncEnabled: boolean;
  detectedTasks: number;
  importedTasks: number;
  skippedTasks: number;
  failedTasks: number;
  newestTaskAt?: string;
  byProvider: Array<{
    provider: string;
    detected: number;
    imported: number;
    skipped: number;
    failed: number;
  }>;
}

const OUTPUT = vscode.window.createOutputChannel("Retentia");
const DASHBOARD_VIEW_TYPE = "retentia.statusDashboard.view";
const QUICK_INPUT_VIEW_TYPE = "retentia.quickInput";
const DASHBOARD_TITLE = "Retentia Dashboard";
const INITIALIZED_DASHBOARD_PANELS = new WeakSet<vscode.WebviewPanel>();
const MCP_SERVER_SECTIONS = ["mcp_servers.retentia"];
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const DEFAULT_AUTO_SYNC_LOOKBACK_DAYS = 7;
const DEFAULT_AUTO_SYNC_MAX_IMPORT = 25;
const DEFAULT_AUTO_SYNC_MAX_FILES = 24;
const DEFAULT_EXECUTION_REPORT_LIMIT = 600;
const OBSERVATION_TYPES = new Set([
  "note",
  "bugfix",
  "feature",
  "refactor",
  "discovery",
  "decision",
  "change",
]);

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(OUTPUT);
  OUTPUT.appendLine("Retentia extension activated.");
  let dashboardPanel: vscode.WebviewPanel | undefined;
  const sidebarProvider = new QuickInputSidebarProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      QUICK_INPUT_VIEW_TYPE,
      sidebarProvider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.setup", async () => {
      await runAndShowJson(
        ["install", "--client", "codex"],
        "Retentia setup complete. MCP is available for Codex.",
      );
      await sidebarProvider.refreshStatus();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.enableMcp", async () => {
      await runAndShowJson(
        ["install", "--client", "codex"],
        "Retentia MCP registration completed.",
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.initStore", async () => {
      await runAndShowJson(["init"], "retentia store initialized");
      await sidebarProvider.refreshStatus();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.syncTasks", async () => {
      const metrics = await syncTaskExecutions({ force: true });
      OUTPUT.appendLine(`Task sync metrics: ${JSON.stringify(metrics)}`);
      vscode.window.showInformationMessage(
        `LLM task sync complete. Imported ${metrics.importedTasks} of ${metrics.detectedTasks} detected tasks.`,
      );
      await sidebarProvider.refreshStatus();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.doctor", async () => {
      const report = await runCliJson(["doctor"]);
      await openJsonDocument(report, "retentia-doctor.json");
      const status = toText(toRecord(report).status) || "unknown";
      vscode.window.showInformationMessage(`Retentia doctor: ${status}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.projectExplorer", async () => {
      await vscode.commands.executeCommand("retentia.statusDashboard");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.statusDashboard", async () => {
      if (!dashboardPanel) {
        dashboardPanel = vscode.window.createWebviewPanel(
          DASHBOARD_VIEW_TYPE,
          DASHBOARD_TITLE,
          vscode.ViewColumn.Active,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
          },
        );

        dashboardPanel.onDidDispose(() => {
          dashboardPanel = undefined;
        });

        dashboardPanel.webview.onDidReceiveMessage(
          async (message: unknown) => {
            if (!dashboardPanel) {
              return;
            }

            const cmd = toText(toRecord(message).command);
            if (!cmd) {
              return;
            }

            if (cmd === "refresh" || cmd === "live-refresh") {
              await renderDashboardPanel(dashboardPanel);
              return;
            }

            if (cmd === "setup") {
              await runAndShowJson(
                ["install", "--client", "codex"],
                "Retentia MCP registration completed for Codex.",
              );
              await renderDashboardPanel(dashboardPanel);
              return;
            }

            if (cmd === "sync-tasks") {
              const metrics = await syncTaskExecutions({ force: true });
              OUTPUT.appendLine(
                `Dashboard sync metrics: ${JSON.stringify(metrics)}`,
              );
              vscode.window.showInformationMessage(
                `LLM task sync complete. Imported ${metrics.importedTasks} task(s).`,
              );
              await renderDashboardPanel(dashboardPanel);
              return;
            }

            if (cmd === "doctor") {
              await vscode.commands.executeCommand("retentia.doctor");
              await renderDashboardPanel(dashboardPanel);
              return;
            }
          },
          undefined,
          context.subscriptions,
        );
      }

      dashboardPanel.reveal(vscode.ViewColumn.Active);
      await renderDashboardPanel(dashboardPanel);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.openSettings", async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${context.extension.id} retentia`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.addObservation", async () => {
      const title = await vscode.window.showInputBox({
        title: "Retentia: Observation Title",
        prompt: "Short title",
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim() ? undefined : "Title is required",
      });
      if (!title) {
        return;
      }

      const content = await vscode.window.showInputBox({
        title: "Retentia: Observation Content",
        prompt: "Detailed observation",
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim() ? undefined : "Content is required",
      });
      if (!content) {
        return;
      }

      const type = await vscode.window.showQuickPick(
        [
          "note",
          "bugfix",
          "feature",
          "refactor",
          "discovery",
          "decision",
          "change",
        ],
        {
          title: "Retentia: Observation Type",
          canPickMany: false,
          ignoreFocusOut: true,
        },
      );
      if (!type) {
        return;
      }

      const tags = await vscode.window.showInputBox({
        title: "Retentia: Tags (optional)",
        prompt: "Comma-separated tags",
        ignoreFocusOut: true,
      });

      const files = await vscode.window.showInputBox({
        title: "Retentia: Files (optional)",
        prompt: "Comma-separated file paths",
        ignoreFocusOut: true,
      });

      const result = await runCliJson(
        buildObservationArgs({
          title,
          content,
          type,
          project: getDefaultProject(),
          tags,
          files,
        }),
      );
      const id = typeof result.id === "number" ? `#${result.id}` : "entry";
      vscode.window.showInformationMessage(`Saved observation ${id}.`);
      await sidebarProvider.refreshStatus();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.addSummary", async () => {
      const learned = await vscode.window.showInputBox({
        title: "Retentia: Learned",
        prompt: "What was learned",
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim() ? undefined : "Learned is required",
      });
      if (!learned) {
        return;
      }

      const request = await vscode.window.showInputBox({
        title: "Retentia: Request (optional)",
        prompt: "Original request summary",
        ignoreFocusOut: true,
      });

      const completed = await vscode.window.showInputBox({
        title: "Retentia: Completed (optional)",
        prompt: "What was completed",
        ignoreFocusOut: true,
      });

      const nextSteps = await vscode.window.showInputBox({
        title: "Retentia: Next Steps (optional)",
        prompt: "What should happen next",
        ignoreFocusOut: true,
      });

      const result = await runCliJson(
        buildSummaryArgs({
          learned,
          request,
          completed,
          nextSteps,
          project: getDefaultProject(),
        }),
      );
      const id = typeof result.id === "number" ? `#${result.id}` : "entry";
      vscode.window.showInformationMessage(`Saved summary ${id}.`);
      await sidebarProvider.refreshStatus();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.search", async () => {
      const query = await vscode.window.showInputBox({
        title: "Retentia: Search",
        prompt: "Search query",
        ignoreFocusOut: true,
      });
      if (query === undefined) {
        return;
      }

      const args = ["search", "--limit", "30"];
      if (query.trim()) {
        args.push("--query", query.trim());
      }

      const project = getDefaultProject();
      if (project) {
        args.push("--project", project);
      }

      const result = await runCliJson(args);
      const results = Array.isArray(result.results)
        ? (result.results as JsonResult[])
        : [];

      if (results.length === 0) {
        vscode.window.showInformationMessage("No matching memory entries.");
        return;
      }

      const picks = results.map((item) => {
        const id = typeof item.id === "number" ? item.id : "?";
        const title = String(item.title ?? "(no title)");
        const detail = String(item.snippet ?? item.excerpt ?? "");
        return {
          label: `#${id} ${title}`,
          description: String(item.kind ?? ""),
          detail,
          id: Number(item.id),
        };
      });

      const picked = await vscode.window.showQuickPick(picks, {
        title: "Retentia: Search Results",
        placeHolder: "Select an entry to open details",
        ignoreFocusOut: true,
      });

      if (!picked || Number.isNaN(picked.id)) {
        return;
      }

      const entryResult = await runCliJson([
        "search",
        "--limit",
        "1",
        "--query",
        picked.label,
      ]);
      await openJsonDocument(entryResult, `retentia-entry-${picked.id}.json`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.contextPack", async () => {
      const query = await vscode.window.showInputBox({
        title: "Retentia: Context Pack Query",
        prompt: "Optional query",
        ignoreFocusOut: true,
      });
      if (query === undefined) {
        return;
      }

      const args = ["context", "--mode", "brief", "--max-chars", "1800"];
      if (query.trim()) {
        args.push("--query", query.trim());
      }

      const project = getDefaultProject();
      if (project) {
        args.push("--project", project);
      }

      const output = await runCliRaw(args);
      await openTextDocument(output, "markdown", "retentia-context.md");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("retentia.openMemoryFile", async () => {
      const init = await runCliJson(["init"]);
      const dataFile = String(init.dataFile ?? "");
      if (!dataFile) {
        vscode.window.showErrorMessage("Could not resolve memory file path.");
        return;
      }

      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(dataFile),
      );
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
  );
}

export function deactivate(): void {}

class QuickInputSidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getQuickInputSidebarHtml();

    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      await this.handleMessage(message);
    });

    await this.refreshStatus();
  }

  async refreshStatus(): Promise<void> {
    if (!this.view) {
      return;
    }

    try {
      const payload = toRecord(
        await runCliJson(["dashboard", "--limit", "20"]),
      );
      const totals = toRecord(payload.totals);
      this.view.webview.postMessage({
        command: "status",
        payload: {
          workerRunning: true,
          entriesTotal: toNumber(totals.memories) ?? 0,
          projectsTotal: toNumber(totals.projects) ?? 0,
          dataFile: toText(payload.dataFile) || "n/a",
          workerBaseUrl: "direct SQLite",
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.view.webview.postMessage({
        command: "error",
        payload: {
          message,
        },
      });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const root = toRecord(message);
    const command = toText(root.command);
    if (!command) {
      return;
    }

    const payload = toRecord(root.payload);

    try {
      if (command === "refresh-status") {
        await this.refreshStatus();
        return;
      }

      if (command === "open-dashboard") {
        await vscode.commands.executeCommand("retentia.statusDashboard");
        return;
      }

      if (command === "open-settings") {
        await vscode.commands.executeCommand("retentia.openSettings");
        return;
      }

      if (command === "setup") {
        await runAndShowJson(
          ["install", "--client", "codex"],
          "Retentia MCP registration completed for Codex.",
        );
        await this.refreshStatus();
        return;
      }

      if (command === "sync-tasks") {
        const metrics = await syncTaskExecutions({ force: true });
        vscode.window.showInformationMessage(
          `LLM task sync complete. Imported ${metrics.importedTasks} of ${metrics.detectedTasks} detected tasks.`,
        );
        await this.refreshStatus();
        return;
      }

      if (command === "doctor") {
        await vscode.commands.executeCommand("retentia.doctor");
        await this.refreshStatus();
        return;
      }

      if (command === "add-observation") {
        await this.addObservation(payload);
        await this.refreshStatus();
        return;
      }

      if (command === "add-summary") {
        await this.addSummary(payload);
        await this.refreshStatus();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(message);
      if (this.view) {
        this.view.webview.postMessage({
          command: "error",
          payload: { message },
        });
      }
    }
  }

  private async addObservation(payload: JsonResult): Promise<void> {
    const title = toText(payload.title)?.trim() || "";
    const content = toText(payload.content)?.trim() || "";
    if (!title || !content) {
      throw new Error("Observation title and content are required.");
    }

    const result = await runCliJson(
      buildObservationArgs({
        title,
        content,
        type: toText(payload.type),
        project: toText(payload.project),
        tags: toText(payload.tags),
        files: toText(payload.files),
      }),
    );

    const id = typeof result.id === "number" ? `#${result.id}` : "entry";
    vscode.window.showInformationMessage(`Saved observation ${id}.`);
    this.view?.webview.postMessage({ command: "clear-observation" });
  }

  private async addSummary(payload: JsonResult): Promise<void> {
    const learned = toText(payload.learned)?.trim() || "";
    if (!learned) {
      throw new Error("Summary learned field is required.");
    }

    const result = await runCliJson(
      buildSummaryArgs({
        learned,
        request: toText(payload.request),
        completed: toText(payload.completed),
        nextSteps: toText(payload.nextSteps),
        tags: toText(payload.tags),
        project: toText(payload.project),
      }),
    );

    const id = typeof result.id === "number" ? `#${result.id}` : "entry";
    vscode.window.showInformationMessage(`Saved summary ${id}.`);
    this.view?.webview.postMessage({ command: "clear-summary" });
  }
}

function getDefaultProject(): string | undefined {
  const explicit = vscode.workspace
    .getConfiguration("retentia")
    .get<string>("defaultProject", "")
    .trim();

  if (explicit) {
    return explicit;
  }

  return vscode.workspace.workspaceFolders?.[0]?.name;
}

function buildObservationArgs(input: {
  title: string;
  content: string;
  type?: string;
  project?: string;
  tags?: string;
  files?: string;
}): string[] {
  const normalizedType = (input.type || "note").trim().toLowerCase();
  const kind =
    normalizedType === "decision"
      ? "decision"
      : normalizedType === "discovery"
        ? "fact"
        : normalizedType === "bugfix"
          ? "procedure"
          : "episode";

  const args = [
    "memory",
    "--kind",
    kind,
    "--title",
    input.title.trim(),
    "--body",
    input.content.trim(),
  ];

  const project = input.project?.trim() || getDefaultProject();
  if (project) {
    args.push("--project", project);
  }

  if (input.tags?.trim()) {
    args.push("--tags", input.tags.trim());
  }

  const tags = [
    input.tags?.trim(),
    normalizedType ? `type:${normalizedType}` : "",
    input.files?.trim() ? `files:${input.files.trim()}` : "",
  ]
    .filter(Boolean)
    .join(",");
  if (tags) {
    args.push("--tags", tags);
  }

  return args;
}

function buildSummaryArgs(input: {
  learned: string;
  request?: string;
  completed?: string;
  nextSteps?: string;
  tags?: string;
  project?: string;
}): string[] {
  const body = [
    input.request?.trim() ? `Request: ${input.request.trim()}` : "",
    `Learned: ${input.learned.trim()}`,
    input.completed?.trim() ? `Completed: ${input.completed.trim()}` : "",
    input.nextSteps?.trim() ? `Next steps: ${input.nextSteps.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const title = input.request?.trim() || input.learned.trim().slice(0, 90);
  const args = [
    "memory",
    "--kind",
    "episode",
    "--title",
    title,
    "--body",
    body,
  ];
  const project = input.project?.trim() || getDefaultProject();

  if (project) {
    args.push("--project", project);
  }
  if (input.tags?.trim()) {
    args.push("--tags", input.tags.trim());
  }

  return args;
}

async function runAndShowJson(
  args: string[],
  successMessage: string,
): Promise<void> {
  const json = await runCliJson(args);
  OUTPUT.appendLine(JSON.stringify(json, null, 2));
  vscode.window.showInformationMessage(successMessage);
}

async function runCliJson(args: string[]): Promise<JsonResult> {
  const raw = await runCliRaw(args);
  try {
    return JSON.parse(raw) as JsonResult;
  } catch (error) {
    throw new Error(
      `Expected JSON from retentia, got: ${raw.slice(0, 280)}${
        raw.length > 280 ? "..." : ""
      }`,
    );
  }
}

async function runCliRaw(args: string[]): Promise<string> {
  const cwd =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const resolution = resolveCli(cwd);
  const finalArgs = [...resolution.baseArgs, ...args];

  OUTPUT.appendLine(`$ ${resolution.command} ${finalArgs.join(" ")}`);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(resolution.command, finalArgs, {
      cwd,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      const message = [
        `Failed to start retentia CLI: ${error.message}`,
        `Set 'retentia.cliPath' in VS Code settings, or ensure one of these exists:`,
        ...getAutoDetectCandidates(cwd).map((candidate) => `- ${candidate}`),
        `Or make sure 'retentia' is on PATH.`,
      ].join("\n");
      OUTPUT.appendLine(message);
      reject(new Error(message));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      const output = stderr || stdout;
      const hints: string[] = [];
      if (output.includes("NODE_MODULE_VERSION")) {
        hints.push(
          "Native module ABI mismatch detected.",
          "Run `npm rebuild better-sqlite3` in your Retentia project and reload VS Code.",
        );
      }

      const message = `retentia command failed (exit ${code}).\n${output}${
        hints.length ? `\n\n${hints.join("\n")}` : ""
      }`;
      OUTPUT.appendLine(message);
      reject(new Error(message));
    });
  });
}

function resolveCli(workspaceRoot: string): CliResolution {
  const configured = vscode.workspace
    .getConfiguration("retentia")
    .get<string>("cliPath", "")
    .trim();

  if (configured) {
    if (configured.endsWith(".js") || configured.endsWith(".mjs")) {
      const script = isAbsolute(configured)
        ? configured
        : join(workspaceRoot, configured);
      return { command: resolveNodeCommand(), baseArgs: [script] };
    }

    return { command: configured, baseArgs: [] };
  }

  const localScript = join(workspaceRoot, "dist", "cli.js");
  if (fileExists(localScript)) {
    return { command: resolveNodeCommand(), baseArgs: [localScript] };
  }

  for (const candidate of getAutoDetectCandidates(workspaceRoot)) {
    if (fileExists(candidate)) {
      return { command: resolveNodeCommand(), baseArgs: [candidate] };
    }
  }

  return { command: "retentia", baseArgs: [] };
}

function resolveNodeCommand(): string {
  // Prefer user/runtime Node over VS Code's embedded Node to avoid native ABI mismatches.
  return "node";
}

function getAutoDetectCandidates(workspaceRoot: string): string[] {
  const checkoutNames = ["retentia", "codex-mem"];
  const candidates = [
    join(workspaceRoot, "..", "dist", "cli.js"),
    ...checkoutNames.flatMap((checkoutName) => [
      join(workspaceRoot, checkoutName, "dist", "cli.js"),
      join(workspaceRoot, "..", checkoutName, "dist", "cli.js"),
      join(workspaceRoot, "..", "..", checkoutName, "dist", "cli.js"),
    ]),
  ];

  return [...new Set(candidates)];
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function openJsonDocument(
  payload: unknown,
  title: string,
): Promise<void> {
  await openTextDocument(JSON.stringify(payload, null, 2), "json", title);
}

async function openTextDocument(
  content: string,
  language: string,
  _title: string,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language,
    content,
  });

  await vscode.window.showTextDocument(document, { preview: false });
}

async function renderDashboardPanel(panel: vscode.WebviewPanel): Promise<void> {
  if (!INITIALIZED_DASHBOARD_PANELS.has(panel)) {
    panel.webview.html = getAgentDashboardHtml(
      createEmptyAgentDashboardData(),
      true,
    );
    INITIALIZED_DASHBOARD_PANELS.add(panel);
  }

  await pushDashboardPanelUpdate(panel);
}

async function pushDashboardPanelUpdate(
  panel: vscode.WebviewPanel,
): Promise<void> {
  try {
    const data = await collectAgentDashboardData();
    await panel.webview.postMessage({
      command: "dashboard-update",
      payload: buildAgentDashboardPayload(data),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    OUTPUT.appendLine(`Dashboard render failed: ${message}`);
    await panel.webview.postMessage({
      command: "dashboard-update",
      payload: buildAgentDashboardPayload(
        createEmptyAgentDashboardData(message),
        message,
      ),
    });
  }
}

async function collectAgentDashboardData(): Promise<JsonResult> {
  await syncTaskExecutions({ force: false });
  const dashboard = toRecord(
    await runCliJson([
      "dashboard",
      "--limit",
      String(getExecutionReportLimit()),
    ]),
  );
  const health = toRecord(await runCliJson(["doctor"]));
  return { ...dashboard, health };
}

function createEmptyAgentDashboardData(error?: string): JsonResult {
  return {
    generatedAt: new Date().toISOString(),
    dataFile: "n/a",
    totals: {
      events: 0,
      memories: 0,
      graphEdges: 0,
      evidenceChunks: 0,
      agents: 0,
      tasks: 0,
      projects: 0,
    },
    agents: [],
    tasks: [],
    memories: [],
    edges: [],
    activities: [],
    recentEvents: [],
    contextPreview: { text: "", usedChars: 0, maxChars: 0, memoryIds: [] },
    health: {
      status: error ? "fail" : "warn",
      ok: false,
      checks: [],
    },
    error,
  };
}

function collectLiveCodexAgents(limit = 8): LiveAgentSnapshot[] {
  const root =
    getPathSetting("codexSessionsPath") ||
    join(homedir(), ".codex", "sessions");

  if (!existsSync(root)) {
    return [];
  }

  const sessionFiles = collectRecentCodexSessionFiles(root, 40);
  const agents: LiveAgentSnapshot[] = [];

  for (const sessionFile of sessionFiles) {
    const snapshot = readLiveAgentSnapshot(sessionFile);
    if (snapshot) {
      agents.push(snapshot);
    }
  }

  return agents
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
    .slice(0, limit);
}

function collectRecentCodexSessionFiles(root: string, limit: number): string[] {
  const years = listDirectoriesDescending(root).slice(0, 2);
  const files: Array<{ path: string; mtimeMs: number }> = [];

  for (const year of years) {
    const yearPath = join(root, year);
    const months = listDirectoriesDescending(yearPath).slice(0, 3);

    for (const month of months) {
      const monthPath = join(yearPath, month);
      const days = listDirectoriesDescending(monthPath).slice(0, 6);

      for (const day of days) {
        const dayPath = join(monthPath, day);
        const entries = readdirSync(dayPath, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => {
            const path = join(dayPath, entry.name);
            return {
              path,
              mtimeMs: statSync(path).mtimeMs,
            };
          });

        files.push(...entries);
      }
    }
  }

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((item) => item.path);
}

function listDirectoriesDescending(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
}

function readLiveAgentSnapshot(
  sessionFile: string,
): LiveAgentSnapshot | undefined {
  try {
    const lines = readFileSync(sessionFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);

    if (lines.length === 0) {
      return undefined;
    }

    const firstRecord = toRecord(parseJsonLine(lines[0]));
    const meta = toRecord(firstRecord.payload);
    const threadSource = toText(meta.thread_source);
    if (threadSource !== "subagent") {
      return undefined;
    }

    const source = toRecord(meta.source);
    const subagent = toRecord(source.subagent);
    const threadSpawn = toRecord(subagent.thread_spawn);
    const nickname =
      toText(meta.agent_nickname) ||
      toText(threadSpawn.agent_nickname) ||
      toText(meta.id);
    if (!nickname) {
      return undefined;
    }

    const role =
      toText(meta.agent_role) || toText(threadSpawn.agent_role) || "subagent";
    let lastSeenAt = toText(firstRecord.timestamp) || new Date().toISOString();
    let status: LiveAgentSnapshot["status"] = "active";

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = toRecord(parseJsonLine(lines[index]));
      const timestamp = toText(record.timestamp);
      if (timestamp && !lastSeenAt) {
        lastSeenAt = timestamp;
      } else if (timestamp) {
        lastSeenAt = timestamp;
      }

      const eventPayload = toRecord(record.payload);
      const eventType = toText(eventPayload.type);
      if (eventType === "task_complete") {
        status = "completed";
        break;
      }
    }

    return {
      id: toText(meta.id) || nickname,
      nickname,
      role,
      status,
      lastSeenAt,
      source: "codex-session",
      sessionFile,
    };
  } catch {
    return undefined;
  }
}

function parseJsonLine(line: string): JsonResult {
  try {
    return JSON.parse(line) as JsonResult;
  } catch {
    return {};
  }
}

function normalizeLiveAgentStatus(status: LiveAgentSnapshot["status"]): string {
  return status === "completed" ? "completed" : "active";
}

function renderLiveAgentCards(liveAgents: LiveAgentSnapshot[]): string {
  if (liveAgents.length === 0) {
    return `<div class="muted">No named Codex subagents found in recent session logs.</div>`;
  }

  return liveAgents
    .map((agent) => {
      const statusClass =
        agent.status === "completed" ? "status-complete" : "status-active";
      return `
        <article class="live-agent-card">
          <div class="live-agent-top">
            <div>
              <div class="live-agent-name">${escapeHtml(agent.nickname)}</div>
              <div class="live-agent-role">${escapeHtml(agent.role)}</div>
            </div>
            <span class="live-agent-pill ${statusClass}">${escapeHtml(
              normalizeLiveAgentStatus(agent.status),
            )}</span>
          </div>
          <div class="live-agent-meta">${escapeHtml(
            formatIsoCompact(agent.lastSeenAt),
          )}</div>
        </article>
      `;
    })
    .join("");
}

function renderLiveAgentSwarm(liveAgents: LiveAgentSnapshot[]): string {
  if (liveAgents.length === 0) {
    return `<div class="muted" style="padding:16px;">No named subagents available from recent Codex sessions.</div>`;
  }

  const positions = [
    { x: 18, y: 24 },
    { x: 52, y: 14 },
    { x: 82, y: 26 },
    { x: 28, y: 56 },
    { x: 68, y: 56 },
    { x: 20, y: 82 },
    { x: 52, y: 78 },
    { x: 84, y: 82 },
  ];

  const nodes = liveAgents.slice(0, positions.length);
  const lines = nodes
    .map((agent, index) => {
      const position = positions[index];
      if (!position) {
        return "";
      }

      return `<line x1="50" y1="50" x2="${position.x}" y2="${position.y}" stroke="oklch(0.56 0.05 248)" stroke-width="1.4" stroke-dasharray="3 5" />`;
    })
    .join("");

  const labels = nodes
    .map((agent, index) => {
      const position = positions[index];
      if (!position) {
        return "";
      }

      const fill =
        agent.status === "completed"
          ? "oklch(0.74 0.14 150)"
          : "oklch(0.72 0.14 235)";

      return `
        <g>
          <circle cx="${position.x}" cy="${position.y}" r="12" fill="${fill}" />
          <text x="${position.x + 18}" y="${position.y - 2}" fill="oklch(0.96 0.01 248)" font-size="12" font-weight="700">${escapeHtml(
            clipLabel(agent.nickname, 20),
          )}</text>
          <text x="${position.x + 18}" y="${position.y + 13}" fill="oklch(0.76 0.018 248)" font-size="10">${escapeHtml(
            agent.role,
          )}</text>
        </g>
      `;
    })
    .join("");

  return `<svg viewBox="0 0 920 420" role="img" aria-label="Named Codex subagent swarm"><circle cx="50" cy="50" r="20" fill="oklch(0.82 0.16 105)" />${lines}${labels}<text x="77" y="54" fill="oklch(0.98 0.01 248)" font-size="13" font-weight="700">Codex swarm</text></svg>`;
}

function getAgentDashboardHtml(_data: JsonResult, loading: boolean): string {
  const nonce = String(Date.now());
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Retentia Command Center</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: oklch(0.17 0.018 248);
        --panel: oklch(0.22 0.02 248);
        --panel2: oklch(0.26 0.022 248);
        --line: oklch(0.38 0.03 248);
        --text: oklch(0.94 0.008 248);
        --muted: oklch(0.72 0.018 248);
        --green: oklch(0.72 0.14 155);
        --amber: oklch(0.78 0.14 80);
        --red: oklch(0.68 0.16 35);
        --blue: oklch(0.7 0.12 235);
      }
      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); }
      .shell { min-height: 100vh; padding: 14px; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 10px; }
      .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
      h1 { margin: 0; font-size: 20px; font-weight: 720; letter-spacing: 0; }
      .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      button { border: 1px solid var(--line); background: var(--panel2); color: var(--text); border-radius: 7px; padding: 8px 10px; cursor: pointer; }
      button:hover { border-color: var(--blue); }
      .tab { color: var(--muted); }
      .tab.active { color: var(--text); border-color: var(--blue); }
      .live { display: inline-flex; align-items: center; gap: 7px; color: var(--green); font-size: 12px; min-height: 32px; }
      .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--green); box-shadow: 0 0 0 5px color-mix(in oklch, var(--green), transparent 80%); }
      .metrics { display: grid; grid-template-columns: repeat(6, minmax(95px, 1fr)); gap: 8px; }
      .metric, .panel, .map-panel, .inspector { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; }
      .metric { padding: 8px 10px; min-width: 0; }
      .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
      .v { font-size: 18px; font-weight: 760; margin-top: 3px; }
      .trend-plane { padding: 10px 12px; display: grid; gap: 10px; }
      .trend-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .trend-card { min-width: 0; display: grid; gap: 8px; }
      .trend-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 700; }
      .trend-bars { height: 74px; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; align-items: end; gap: 4px; border-bottom: 1px solid var(--line); padding-top: 6px; }
      .trend-bar { min-width: 0; border-radius: 4px 4px 0 0; background: var(--blue); position: relative; }
      .trend-bar.failed { background: var(--red); }
      .trend-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; color: var(--muted); font-size: 11px; }
      .workbench { min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(330px, 390px); gap: 10px; }
      .map-panel, .inspector { min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
      .panel-head { padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
      .panel-head h2 { margin: 0; font-size: 14px; }
      .graph { flex: 1; min-height: 0; overflow: auto; padding: 10px; background: oklch(0.19 0.018 248); }
      .graph svg { display: block; width: 100%; min-width: 940px; height: auto; min-height: 620px; overflow: visible; }
      .map-node { cursor: pointer; }
      .map-node:hover rect { stroke-width: 2.5; }
      .map-node.selected rect { stroke: var(--amber); stroke-width: 2.5; }
      .inspector-body { min-height: 0; overflow: auto; padding: 12px; display: grid; gap: 12px; }
      .focus-title { font-size: 16px; font-weight: 760; margin-bottom: 4px; }
      .kv { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 6px 10px; font-size: 12px; }
      .kv .key { color: var(--muted); }
      .section { border-top: 1px solid color-mix(in oklch, var(--line), transparent 35%); padding-top: 10px; }
      .section h3 { margin: 0 0 6px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
      ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 7px; }
      li { border-bottom: 1px solid color-mix(in oklch, var(--line), transparent 45%); padding-bottom: 7px; display: grid; gap: 3px; }
      li span, .muted { color: var(--muted); }
      code { color: var(--muted); white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
      .state { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; padding: 2px 7px; font-size: 11px; color: var(--muted); }
      .state-active { color: var(--green); border-color: color-mix(in oklch, var(--green), transparent 35%); }
      .state-completed { color: var(--blue); border-color: color-mix(in oklch, var(--blue), transparent 35%); }
      .state-failed { color: var(--red); border-color: color-mix(in oklch, var(--red), transparent 35%); }
      .state-pass { color: var(--green); border-color: color-mix(in oklch, var(--green), transparent 35%); }
      .state-warn { color: var(--amber); border-color: color-mix(in oklch, var(--amber), transparent 35%); }
      .reasoning, .context { white-space: pre-wrap; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.45; }
      .health-plane { padding: 10px 12px; display: grid; gap: 8px; }
      .health-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .health-item { border: 1px solid var(--line); border-radius: 8px; padding: 8px; min-width: 0; }
      .health-item strong { display: block; font-size: 12px; margin-bottom: 4px; }
      .memory-plane { min-height: 0; overflow: auto; padding: 12px; }
      .hidden { display: none; }
      .error { border: 1px solid var(--red); color: var(--red); padding: 10px; border-radius: 8px; margin-bottom: 12px; }
      @media (max-width: 980px) { .metrics, .trend-grid, .workbench { grid-template-columns: 1fr; } .top { align-items: flex-start; flex-direction: column; } .map-panel { min-height: 520px; } .graph svg { min-width: 820px; min-height: 520px; } }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="top">
        <div><h1>Retentia Control Plane</h1><div id="dashboardSubtitle" class="sub">${loading ? "Waiting for Retentia v2 stream" : "Retentia v2 stream"}</div></div>
        <div class="actions"><button class="tab active" data-view="control">Control</button><button class="tab" data-view="memory">Memory</button><span id="streamState" class="live"><span class="dot"></span>Connecting</span><button data-command="refresh">Refresh</button><button data-command="doctor">Doctor</button><button data-command="setup">Install MCP</button></div>
      </div>
      <div id="dashboardError"></div>
      <section id="metricStrip" class="metrics"></section>
      <section id="healthPlane" class="panel health-plane"></section>
      <section id="trendPlane" class="panel trend-plane"></section>
      <section id="controlPlane" class="workbench">
        <div class="map-panel"><div class="panel-head"><h2>Agent Task Map</h2><span class="muted">Select latest active task in inspector</span></div><div id="graph" class="graph"></div></div>
        <aside class="inspector"><div class="panel-head"><h2>Inspector</h2><span id="updatedAt" class="muted">n/a</span></div><div id="inspectorBody" class="inspector-body"></div></aside>
      </section>
      <section id="memoryPlane" class="panel memory-plane hidden"></section>
    </main>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      let pending = false;
      let lastSignature = "";
      let currentView = "control";
      let selectedNodeId = "";
      let detailsByNode = {};

      function setHtml(id, html) {
        const node = document.getElementById(id);
        if (node) node.innerHTML = html || "";
      }

      function selectNode(nodeId) {
        selectedNodeId = nodeId || "";
        for (const node of document.querySelectorAll(".map-node")) {
          node.classList.toggle("selected", node.getAttribute("data-node-id") === selectedNodeId);
        }
        const detail = selectedNodeId ? detailsByNode[selectedNodeId] : "";
        if (detail) setHtml("inspectorBody", detail);
      }

      function bindMapNodes(defaultNodeId) {
        for (const node of document.querySelectorAll(".map-node")) {
          node.addEventListener("click", () => selectNode(node.getAttribute("data-node-id") || ""));
        }
        if (!selectedNodeId || !detailsByNode[selectedNodeId]) selectedNodeId = defaultNodeId || "";
        selectNode(selectedNodeId);
      }

      function setView(view) {
        currentView = view === "memory" ? "memory" : "control";
        document.getElementById("controlPlane").classList.toggle("hidden", currentView !== "control");
        document.getElementById("memoryPlane").classList.toggle("hidden", currentView !== "memory");
        for (const button of document.querySelectorAll("button[data-view]")) {
          button.classList.toggle("active", button.getAttribute("data-view") === currentView);
        }
      }

      function requestStreamUpdate() {
        if (pending) return;
        pending = true;
        vscode.postMessage({ command: "live-refresh" });
      }

      for (const button of document.querySelectorAll("button[data-command]")) {
        button.addEventListener("click", () => {
          pending = false;
          vscode.postMessage({ command: button.getAttribute("data-command") });
        });
      }

      for (const button of document.querySelectorAll("button[data-view]")) {
        button.addEventListener("click", () => setView(button.getAttribute("data-view") || "control"));
      }

      window.addEventListener("message", (event) => {
        const message = event.data || {};
        if (message.command !== "dashboard-update") return;
        const payload = message.payload || {};
        pending = false;
        const streamState = document.getElementById("streamState");
        const signature = String(payload.signature || "");
        if (streamState) streamState.lastChild.textContent = signature === lastSignature ? " Live, no changes" : " Live update";
        lastSignature = signature;
        const subtitle = document.getElementById("dashboardSubtitle");
        const updated = document.getElementById("updatedAt");
        if (subtitle) subtitle.textContent = String(payload.subtitle || "Retentia v2 stream");
        if (updated) updated.textContent = String(payload.updatedAt || "n/a");
        setHtml("dashboardError", payload.errorHtml);
        setHtml("metricStrip", payload.metricsHtml);
        setHtml("healthPlane", payload.healthHtml);
        setHtml("trendPlane", payload.trendHtml);
        setHtml("graph", payload.graphHtml);
        setHtml("inspectorBody", payload.inspectorHtml);
        setHtml("memoryPlane", payload.memoryHtml);
        detailsByNode = payload.detailsByNode || {};
        bindMapNodes(String(payload.defaultNodeId || ""));
      });

      window.setInterval(requestStreamUpdate, 1500);
      requestStreamUpdate();
    </script>
  </body>
</html>`;
}

function buildAgentDashboardPayload(
  data: JsonResult,
  error?: string,
): JsonResult {
  const totals = toRecord(data.totals);
  const agents = arrayOfRecords(data.agents);
  const tasks = arrayOfRecords(data.tasks);
  const activities = arrayOfRecords(data.activities);
  const memories = arrayOfRecords(data.memories);
  const edges = arrayOfRecords(data.edges);
  const trends = toRecord(data.trends);
  const contextPreview = toRecord(data.contextPreview);
  const health = toRecord(data.health);
  const graphNodes = buildGraphNodes(agents, tasks, memories);
  const activeTasks = tasks.filter(
    (task) => (toText(task.status) || "active") === "active",
  );
  const focusTask = pickFocusTask(tasks);
  const generatedAt = toText(data.generatedAt) || new Date().toISOString();

  return {
    signature: [
      generatedAt,
      toNumber(totals.events) ?? 0,
      toNumber(totals.tasks) ?? 0,
      activities[0] ? toText(activities[0].id) : "0",
      JSON.stringify(trends),
      toText(health.status),
    ].join(":"),
    subtitle: `${toText(data.dataFile) || "n/a"} / ${formatIso(generatedAt)}`,
    updatedAt: formatIsoCompact(generatedAt),
    errorHtml: error ? `<div class="error">${escapeHtml(error)}</div>` : "",
    metricsHtml: [
      metric("Events", toNumber(totals.events) ?? 0),
      metric("Agents", toNumber(totals.agents) ?? agents.length),
      metric("Active", activeTasks.length),
      metric("Tasks", toNumber(totals.tasks) ?? tasks.length),
      metric("Activity", activities.length),
      metric("Relations", edges.length),
      metric("Evidence", toNumber(totals.evidenceChunks) ?? 0),
    ].join(""),
    healthHtml: renderHealthPlane(health),
    trendHtml: renderTrendPlane(trends),
    graphHtml: renderAgentGraphSvg(graphNodes, edges, tasks),
    inspectorHtml: renderInspector(tasks, agents, activities, contextPreview),
    memoryHtml: renderMemoryPlane(memories, contextPreview),
    detailsByNode: buildNodeDetails(tasks, agents, activities, contextPreview),
    defaultNodeId: focusTask ? `task:${toText(focusTask.id)}` : "",
  };
}

function renderHealthPlane(health: JsonResult): string {
  const status = toText(health.status) || "unknown";
  const checks = arrayOfRecords(health.checks).slice(0, 6);
  const rows = checks.length
    ? checks
        .map((check) => {
          const checkStatus = toText(check.status) || "warn";
          return `
            <div class="health-item">
              <strong>${escapeHtml(toText(check.name) || "check")}</strong>
              <span class="state state-${escapeHtml(checkStatus)}">${escapeHtml(checkStatus)}</span>
              <div class="muted">${escapeHtml(toText(check.summary) || "")}</div>
            </div>`;
        })
        .join("")
    : `<div class="muted">No doctor checks available.</div>`;

  return `
    <div class="panel-head"><h2>Setup Health</h2><span class="state state-${escapeHtml(status)}">${escapeHtml(status)}</span></div>
    <div class="health-list">${rows}</div>
  `;
}

function renderTrendPlane(trends: JsonResult): string {
  const daily = arrayOfRecords(trends.daily);
  const weekly = arrayOfRecords(trends.weekly);
  return `
    <div class="trend-grid">
      ${renderTrendCard("Daily executions", daily)}
      ${renderTrendCard("Weekly executions", weekly)}
    </div>
  `;
}

function renderTrendCard(title: string, buckets: JsonResult[]): string {
  if (buckets.length === 0) {
    return `<div class="trend-card"><div class="trend-title"><span>${escapeHtml(title)}</span><span class="muted">No data</span></div><div class="muted">No execution trend data yet.</div></div>`;
  }

  const maxCount = Math.max(
    1,
    ...buckets.map((bucket) => toNumber(bucket.count) ?? 0),
  );
  const latest = buckets[buckets.length - 1] || {};
  const total = buckets.reduce(
    (sum, bucket) => sum + (toNumber(bucket.count) ?? 0),
    0,
  );
  const completed = buckets.reduce(
    (sum, bucket) => sum + (toNumber(bucket.completed) ?? 0),
    0,
  );
  const failed = buckets.reduce(
    (sum, bucket) => sum + (toNumber(bucket.failed) ?? 0),
    0,
  );
  const bars = buckets
    .map((bucket) => {
      const count = toNumber(bucket.count) ?? 0;
      const failedCount = toNumber(bucket.failed) ?? 0;
      const key = toText(bucket.key) || "bucket";
      const delta = toNumber(bucket.delta) ?? 0;
      const height = Math.max(6, Math.round((count / maxCount) * 68));
      const label = `${key}: ${count} execution(s), delta ${formatDelta(delta)}`;
      return `<div class="trend-bar${failedCount > 0 ? " failed" : ""}" style="height:${height}px" title="${escapeHtml(label)}"></div>`;
    })
    .join("");

  return `
    <div class="trend-card">
      <div class="trend-title"><span>${escapeHtml(title)}</span><span class="muted">${escapeHtml(toText(latest.key) || "n/a")} ${escapeHtml(formatDelta(toNumber(latest.delta) ?? 0))}</span></div>
      <div class="trend-bars" aria-label="${escapeHtml(title)}">${bars}</div>
      <div class="trend-meta"><span>Total ${total}</span><span>Done ${completed}</span><span>Failed ${failed}</span></div>
    </div>
  `;
}

function formatDelta(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }
  return String(value);
}

function renderInspector(
  tasks: JsonResult[],
  agents: JsonResult[],
  activities: JsonResult[],
  contextPreview: JsonResult,
): string {
  const task = pickFocusTask(tasks);
  if (!task) {
    return `
      <div class="muted">No v2 task events yet.</div>
      <div class="section"><h3>Required signal</h3><div class="reasoning">Emit agent_event with taskId, actor, summary, and payload.reasoningSummary or payload.rationale.</div></div>
      <div class="section"><h3>Context</h3><div class="context">${escapeHtml(toText(contextPreview.text) || "No context yet.")}</div></div>
    `;
  }

  return renderTaskInspector(task, agents, activities, contextPreview);
}

function buildNodeDetails(
  tasks: JsonResult[],
  agents: JsonResult[],
  activities: JsonResult[],
  contextPreview: JsonResult,
): JsonResult {
  const details: JsonResult = {};
  for (const task of tasks) {
    const taskId = toText(task.id);
    if (taskId) {
      details[`task:${taskId}`] = renderTaskInspector(
        task,
        agents,
        activities,
        contextPreview,
      );
    }
  }
  for (const agent of agents) {
    const agentId = toText(agent.id);
    if (agentId) {
      details[`agent:${agentId}`] = renderAgentInspector(
        agent,
        tasks,
        activities,
      );
    }
  }
  return details;
}

function renderTaskInspector(
  task: JsonResult,
  agents: JsonResult[],
  activities: JsonResult[],
  contextPreview: JsonResult,
): string {
  const taskId = toText(task.id) || "unknown";
  const actor = toText(task.actor) || toText(task.source) || "unknown";
  const agent = agents.find((item) => toText(item.id) === actor) || {};
  const matchingActivities = activities
    .filter((activity) => toText(activity.taskId) === taskId)
    .slice(0, 8);
  const fallbackActivity = matchingActivities.find(
    (activity) => toText(activity.reasoning) || toText(activity.payloadPreview),
  );
  const reasoning =
    toText(task.reasoning) ||
    toText(fallbackActivity?.reasoning) ||
    toText(fallbackActivity?.payloadPreview) ||
    "No explicit reasoning summary recorded for this task.";

  return `
    <div>
      <div class="focus-title">${escapeHtml(toText(task.title) || taskId)}</div>
      <div class="muted">${escapeHtml(toText(task.description) || "No task description recorded yet.")}</div>
    </div>
    <div class="kv">
      <div class="key">Agent</div><div>${escapeHtml(actor)} <span class="state state-${escapeHtml(toText(agent.status) || "idle")}">${escapeHtml(toText(agent.status) || "idle")}</span></div>
      <div class="key">Role</div><div>${escapeHtml(toText(task.role) || toText(agent.role) || "primary")}</div>
      <div class="key">Task</div><div>${escapeHtml(taskId)}</div>
      <div class="key">Parent</div><div>${escapeHtml(toText(task.parentTaskId) || "root")}</div>
      <div class="key">Project</div><div>${escapeHtml(toText(task.project) || "global")}</div>
      <div class="key">Status</div><div><span class="state state-${escapeHtml(toText(task.status) || "active")}">${escapeHtml(toText(task.status) || "active")}</span></div>
      <div class="key">Seen</div><div>${escapeHtml(formatIsoCompact(toText(task.lastSeenAt)))}</div>
    </div>
    <div class="section"><h3>Reasoning Summary</h3><div class="reasoning">${escapeHtml(reasoning)}</div></div>
    <div class="section"><h3>Task Activity</h3><ul>${renderActivityItems(matchingActivities)}</ul></div>
    <div class="section"><h3>Context Preview</h3><div class="context">${escapeHtml(toText(contextPreview.text) || "No context yet.")}</div></div>
  `;
}

function renderAgentInspector(
  agent: JsonResult,
  tasks: JsonResult[],
  activities: JsonResult[],
): string {
  const agentId = toText(agent.id) || "unknown";
  const ownedTasks = tasks.filter(
    (task) => (toText(task.actor) || toText(task.source)) === agentId,
  );
  const activeTask =
    ownedTasks.find((task) => (toText(task.status) || "active") === "active") ||
    ownedTasks[0];
  const agentActivities = activities
    .filter(
      (activity) =>
        (toText(activity.actor) || toText(activity.source)) === agentId,
    )
    .slice(0, 8);

  return `
    <div>
      <div class="focus-title">${escapeHtml(agentId)}</div>
      <div class="muted">${escapeHtml(toText(agent.role) || "agent")} / ${escapeHtml(toText(agent.source) || "source unknown")}</div>
    </div>
    <div class="kv">
      <div class="key">Status</div><div><span class="state state-${escapeHtml(toText(agent.status) || "idle")}">${escapeHtml(toText(agent.status) || "idle")}</span></div>
      <div class="key">On Task</div><div>${escapeHtml(activeTask ? toText(activeTask.title) || toText(activeTask.id) || "task" : "none")}</div>
      <div class="key">Active</div><div>${toNumber(agent.activeTasks) ?? 0}</div>
      <div class="key">Done</div><div>${toNumber(agent.completedTasks) ?? 0}</div>
      <div class="key">Failed</div><div>${toNumber(agent.failedTasks) ?? 0}</div>
      <div class="key">Seen</div><div>${escapeHtml(formatIsoCompact(toText(agent.lastSeenAt)))}</div>
    </div>
    <div class="section"><h3>Current Task Reasoning</h3><div class="reasoning">${escapeHtml(activeTask ? toText(activeTask.reasoning) || toText(activeTask.description) || "No explicit reasoning summary recorded." : "No active task.")}</div></div>
    <div class="section"><h3>Agent Activity</h3><ul>${renderActivityItems(agentActivities)}</ul></div>
  `;
}

function renderMemoryPlane(
  memories: JsonResult[],
  contextPreview: JsonResult,
): string {
  const rows = memories.length
    ? memories
        .slice(0, 80)
        .map(
          (memory) => `
            <li>
              <strong>${escapeHtml(toText(memory.title) || "Untitled memory")}</strong>
              <span>${escapeHtml(toText(memory.kind) || "memory")} / ${escapeHtml(toText(memory.project) || "global")}</span>
              <code>${escapeHtml(clipLabel(toText(memory.body) || "", 260))}</code>
            </li>`,
        )
        .join("")
    : `<li class="muted">No durable memories yet.</li>`;

  return `<div class="panel-head"><h2>Durable Memory</h2><span class="muted">Separate from live control plane</span></div><div class="inspector-body"><ul>${rows}</ul><div class="section"><h3>Current Context Pack</h3><div class="context">${escapeHtml(toText(contextPreview.text) || "No context yet.")}</div></div></div>`;
}

function pickFocusTask(tasks: JsonResult[]): JsonResult | undefined {
  return (
    tasks.find((task) => (toText(task.status) || "active") === "active") ||
    tasks[0]
  );
}

function renderActivityItems(activities: JsonResult[]): string {
  if (activities.length === 0) {
    return `<li class="muted">No events have been recorded for this task yet.</li>`;
  }

  return activities
    .map(
      (activity) => `
        <li>
          <strong>${escapeHtml(formatIsoCompact(toText(activity.createdAt)))} / ${escapeHtml(toText(activity.type) || "event")}</strong>
          <span>${escapeHtml(toText(activity.summary) || "No summary")}</span>
          <code>${escapeHtml(toText(activity.reasoning) || toText(activity.payloadPreview) || "No explicit reasoning or payload summary.")}</code>
        </li>`,
    )
    .join("");
}

function metric(label: string, value: number): string {
  return `<div class="metric"><div class="k">${escapeHtml(label)}</div><div class="v">${value}</div></div>`;
}

function arrayOfRecords(value: unknown): JsonResult[] {
  return Array.isArray(value) ? value.map((item) => toRecord(item)) : [];
}

function buildGraphNodes(
  agents: JsonResult[],
  tasks: JsonResult[],
  _memories: JsonResult[],
): Array<{
  id: string;
  type: string;
  label: string;
  detail: string;
  status: string;
  x: number;
  y: number;
}> {
  const nodes: Array<{
    id: string;
    type: string;
    label: string;
    detail: string;
    status: string;
    x: number;
    y: number;
  }> = [];
  const activeTaskByActor = new Map<string, JsonResult>();
  for (const task of tasks) {
    const actor = toText(task.actor) || toText(task.source);
    if (actor && !activeTaskByActor.has(actor)) {
      activeTaskByActor.set(actor, task);
    }
  }

  agents.slice(0, 8).forEach((agent, index) => {
    const agentId = toText(agent.id) || String(index);
    const activeTask = activeTaskByActor.get(agentId);
    nodes.push({
      id: `agent:${agentId}`,
      type: "agent",
      label: agentId,
      detail: activeTask
        ? `on: ${toText(activeTask.title) || toText(activeTask.id) || "task"}`
        : `${toText(agent.role) || "agent"} / ${toText(agent.status) || "idle"}`,
      status: toText(agent.status) || "idle",
      x: 80,
      y: 75 + index * 66,
    });
  });
  tasks.slice(0, 12).forEach((task, index) => {
    nodes.push({
      id: `task:${toText(task.id) || index}`,
      type: "task",
      label: toText(task.title) || toText(task.id) || "task",
      detail:
        toText(task.reasoning) ||
        toText(task.description) ||
        `${toText(task.actor) || "agent"} / ${toText(task.status) || "active"}`,
      status: toText(task.status) || "active",
      x: 390,
      y: 55 + index * 56,
    });
  });
  return nodes;
}

function renderAgentGraphSvg(
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    detail: string;
    status: string;
    x: number;
    y: number;
  }>,
  edges: JsonResult[],
  tasks: JsonResult[],
): string {
  if (nodes.length === 0) {
    return `<div class="muted" style="padding:16px;">No graph data yet. Record events and edges to inspect agent swarms.</div>`;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const taskLines = tasks
    .slice(0, 120)
    .map((task) => {
      const taskId = toText(task.id);
      const actor = toText(task.actor) || toText(task.source);
      if (!taskId || !actor) {
        return "";
      }
      const taskNode = byId.get(`task:${taskId}`);
      const agentNode = byId.get(`agent:${actor}`);
      const parentTaskId = toText(task.parentTaskId);
      const parentNode = parentTaskId
        ? byId.get(`task:${parentTaskId}`)
        : undefined;
      const ownership =
        taskNode && agentNode
          ? `<line x1="${agentNode.x}" y1="${agentNode.y}" x2="${taskNode.x}" y2="${taskNode.y}" stroke="oklch(0.72 0.14 155)" stroke-width="2" opacity="0.75" />`
          : "";
      const delegation =
        taskNode && parentNode
          ? `<line x1="${parentNode.x}" y1="${parentNode.y}" x2="${taskNode.x}" y2="${taskNode.y}" stroke="oklch(0.78 0.14 80)" stroke-width="1.5" stroke-dasharray="5 5" opacity="0.8" />`
          : "";
      return `${ownership}${delegation}`;
    })
    .join("");
  const persistedLines = edges
    .slice(0, 80)
    .map((edge) => {
      const from = byId.get(`${toText(edge.fromType)}:${toText(edge.fromId)}`);
      const to = byId.get(`${toText(edge.toType)}:${toText(edge.toId)}`);
      if (!from || !to) {
        return "";
      }
      return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="oklch(0.58 0.05 248)" stroke-width="1.5" />`;
    })
    .join("");
  const renderedNodes = nodes
    .map((node) => {
      const fill =
        node.type === "agent"
          ? "oklch(0.72 0.14 155)"
          : node.type === "task"
            ? "oklch(0.7 0.12 235)"
            : "oklch(0.78 0.14 80)";
      const stroke =
        node.status === "failed"
          ? "oklch(0.68 0.16 35)"
          : node.status === "completed"
            ? "oklch(0.7 0.12 235)"
            : node.status === "active"
              ? "oklch(0.72 0.14 155)"
              : "oklch(0.38 0.03 248)";
      const width = node.type === "task" ? 380 : 270;
      return `<g class="map-node" data-node-id="${escapeHtml(node.id)}"><title>${escapeHtml(`${node.label}: ${node.detail}`)}</title><rect x="${node.x - 12}" y="${node.y - 24}" width="${width}" height="48" rx="7" fill="oklch(0.23 0.02 248)" stroke="${stroke}" /><circle cx="${node.x}" cy="${node.y - 5}" r="8" fill="${fill}" /><text x="${node.x + 17}" y="${node.y - 5}" fill="oklch(0.94 0.008 248)" font-size="12" font-weight="700">${escapeHtml(clipLabel(node.label, node.type === "task" ? 42 : 28))}</text><text x="${node.x + 17}" y="${node.y + 12}" fill="oklch(0.72 0.018 248)" font-size="10">${escapeHtml(clipLabel(node.detail, node.type === "task" ? 54 : 32))}</text></g>`;
    })
    .join("");
  return `<svg viewBox="0 0 980 760" role="img" aria-label="Live v2 agent task graph"><text x="20" y="28" fill="oklch(0.72 0.018 248)" font-size="11">solid: agent owns task / dashed: parent to subtask / node detail shows current task or reasoning</text>${taskLines}${persistedLines}${renderedNodes}</svg>`;
}

function clipLabel(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}

async function collectDashboardData(): Promise<DashboardData> {
  const ingestion = await syncTaskExecutions({ force: false });
  const liveAgents = collectLiveCodexAgents();
  const mcp = readMcpStatus();
  const dashboardDataFileArgs = getMcpDataFileArgs(mcp.args);
  const [
    statusPayload,
    recentPayload,
    executionPayload,
    dbQueryPayload,
    ioTracePayload,
  ] = await Promise.all([
    runCliJson(["kpis", ...dashboardDataFileArgs]),
    runCliJson(["search", "--limit", "8", ...dashboardDataFileArgs]),
    runCliJson([
      "execution-report",
      "--limit",
      String(getExecutionReportLimit()),
      ...dashboardDataFileArgs,
    ]),
    runCliJson(["list-entries", "--limit", "200", ...dashboardDataFileArgs]),
    runCliJson(["io-trace", "--limit", "200", ...dashboardDataFileArgs]),
  ]);

  const statusRoot = toRecord(statusPayload);
  const worker = toRecord(statusRoot.worker);
  const kpis = toRecord(statusRoot.kpis);
  const recentRoot = toRecord(recentPayload);
  const executionRoot = toRecord(executionPayload);
  const dbRoot = toRecord(dbQueryPayload);
  const ioRoot = toRecord(ioTracePayload);
  const recentSource = Array.isArray(recentRoot.results)
    ? recentRoot.results
    : [];
  const dbEntries = mapDbEntries(dbRoot.entries);
  const ioEvents = mapIoTraceEvents(ioRoot.events);

  const recentTasks = recentSource
    .map((item) => toRecord(item))
    .map((item) => ({
      id: toNumber(item.id),
      kind: toText(item.kind) || "unknown",
      title: toText(item.title) || "(no title)",
      excerpt: toText(item.excerpt) || "",
      createdAt: toText(item.createdAt) || "",
    }))
    .filter((item) => Boolean(item.createdAt || item.title));

  const execution = mapExecutionReport(executionRoot);
  const db = buildDbInsights(dbEntries);
  const io = buildIoInsights(ioEvents);

  return {
    generatedAt: new Date().toISOString(),
    dataFile: toText(statusRoot.dataFile) || toText(worker.dataFile) || "n/a",
    worker: {
      running: toBoolean(worker.running),
      pid: toNumber(worker.pid),
      uptimeSeconds: toNumber(worker.uptimeSeconds),
      baseUrl: toText(worker.baseUrl) || "n/a",
      host: toText(worker.host) || "n/a",
      port: toNumber(worker.port),
    },
    mcp,
    kpis: {
      entriesTotal: toNumber(kpis.entriesTotal) ?? 0,
      observationsTotal: toNumber(kpis.observationsTotal) ?? 0,
      summariesTotal: toNumber(kpis.summariesTotal) ?? 0,
      projectsTotal: toNumber(kpis.projectsTotal) ?? 0,
      latestEntryAt: toText(kpis.latestEntryAt),
      oldestEntryAt: toText(kpis.oldestEntryAt),
    },
    ingestion,
    execution,
    db,
    io,
    liveAgents,
    recentTasks,
  };
}

function getMcpDataFileArgs(mcpArgs: string[]): string[] {
  const dataFile = getCliOptionValue(mcpArgs, "--data-file");
  if (!dataFile) {
    return [];
  }

  return ["--data-file", dataFile];
}

function getCliOptionValue(
  args: string[],
  optionName: string,
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]?.trim();
    if (!token) {
      continue;
    }

    if (token === optionName) {
      const next = args[index + 1]?.trim();
      if (next && !next.startsWith("--")) {
        return next;
      }
      continue;
    }

    if (token.startsWith(`${optionName}=`)) {
      const value = token.slice(optionName.length + 1).trim();
      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

function createEmptyDashboardData(error?: string): DashboardData {
  return {
    generatedAt: new Date().toISOString(),
    dataFile: "n/a",
    worker: {
      running: false,
      baseUrl: "n/a",
      host: "n/a",
    },
    mcp: {
      configured: false,
      command: "n/a",
      args: [],
      configPath: CODEX_CONFIG_PATH,
    },
    kpis: {
      entriesTotal: 0,
      observationsTotal: 0,
      summariesTotal: 0,
      projectsTotal: 0,
    },
    ingestion: {
      autoSyncEnabled: true,
      detectedTasks: 0,
      importedTasks: 0,
      skippedTasks: 0,
      failedTasks: 0,
      byProvider: [],
    },
    execution: {
      total: 0,
      projects: [],
      providers: [],
      agents: [],
      models: [],
      statuses: [],
      trends: {
        daily: [],
        weekly: [],
      },
      tasks: [],
    },
    db: {
      sampleSize: 0,
      entriesLast24h: 0,
      activeProjects: 0,
      avgTagsPerEntry: 0,
      summaryRatio: 0,
      latestEntries: [],
      kindCounts: [],
      projectCounts: [],
      observationTypeCounts: [],
      dailyCounts: [],
    },
    io: {
      sampleSize: 0,
      sourceCounts: [],
      operationCounts: [],
      latestEvents: [],
    },
    liveAgents: [],
    recentTasks: [],
    error,
  };
}

async function syncTaskExecutions(options: {
  force: boolean;
}): Promise<TaskSyncMetrics> {
  const autoSyncEnabled = isAutoSyncEnabled();
  if (!options.force && !autoSyncEnabled) {
    return {
      autoSyncEnabled,
      detectedTasks: 0,
      importedTasks: 0,
      skippedTasks: 0,
      failedTasks: 0,
      byProvider: [],
    };
  }

  const args = ["ingest"];
  const providers = getEnabledProviders();
  if (providers.length > 0) {
    args.push("--providers", providers.join(","));
  }

  args.push("--lookback-days", String(getAutoSyncLookbackDays()));
  args.push("--max-import", String(getAutoSyncMaxImport()));
  args.push("--max-files", String(getAutoSyncMaxFiles()));

  const defaultProject = getDefaultProject();
  if (defaultProject) {
    args.push("--project", defaultProject);
  }

  const copilotPath = getPathSetting("copilotTranscriptsPath");
  const codexPath = getPathSetting("codexSessionsPath");
  const claudePath = getPathSetting("claudeSessionsPath");
  if (copilotPath) {
    args.push("--copilot-path", copilotPath);
  }
  if (codexPath) {
    args.push("--codex-path", codexPath);
  }
  if (claudePath) {
    args.push("--claude-path", claudePath);
  }

  const result = toRecord(await runCliJson(args));
  return {
    autoSyncEnabled,
    detectedTasks: toNumber(result.detectedEvents) ?? 0,
    importedTasks: toNumber(result.importedEvents) ?? 0,
    skippedTasks: toNumber(result.skippedEvents) ?? 0,
    failedTasks: toNumber(result.failedEvents) ?? 0,
    newestTaskAt: toText(result.newestEventAt),
    byProvider: mapProviderSyncList(result.byProvider),
  };
}

function isAutoSyncEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("retentia")
    .get<boolean>("autoSyncTasks", true);
}

function getAutoSyncMaxImport(): number {
  const configured = vscode.workspace
    .getConfiguration("retentia")
    .get<number>("autoSyncMaxImport", DEFAULT_AUTO_SYNC_MAX_IMPORT);
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_AUTO_SYNC_MAX_IMPORT;
  }
  return Math.min(Math.max(Math.floor(configured), 1), 1000);
}

function getAutoSyncMaxFiles(): number {
  const configured = vscode.workspace
    .getConfiguration("retentia")
    .get<number>("autoSyncMaxFiles", DEFAULT_AUTO_SYNC_MAX_FILES);
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_AUTO_SYNC_MAX_FILES;
  }
  return Math.min(Math.max(Math.floor(configured), 1), 200);
}

function getAutoSyncLookbackDays(): number {
  const configured = vscode.workspace
    .getConfiguration("retentia")
    .get<number>("autoSyncLookbackDays", DEFAULT_AUTO_SYNC_LOOKBACK_DAYS);
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_AUTO_SYNC_LOOKBACK_DAYS;
  }
  return Math.min(Math.max(Math.floor(configured), 1), 30);
}

function getEnabledProviders(): string[] {
  const configured = vscode.workspace
    .getConfiguration("retentia")
    .get<string[]>("enabledProviders", ["copilot", "codex", "claude-code"]);

  if (!Array.isArray(configured) || configured.length === 0) {
    return ["copilot", "codex", "claude-code"];
  }

  const allowed = new Set([
    "copilot",
    "github-copilot",
    "copilot-chat",
    "codex",
    "claude",
    "claude-code",
    "all",
  ]);
  const normalized = [
    ...new Set(configured.map((item) => item.toLowerCase().trim())),
  ].filter((item) => allowed.has(item));
  return normalized.length > 0
    ? normalized
    : ["copilot", "codex", "claude-code"];
}

function getPathSetting(key: string): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("retentia")
    .get<string>(key, "")
    .trim();
  return configured || undefined;
}

function getExecutionReportLimit(): number {
  const configured = vscode.workspace
    .getConfiguration("retentia")
    .get<number>("executionReportLimit", DEFAULT_EXECUTION_REPORT_LIMIT);
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_EXECUTION_REPORT_LIMIT;
  }
  return Math.min(Math.max(Math.floor(configured), 50), 5000);
}

function mapProviderSyncList(value: unknown): TaskSyncMetrics["byProvider"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toRecord(item))
    .map((item) => ({
      provider: toText(item.provider) || "unknown",
      detected: toNumber(item.detected) ?? 0,
      imported: toNumber(item.imported) ?? 0,
      skipped: toNumber(item.skipped) ?? 0,
      failed: toNumber(item.failed) ?? 0,
    }));
}

function mapExecutionReport(root: JsonResult): DashboardData["execution"] {
  return {
    total: toNumber(root.total) ?? 0,
    projects: mapExecutionProjects(root.projects),
    providers: mapExecutionCounts(root.providers),
    agents: mapExecutionCounts(root.agents),
    models: mapExecutionCounts(root.models),
    statuses: mapExecutionCounts(root.statuses),
    trends: mapExecutionTrends(root.trends),
    tasks: mapExecutionTasks(root.tasks),
  };
}

function mapExecutionTrends(
  value: unknown,
): DashboardData["execution"]["trends"] {
  const root = toRecord(value);
  return {
    daily: mapTrendBuckets(root.daily),
    weekly: mapTrendBuckets(root.weekly),
  };
}

function mapTrendBuckets(value: unknown): DashboardTrendBucket[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => {
    const bucket = toRecord(item);
    return {
      key: toText(bucket.key) || "unknown",
      count: toNumber(bucket.count) ?? 0,
      completed: toNumber(bucket.completed) ?? 0,
      failed: toNumber(bucket.failed) ?? 0,
      delta: toNumber(bucket.delta) ?? 0,
    };
  });
}

function mapExecutionProjects(
  value: unknown,
): DashboardData["execution"]["projects"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toRecord(item))
    .map((item) => ({
      project: toText(item.project) || "unknown",
      total: toNumber(item.total) ?? 0,
      completed: toNumber(item.completed) ?? 0,
      failed: toNumber(item.failed) ?? 0,
      providers: mapStringList(item.providers),
      agents: mapStringList(item.agents),
      models: mapStringList(item.models),
      latestAt: toText(item.latestAt),
    }));
}

function mapExecutionCounts(
  value: unknown,
): Array<{ key: string; count: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toRecord(item))
    .map((item) => ({
      key: toText(item.key) || "unknown",
      count: toNumber(item.count) ?? 0,
    }));
}

function mapExecutionTasks(
  value: unknown,
): DashboardData["execution"]["tasks"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toRecord(item))
    .map((item) => ({
      id: toNumber(item.id) ?? 0,
      kind: toText(item.kind) || "observation",
      project: toText(item.project) || "unknown",
      sessionId: toText(item.sessionId),
      createdAt: toText(item.createdAt) || "",
      title: toText(item.title) || "(no title)",
      excerpt: toText(item.excerpt) || "",
      provider: toText(item.provider) || "unknown",
      model: toText(item.model) || "unknown",
      agent: toText(item.agent) || "unassigned",
      role: toText(item.role) || "unassigned",
      pipeline: toText(item.pipeline) || "none",
      status: toText(item.status) || "unknown",
      taskId: toText(item.taskId),
      sourceFile: toText(item.sourceFile),
      tags: mapStringList(item.tags),
    }));
}

function mapDbEntries(value: unknown): DashboardDbEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toRecord(item))
    .map((item) => {
      const kind = toText(item.kind) || "unknown";
      const observationType =
        kind === "observation"
          ? toText(item.observationType) || "note"
          : "summary";
      const tags = mapStringList(item.tags);
      const title = resolveDbEntryTitle(item, kind);

      return {
        id: toNumber(item.id) ?? 0,
        kind,
        project: toText(item.project) || "unknown",
        createdAt: toText(item.createdAt) || "",
        title,
        observationType,
        tagsCount: tags.length,
      };
    });
}

function resolveDbEntryTitle(item: JsonResult, kind: string): string {
  if (kind === "observation") {
    return clipText(
      toText(item.title) || toText(item.content) || "(untitled observation)",
      120,
    );
  }

  return clipText(
    toText(item.learned) ||
      toText(item.completed) ||
      toText(item.request) ||
      "(untitled summary)",
    120,
  );
}

function buildDbInsights(entries: DashboardDbEntry[]): DashboardData["db"] {
  const now = Date.now();
  const entriesLast24h = entries.reduce((count, entry) => {
    const created = Date.parse(entry.createdAt);
    if (Number.isNaN(created)) {
      return count;
    }
    return now - created <= 24 * 60 * 60 * 1000 ? count + 1 : count;
  }, 0);

  const totalTags = entries.reduce((sum, entry) => sum + entry.tagsCount, 0);
  const avgTagsPerEntry =
    entries.length > 0 ? roundToOneDecimal(totalTags / entries.length) : 0;
  const activeProjects = new Set(entries.map((entry) => entry.project)).size;
  const summaryCount = entries.filter(
    (entry) => entry.kind === "summary",
  ).length;
  const summaryRatio =
    entries.length > 0 ? Math.round((summaryCount / entries.length) * 100) : 0;

  return {
    sampleSize: entries.length,
    entriesLast24h,
    activeProjects,
    avgTagsPerEntry,
    summaryRatio,
    latestEntries: entries.slice(0, 20),
    kindCounts: sortCountMapToList(
      countBy(entries, (entry) => entry.kind),
      8,
    ),
    projectCounts: sortCountMapToList(
      countBy(entries, (entry) => entry.project),
      8,
    ),
    observationTypeCounts: sortCountMapToList(
      countBy(entries, (entry) => entry.observationType),
      8,
    ),
    dailyCounts: buildDailyCounts(entries, 7),
  };
}

function mapIoTraceEvents(value: unknown): DashboardIoTraceEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toRecord(item))
    .map((item) => ({
      id: toNumber(item.id) ?? 0,
      createdAt: toText(item.createdAt) || "",
      source: toText(item.source) || "unknown",
      op: toText(item.op) || "unknown",
      req: clipText(toText(item.req) || "{}", 400),
      res: clipText(toText(item.res) || "{}", 400),
    }));
}

function buildIoInsights(events: DashboardIoTraceEvent[]): DashboardData["io"] {
  return {
    sampleSize: events.length,
    sourceCounts: sortCountMapToList(
      countBy(events, (event) => event.source),
      8,
    ),
    operationCounts: sortCountMapToList(
      countBy(events, (event) => event.op),
      12,
    ),
    latestEvents: events.slice(0, 20),
  };
}

function countBy<T>(
  items: T[],
  getKey: (item: T) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item).trim() || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function sortCountMapToList(
  counts: Map<string, number>,
  limit: number,
): Array<{ key: string; count: number }> {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.key.localeCompare(right.key);
    })
    .slice(0, limit);
}

function buildDailyCounts(
  entries: DashboardDbEntry[],
  days: number,
): Array<{ key: string; count: number }> {
  const byDay = new Map<string, number>();
  for (const entry of entries) {
    const date = new Date(entry.createdAt);
    if (Number.isNaN(date.getTime())) {
      continue;
    }
    const key = date.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }

  const output: Array<{ key: string; count: number }> = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - index);
    const iso = day.toISOString().slice(0, 10);
    const label = day.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    output.push({
      key: label,
      count: byDay.get(iso) || 0,
    });
  }

  return output;
}

function clipText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function mapStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readMcpStatus(): DashboardData["mcp"] {
  const fallback: DashboardData["mcp"] = {
    configured: false,
    command: "n/a",
    args: [],
    configPath: CODEX_CONFIG_PATH,
  };

  try {
    if (!existsSync(CODEX_CONFIG_PATH)) {
      return fallback;
    }

    const lines = readFileSync(CODEX_CONFIG_PATH, "utf8").split(/\r?\n/);
    let inSection = false;
    let foundSection = false;
    let command = "";
    let args: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      if (trimmed.startsWith("[")) {
        const inKnownSection = MCP_SERVER_SECTIONS.some(
          (section) => trimmed === `[${section}]`,
        );
        if (inKnownSection) {
          inSection = true;
          foundSection = true;
          continue;
        }

        if (inSection) {
          break;
        }

        continue;
      }

      if (!inSection) {
        continue;
      }

      const commandMatch = trimmed.match(/^command\s*=\s*"([^"]+)"/);
      if (commandMatch && commandMatch[1]) {
        command = commandMatch[1];
        continue;
      }

      if (trimmed.startsWith("args")) {
        args = [...trimmed.matchAll(/"([^"]+)"/g)]
          .map((match) => match[1])
          .filter(Boolean);
      }
    }

    if (!foundSection) {
      return fallback;
    }

    return {
      configured: true,
      command: command || "n/a",
      args,
      configPath: CODEX_CONFIG_PATH,
    };
  } catch {
    return fallback;
  }
}

function getQuickInputSidebarHtml(): string {
  const nonce = String(Date.now());
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root {
        color-scheme: dark;
        --bg-0: #0f141b;
        --bg-1: #17202b;
        --line: #2b3a4c;
        --fg-0: #edf3fb;
        --fg-1: #a7b8cd;
        --accent: #2ea36c;
        --danger: #c74f3f;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 10px;
        font-family: "Segoe UI", "IBM Plex Sans", sans-serif;
        background: var(--bg-0);
        color: var(--fg-0);
      }

      h2 {
        margin: 0 0 8px;
        font-size: 14px;
      }

      h3 {
        margin: 0 0 8px;
        font-size: 12px;
        color: var(--fg-1);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      section {
        border: 1px solid var(--line);
        background: linear-gradient(170deg, #17202b, #101721);
        border-radius: 10px;
        padding: 10px;
        margin-bottom: 10px;
      }

      .row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        font-size: 12px;
        margin-bottom: 6px;
      }

      .row .k {
        color: var(--fg-1);
      }

      .pill {
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
      }

      .ok {
        background: rgba(46, 163, 108, 0.2);
        color: #81e0b5;
      }

      .warn {
        background: rgba(199, 79, 63, 0.2);
        color: #ffb4a8;
      }

      .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }

      button {
        border: 1px solid var(--line);
        background: #14202b;
        color: var(--fg-0);
        font-size: 12px;
        border-radius: 8px;
        padding: 6px 8px;
        cursor: pointer;
      }

      button:hover {
        border-color: #3a5370;
      }

      button.primary {
        background: linear-gradient(180deg, #2d8f63, #236f4e);
        border-color: #2d8f63;
      }

      input,
      select,
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        background: #0f1722;
        color: var(--fg-0);
        border-radius: 7px;
        padding: 6px 7px;
        font-size: 12px;
        margin-bottom: 6px;
      }

      textarea {
        min-height: 56px;
        resize: vertical;
      }

      .note {
        color: var(--fg-1);
        font-size: 11px;
      }

      .error {
        border: 1px solid rgba(199, 79, 63, 0.5);
        background: rgba(199, 79, 63, 0.1);
        color: #ffb4a8;
        border-radius: 8px;
        padding: 7px 8px;
        font-size: 12px;
        margin-bottom: 10px;
        display: none;
      }
    </style>
  </head>
  <body>
    <div id="error" class="error"></div>

    <section>
      <h2>Retentia Quick Input</h2>
      <div class="row"><span class="k">Engine</span><span id="statusWorker" class="pill warn">Unknown</span></div>
      <div class="row"><span class="k">Entries</span><span id="statusEntries">0</span></div>
      <div class="row"><span class="k">Projects</span><span id="statusProjects">0</span></div>
      <div class="row"><span class="k">DB</span><span id="statusDb">n/a</span></div>
      <div class="row"><span class="k">Updated</span><span id="statusUpdated">n/a</span></div>
      <div class="actions">
        <button data-action="refresh-status">Refresh</button>
        <button data-action="open-dashboard">Dashboard</button>
        <button class="primary" data-action="setup">Setup</button>
        <button data-action="doctor">Doctor</button>
        <button data-action="sync-tasks">Sync Tasks</button>
        <button data-action="open-settings">Settings</button>
      </div>
      <div class="note" style="margin-top:8px;">Use Setup after first install.</div>
    </section>

    <section>
      <h3>Add Observation</h3>
      <input id="obsProject" type="text" placeholder="Project (optional)" />
      <select id="obsType">
        <option value="note">note</option>
        <option value="bugfix">bugfix</option>
        <option value="feature">feature</option>
        <option value="refactor">refactor</option>
        <option value="discovery">discovery</option>
        <option value="decision">decision</option>
        <option value="change">change</option>
      </select>
      <input id="obsTitle" type="text" placeholder="Title (required)" />
      <textarea id="obsContent" placeholder="Content (required)"></textarea>
      <input id="obsTags" type="text" placeholder="Tags (comma-separated)" />
      <input id="obsFiles" type="text" placeholder="Files (comma-separated)" />
      <button class="primary" id="submitObservation">Save Observation</button>
    </section>

    <section>
      <h3>Add Summary</h3>
      <input id="sumProject" type="text" placeholder="Project (optional)" />
      <textarea id="sumLearned" placeholder="Learned (required)"></textarea>
      <textarea id="sumRequest" placeholder="Request (optional)"></textarea>
      <textarea id="sumCompleted" placeholder="Completed (optional)"></textarea>
      <textarea id="sumNextSteps" placeholder="Next steps (optional)"></textarea>
      <input id="sumTags" type="text" placeholder="Tags (comma-separated)" />
      <button class="primary" id="submitSummary">Save Summary</button>
      <div class="note" style="margin-top:8px;">
        Need CLI path settings? Use command palette: Retentia: Open Settings.
      </div>
    </section>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();

      const statusWorker = document.getElementById("statusWorker");
      const statusEntries = document.getElementById("statusEntries");
      const statusProjects = document.getElementById("statusProjects");
      const statusDb = document.getElementById("statusDb");
      const statusUpdated = document.getElementById("statusUpdated");
      const errorNode = document.getElementById("error");

      function post(command, payload = {}) {
        vscode.postMessage({ command, payload });
      }

      function showError(message) {
        if (!message) {
          errorNode.style.display = "none";
          errorNode.textContent = "";
          return;
        }
        errorNode.style.display = "block";
        errorNode.textContent = String(message);
      }

      function formatDate(value) {
        if (!value) return "n/a";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
      }

      for (const button of document.querySelectorAll("button[data-action]")) {
        button.addEventListener("click", () => {
          showError("");
          post(button.getAttribute("data-action") || "");
        });
      }

      document.getElementById("submitObservation").addEventListener("click", () => {
        showError("");
        post("add-observation", {
          project: document.getElementById("obsProject").value,
          type: document.getElementById("obsType").value,
          title: document.getElementById("obsTitle").value,
          content: document.getElementById("obsContent").value,
          tags: document.getElementById("obsTags").value,
          files: document.getElementById("obsFiles").value
        });
      });

      document.getElementById("submitSummary").addEventListener("click", () => {
        showError("");
        post("add-summary", {
          project: document.getElementById("sumProject").value,
          learned: document.getElementById("sumLearned").value,
          request: document.getElementById("sumRequest").value,
          completed: document.getElementById("sumCompleted").value,
          nextSteps: document.getElementById("sumNextSteps").value,
          tags: document.getElementById("sumTags").value
        });
      });

      window.addEventListener("message", (event) => {
        const message = event.data || {};
        if (message.command === "status") {
          const payload = message.payload || {};
          const running = payload.workerRunning === true;
          statusWorker.textContent = running ? "v2 SQLite" : "Unavailable";
          statusWorker.className = running ? "pill ok" : "pill warn";
          statusEntries.textContent = String(payload.entriesTotal ?? 0);
          statusProjects.textContent = String(payload.projectsTotal ?? 0);
          statusDb.textContent = String(payload.dataFile ?? "n/a");
          statusUpdated.textContent = formatDate(payload.updatedAt);
          showError("");
          return;
        }

        if (message.command === "clear-observation") {
          document.getElementById("obsTitle").value = "";
          document.getElementById("obsContent").value = "";
          document.getElementById("obsTags").value = "";
          document.getElementById("obsFiles").value = "";
          return;
        }

        if (message.command === "clear-summary") {
          document.getElementById("sumLearned").value = "";
          document.getElementById("sumRequest").value = "";
          document.getElementById("sumCompleted").value = "";
          document.getElementById("sumNextSteps").value = "";
          document.getElementById("sumTags").value = "";
          return;
        }

        if (message.command === "error") {
          showError((message.payload && message.payload.message) || "Unknown error");
        }
      });

      post("refresh-status");
    </script>
  </body>
</html>`;
}

function getDashboardHtml(data: DashboardData, loading: boolean): string {
  const nonce = String(Date.now());
  const workerState = data.worker.running ? "Running" : "Stopped";
  const workerStateClass = data.worker.running ? "status-ok" : "status-warn";
  const mcpStateClass = data.mcp.configured ? "status-ok" : "status-warn";
  const mcpState = data.mcp.configured ? "Configured" : "Missing";
  const liveAgentCards = renderLiveAgentCards(data.liveAgents);
  const liveAgentSwarm = renderLiveAgentSwarm(data.liveAgents);
  const providerSyncRows =
    data.ingestion.byProvider.length > 0
      ? data.ingestion.byProvider
          .map(
            (item) => `
              <tr>
                <td>${escapeHtml(item.provider)}</td>
                <td>${item.detected}</td>
                <td>${item.imported}</td>
                <td>${item.skipped}</td>
                <td>${item.failed}</td>
              </tr>
            `,
          )
          .join("")
      : `<tr><td colspan="5" class="muted">No provider data yet.</td></tr>`;
  const projectRows =
    data.execution.projects.length > 0
      ? data.execution.projects
          .map(
            (project) => `
              <tr data-project="${escapeHtml(project.project)}">
                <td>${escapeHtml(project.project)}</td>
                <td>${project.total}</td>
                <td>${project.completed}</td>
                <td>${project.failed}</td>
                <td>${escapeHtml(project.providers.slice(0, 3).join(", ") || "n/a")}</td>
                <td>${escapeHtml(formatIso(project.latestAt))}</td>
              </tr>
            `,
          )
          .join("")
      : `<tr><td colspan="6" class="muted">No project execution data yet.</td></tr>`;
  const providerBars = renderBars(data.execution.providers, "provider");
  const agentBars = renderBars(data.execution.agents, "agent");
  const modelBars = renderBars(data.execution.models, "model");
  const statusBars = renderBars(data.execution.statuses, "status");
  const dbKindBars = renderBars(data.db.kindCounts, "entry kind");
  const dbProjectBars = renderBars(data.db.projectCounts, "project");
  const dbTypeBars = renderBars(
    data.db.observationTypeCounts,
    "observation type",
  );
  const dbDailyBars = renderBars(data.db.dailyCounts, "day");
  const dbLatestRows =
    data.db.latestEntries.length > 0
      ? data.db.latestEntries
          .map(
            (entry) => `
              <tr>
                <td>${entry.id}</td>
                <td>${escapeHtml(formatIsoCompact(entry.createdAt))}</td>
                <td>${escapeHtml(entry.project)}</td>
                <td>${escapeHtml(entry.kind)}</td>
                <td>${escapeHtml(entry.observationType)}</td>
                <td>${entry.tagsCount}</td>
                <td title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</td>
              </tr>
            `,
          )
          .join("")
      : `<tr><td colspan="7" class="muted">No DB entries found yet.</td></tr>`;
  const taskDataJson = toScriptJson(data.execution.tasks);

  const errorBlock = data.error
    ? `<div class="error-box">Dashboard error: ${escapeHtml(data.error)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Retentia Dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-0: #0d1117;
        --bg-1: #141b24;
        --bg-2: #1d2633;
        --fg-0: #f2f6fa;
        --fg-1: #bac8d8;
        --accent: #26a269;
        --warn: #e5a50a;
        --danger: #e66100;
        --line: #293444;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Segoe UI", "IBM Plex Sans", "Noto Sans", sans-serif;
        background: radial-gradient(circle at 20% 0%, #1f2f44 0%, var(--bg-0) 55%);
        color: var(--fg-0);
      }

      .wrap {
        padding: 20px;
        max-width: 1100px;
        margin: 0 auto;
      }

      .topbar {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
      }

      .title {
        font-size: 22px;
        font-weight: 700;
        letter-spacing: 0.2px;
      }

      .subtitle {
        color: var(--fg-1);
        font-size: 12px;
      }

      .actions {
        display: flex;
        gap: 8px;
      }

      button {
        border: 1px solid var(--line);
        background: linear-gradient(180deg, #202b39, #141c27);
        color: var(--fg-0);
        padding: 8px 11px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 12px;
      }

      button:hover {
        border-color: #3c4f69;
      }

      .cards {
        display: grid;
        grid-template-columns: repeat(6, minmax(140px, 1fr));
        gap: 10px;
        margin-bottom: 12px;
      }

      .card {
        background: linear-gradient(170deg, var(--bg-1), var(--bg-2));
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
      }

      .label {
        color: var(--fg-1);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 7px;
      }

      .value {
        font-size: 22px;
        font-weight: 700;
      }

      .status-pill {
        display: inline-block;
        margin-top: 4px;
        padding: 3px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
      }

      .status-ok {
        background: rgba(38, 162, 105, 0.18);
        color: #7ce6b7;
      }

      .status-warn {
        background: rgba(229, 165, 10, 0.2);
        color: #ffd387;
      }

      .panels {
        display: grid;
        grid-template-columns: 1.1fr 1fr;
        gap: 12px;
      }

      .panel {
        background: linear-gradient(170deg, #152030, #0f1723);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
      }

      .panel h3 {
        margin: 0 0 10px;
        font-size: 14px;
      }

      .kv {
        display: grid;
        grid-template-columns: 140px 1fr;
        gap: 6px;
        font-size: 12px;
      }

      .kv .k {
        color: var(--fg-1);
      }

      .tasks {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 320px;
        overflow: auto;
      }

      .subgrid {
        display: grid;
        grid-template-columns: repeat(2, minmax(140px, 1fr));
        gap: 6px 8px;
        font-size: 12px;
      }

      .bars {
        display: grid;
        gap: 8px;
      }

      .bar {
        display: grid;
        grid-template-columns: 120px 1fr 46px;
        gap: 8px;
        align-items: center;
        font-size: 12px;
      }

      .bar-key {
        color: var(--fg-1);
      }

      .bar-track {
        height: 9px;
        border-radius: 999px;
        background: rgba(188, 204, 221, 0.15);
        overflow: hidden;
      }

      .bar-fill {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, #2b8a3e, #59d089);
      }

      .bar-val {
        text-align: right;
      }

      .table-wrap {
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: 10px;
        margin-top: 6px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      th,
      td {
        padding: 8px 9px;
        border-bottom: 1px solid rgba(188, 204, 221, 0.1);
        text-align: left;
        vertical-align: top;
      }

      th {
        color: var(--fg-1);
        position: sticky;
        top: 0;
        background: #121a24;
        z-index: 1;
      }

      tr[data-project] {
        cursor: pointer;
      }

      tr[data-project]:hover {
        background: rgba(255, 255, 255, 0.04);
      }

      .muted {
        color: var(--fg-1);
      }

      .filter-row {
        display: grid;
        grid-template-columns: repeat(5, minmax(120px, 1fr));
        gap: 8px;
        margin-top: 6px;
      }

      select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #121a24;
        color: var(--fg-0);
        padding: 6px 8px;
        font-size: 12px;
      }

      .task-counter {
        margin-top: 8px;
        color: var(--fg-1);
        font-size: 12px;
      }

      .live-agent-grid {
        display: grid;
        gap: 10px;
      }

      .live-agent-card {
        border: 1px solid rgba(188, 204, 221, 0.12);
        background: linear-gradient(180deg, rgba(29, 38, 51, 0.95), rgba(20, 27, 36, 0.92));
        border-radius: 12px;
        padding: 12px;
      }

      .live-agent-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      .live-agent-name {
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0.01em;
      }

      .live-agent-role {
        color: var(--fg-1);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        margin-top: 4px;
      }

      .live-agent-pill {
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-weight: 700;
      }

      .status-active {
        background: rgba(89, 208, 137, 0.16);
        color: #8ff0ba;
      }

      .status-complete {
        background: rgba(46, 160, 233, 0.16);
        color: #9cdcfe;
      }

      .live-agent-meta {
        margin-top: 8px;
        color: var(--fg-1);
        font-size: 11px;
      }

      .swarm-map {
        min-height: 360px;
        overflow: auto;
        padding: 8px;
        background: linear-gradient(180deg, rgba(18, 26, 36, 0.96), rgba(13, 17, 23, 0.94));
        border-radius: 10px;
        border: 1px solid var(--line);
      }

      .swarm-map svg {
        display: block;
        width: 100%;
        min-width: 760px;
        min-height: 340px;
      }

      .loading {
        color: var(--fg-1);
        font-size: 12px;
        margin-bottom: 10px;
      }

      .error-box {
        border: 1px solid rgba(230, 97, 0, 0.5);
        background: rgba(230, 97, 0, 0.12);
        color: #ffba92;
        border-radius: 10px;
        padding: 9px 10px;
        margin-bottom: 10px;
        font-size: 12px;
      }

      @media (max-width: 900px) {
        .cards {
          grid-template-columns: repeat(2, minmax(140px, 1fr));
        }
        .panels {
          grid-template-columns: 1fr;
        }
        .filter-row {
          grid-template-columns: repeat(2, minmax(120px, 1fr));
        }
        .bar {
          grid-template-columns: 90px 1fr 40px;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="topbar">
        <div>
          <div class="title">Retentia Dashboard</div>
          <div class="subtitle">Updated ${escapeHtml(formatIso(data.generatedAt))}</div>
        </div>
        <div class="actions">
          <button data-cmd="refresh">Refresh</button>
          <button data-cmd="setup">Setup</button>
          <button data-cmd="sync-tasks">Sync LLM Tasks</button>
          <button data-cmd="start-worker">Start Worker</button>
          <button data-cmd="stop-worker">Stop Worker</button>
        </div>
      </div>

      ${loading ? `<div class="loading">Refreshing dashboard data...</div>` : ""}
      ${errorBlock}

      <section class="cards">
        <article class="card">
          <div class="label">Worker</div>
          <div class="value">${escapeHtml(workerState)}</div>
          <div class="status-pill ${workerStateClass}">${escapeHtml(workerState)}</div>
        </article>
        <article class="card">
          <div class="label">MCP</div>
          <div class="value">${escapeHtml(mcpState)}</div>
          <div class="status-pill ${mcpStateClass}">${escapeHtml(mcpState)}</div>
        </article>
        <article class="card">
          <div class="label">Tasks Executed</div>
          <div class="value">${data.kpis.entriesTotal}</div>
        </article>
        <article class="card">
          <div class="label">Projects</div>
          <div class="value">${data.kpis.projectsTotal}</div>
        </article>
        <article class="card">
          <div class="label">Synced (Refresh)</div>
          <div class="value">${data.ingestion.importedTasks}</div>
        </article>
        <article class="card">
          <div class="label">Detected (Recent)</div>
          <div class="value">${data.ingestion.detectedTasks}</div>
        </article>
        <article class="card">
          <div class="label">Providers</div>
          <div class="value">${data.execution.providers.length}</div>
        </article>
        <article class="card">
          <div class="label">Agents</div>
          <div class="value">${data.execution.agents.length}</div>
        </article>
        <article class="card">
          <div class="label">DB Rows (Query)</div>
          <div class="value">${data.db.sampleSize}</div>
        </article>
        <article class="card">
          <div class="label">DB Last 24h</div>
          <div class="value">${data.db.entriesLast24h}</div>
        </article>
        <article class="card">
          <div class="label">DB Active Projects</div>
          <div class="value">${data.db.activeProjects}</div>
        </article>
        <article class="card">
          <div class="label">DB Avg Tags/Entry</div>
          <div class="value">${data.db.avgTagsPerEntry.toFixed(1)}</div>
        </article>
        <article class="card">
          <div class="label">DB Summary Ratio</div>
          <div class="value">${data.db.summaryRatio}%</div>
        </article>
        <article class="card">
          <div class="label">Live Agents</div>
          <div class="value">${data.liveAgents.length}</div>
        </article>
      </section>

      <section class="panels">
        <article class="panel">
          <h3>Runtime + MCP Status</h3>
          <div class="kv">
            <div class="k">Worker PID</div><div>${data.worker.pid ?? "n/a"}</div>
            <div class="k">Worker Uptime</div><div>${escapeHtml(formatUptime(data.worker.uptimeSeconds))}</div>
            <div class="k">Worker Endpoint</div><div>${escapeHtml(data.worker.baseUrl)}</div>
            <div class="k">Worker Host/Port</div><div>${escapeHtml(`${data.worker.host}:${data.worker.port ?? "n/a"}`)}</div>
            <div class="k">MCP Command</div><div>${escapeHtml(data.mcp.command)}</div>
            <div class="k">MCP Args</div><div>${escapeHtml(data.mcp.args.join(" ")) || "n/a"}</div>
            <div class="k">MCP Config</div><div>${escapeHtml(data.mcp.configPath)}</div>
            <div class="k">DB File</div><div>${escapeHtml(data.dataFile)}</div>
            <div class="k">Observations</div><div>${data.kpis.observationsTotal}</div>
            <div class="k">Summaries</div><div>${data.kpis.summariesTotal}</div>
            <div class="k">Latest Entry</div><div>${escapeHtml(formatIso(data.kpis.latestEntryAt))}</div>
            <div class="k">Oldest Entry</div><div>${escapeHtml(formatIso(data.kpis.oldestEntryAt))}</div>
            <div class="k">Auto Sync</div><div>${data.ingestion.autoSyncEnabled ? "Enabled" : "Disabled"}</div>
            <div class="k">Sync Imported</div><div>${data.ingestion.importedTasks}</div>
            <div class="k">Sync Skipped</div><div>${data.ingestion.skippedTasks}</div>
            <div class="k">Sync Errors</div><div>${data.ingestion.failedTasks}</div>
            <div class="k">Newest Task</div><div>${escapeHtml(formatIso(data.ingestion.newestTaskAt))}</div>
          </div>
          <h3 style="margin-top:14px;">Provider Sync</h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Provider</th><th>Detected</th><th>Imported</th><th>Skipped</th><th>Failed</th></tr>
              </thead>
              <tbody>${providerSyncRows}</tbody>
            </table>
          </div>
        </article>
        <article class="panel">
          <h3>Named Codex Agents</h3>
          <div class="live-agent-grid">${liveAgentCards}</div>
        </article>
      </section>

      <section class="panels" style="margin-top:12px;">
        <article class="panel">
          <h3>Live Codex Swarm</h3>
          <div class="swarm-map">${liveAgentSwarm}</div>
        </article>
        <article class="panel">
          <h3>Execution Visualizer</h3>
          <div class="subgrid">
            <div>
              <div class="label">By Provider</div>
              <div class="bars">${providerBars}</div>
            </div>
            <div>
              <div class="label">By Status</div>
              <div class="bars">${statusBars}</div>
            </div>
            <div>
              <div class="label">By Agent</div>
              <div class="bars">${agentBars}</div>
            </div>
            <div>
              <div class="label">By Model</div>
              <div class="bars">${modelBars}</div>
            </div>
          </div>
        </article>
      </section>

      <section class="panel" style="margin-top:12px;">
        <h3>Project Explorer</h3>
        <div class="table-wrap">
          <table id="projectTable">
            <thead>
              <tr>
                <th>Project</th>
                <th>Total</th>
                <th>Done</th>
                <th>Failed</th>
                <th>Providers</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>${projectRows}</tbody>
          </table>
        </div>
      </section>

      <section class="panel" style="margin-top:12px;">
        <h3>DB Query Visualizer</h3>
        <div class="subgrid">
          <div>
            <div class="label">By Kind</div>
            <div class="bars">${dbKindBars}</div>
          </div>
          <div>
            <div class="label">By Observation Type</div>
            <div class="bars">${dbTypeBars}</div>
          </div>
          <div>
            <div class="label">By Project</div>
            <div class="bars">${dbProjectBars}</div>
          </div>
          <div>
            <div class="label">Entries (Last 7 Days)</div>
            <div class="bars">${dbDailyBars}</div>
          </div>
        </div>
      </section>

      <section class="panel" style="margin-top:12px;">
        <h3>Task Explorer</h3>
        <div class="filter-row">
          <select id="filter-project"></select>
          <select id="filter-provider"></select>
          <select id="filter-agent"></select>
          <select id="filter-model"></select>
          <select id="filter-status"></select>
        </div>
        <div class="task-counter" id="taskCounter"></div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Project</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Task</th>
              </tr>
            </thead>
            <tbody id="taskRows">
              <tr><td colspan="7" class="muted">No task execution data available yet.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel" style="margin-top:12px;">
        <h3>Latest 20 DB Entries</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>When</th>
                <th>Project</th>
                <th>Kind</th>
                <th>Type</th>
                <th>Tags</th>
                <th>Title / Learned</th>
              </tr>
            </thead>
            <tbody>${dbLatestRows}</tbody>
          </table>
        </div>
      </section>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const ALL_TASKS = ${taskDataJson};

      for (const button of document.querySelectorAll("button[data-cmd]")) {
        button.addEventListener("click", () => {
          vscode.postMessage({ command: button.getAttribute("data-cmd") });
        });
      }

      const filters = {
        project: document.getElementById("filter-project"),
        provider: document.getElementById("filter-provider"),
        agent: document.getElementById("filter-agent"),
        model: document.getElementById("filter-model"),
        status: document.getElementById("filter-status")
      };
      const taskRows = document.getElementById("taskRows");
      const taskCounter = document.getElementById("taskCounter");

      function uniqueSorted(values) {
        return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
      }

      function initFilter(select, values, label) {
        const options = ['<option value="">' + escape(label) + ': all</option>'];
        for (const value of values) {
          options.push(
            '<option value="' + escape(value) + '">' + escape(value) + '</option>'
          );
        }
        select.innerHTML = options.join("");
      }

      function escape(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function formatWhen(value) {
        if (!value) return "n/a";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
      }

      function renderTasks() {
        const filtered = ALL_TASKS.filter((task) => {
          if (filters.project.value && task.project !== filters.project.value) return false;
          if (filters.provider.value && task.provider !== filters.provider.value) return false;
          if (filters.agent.value && task.agent !== filters.agent.value) return false;
          if (filters.model.value && task.model !== filters.model.value) return false;
          if (filters.status.value && task.status !== filters.status.value) return false;
          return true;
        });

        taskCounter.textContent =
          "Showing " + filtered.length + " of " + ALL_TASKS.length + " tasks";

        if (filtered.length === 0) {
          taskRows.innerHTML =
            '<tr><td colspan="7" class="muted">No tasks match current filters.</td></tr>';
          return;
        }

        const rows = filtered
          .slice(0, 300)
          .map(
            (task) =>
              "<tr>" +
              "<td>" + escape(formatWhen(task.createdAt)) + "</td>" +
              "<td>" + escape(task.project) + "</td>" +
              "<td>" + escape(task.provider) + "</td>" +
              "<td>" + escape(task.model) + "</td>" +
              "<td>" + escape(task.agent) + "</td>" +
              "<td>" + escape(task.status) + "</td>" +
              '<td title="' + escape(task.excerpt || "") + '">' + escape(task.title) + "</td>" +
              "</tr>"
          )
          .join("");

        taskRows.innerHTML = rows;
      }

      initFilter(filters.project, uniqueSorted(ALL_TASKS.map((item) => item.project)), "Project");
      initFilter(filters.provider, uniqueSorted(ALL_TASKS.map((item) => item.provider)), "Provider");
      initFilter(filters.agent, uniqueSorted(ALL_TASKS.map((item) => item.agent)), "Agent");
      initFilter(filters.model, uniqueSorted(ALL_TASKS.map((item) => item.model)), "Model");
      initFilter(filters.status, uniqueSorted(ALL_TASKS.map((item) => item.status)), "Status");

      for (const filter of Object.values(filters)) {
        filter.addEventListener("change", renderTasks);
      }

      for (const row of document.querySelectorAll("#projectTable tr[data-project]")) {
        row.addEventListener("click", () => {
          const project = row.getAttribute("data-project") || "";
          filters.project.value = project;
          renderTasks();
        });
      }

      renderTasks();
    </script>
  </body>
</html>`;
}

function renderBars(
  items: Array<{ key: string; count: number }>,
  label: string,
): string {
  if (items.length === 0) {
    return `<div class="muted">No ${escapeHtml(label)} data</div>`;
  }

  const maxCount = Math.max(...items.map((item) => item.count), 1);
  return items
    .slice(0, 8)
    .map((item) => {
      const width = Math.round((item.count / maxCount) * 100);
      return `
        <div class="bar">
          <div class="bar-key">${escapeHtml(item.key)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
          <div class="bar-val">${item.count}</div>
        </div>
      `;
    })
    .join("");
}

function toScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function toRecord(value: unknown): JsonResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonResult;
}

function toText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined) {
    return "n/a";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours}h ${minutes}m ${remainingSeconds}s`;
}

function formatIso(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.toLocaleString()} (${value})`;
}

function formatIsoCompact(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}
