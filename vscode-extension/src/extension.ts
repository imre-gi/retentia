import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, isAbsolute } from "node:path";
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

interface LiveAgentSnapshot {
  id: string;
  nickname: string;
  role: string;
  status: "active" | "completed";
  lastSeenAt: string;
  source: string;
  sessionFile: string;
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
const DEFAULT_AUTO_SYNC_LOOKBACK_DAYS = 7;
const DEFAULT_AUTO_SYNC_MAX_IMPORT = 25;
const DEFAULT_AUTO_SYNC_MAX_FILES = 24;
const DEFAULT_DASHBOARD_LIMIT = 600;
const REPOSITORY_NAME_CACHE = new Map<string, string>();
const REVIEW_CONFIDENCE_THRESHOLD = 0.9;
const PROBABLY_LOW_CONFIDENCE_THRESHOLD = 0.6;
const STALE_MEMORY_REVIEW_DAYS = 90;
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
    vscode.commands.registerCommand("retentia.installMcp", async () => {
      await runAndShowJson(
        ["install", "--client", "codex"],
        "Retentia MCP installation completed for Codex.",
      );
      await sidebarProvider.refreshStatus();
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

            if (cmd === "install-mcp") {
              await runAndShowJson(
                ["install", "--client", "codex"],
                "Retentia MCP installation completed for Codex.",
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

            if (cmd === "memory-review-update") {
              await updateMemoryReviewFromDashboard(message);
              await renderDashboardPanel(dashboardPanel);
              return;
            }

            if (cmd === "memory-delete") {
              const deleted = await deleteMemoryFromDashboard(message);
              if (deleted) {
                await renderDashboardPanel(dashboardPanel);
              }
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
          engineAvailable: true,
          entriesTotal: toNumber(totals.memories) ?? 0,
          projectsTotal: toNumber(totals.projects) ?? 0,
          dataFile: toText(payload.dataFile) || "n/a",
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

      if (command === "install-mcp") {
        await runAndShowJson(
          ["install", "--client", "codex"],
          "Retentia MCP installation completed for Codex.",
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

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return workspacePath ? resolveRepositoryName(workspacePath) : undefined;
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
      String(getDashboardLimit()),
    ]),
  );
  const health = toRecord(await runCliJson(["doctor"]));
  return { ...dashboard, health };
}

async function updateMemoryReviewFromDashboard(message: unknown): Promise<void> {
  const input = toRecord(message);
  const id = toNumber(input.id);
  const confidencePercent = toNumber(input.confidencePercent);
  const comment = (toText(input.comment) || "").trim();
  if (id === undefined || !Number.isInteger(id) || id <= 0) {
    vscode.window.showErrorMessage("Retentia memory update failed: invalid memory id.");
    return;
  }
  if (
    confidencePercent === undefined ||
    confidencePercent < 0 ||
    confidencePercent > 100
  ) {
    vscode.window.showErrorMessage(
      "Retentia memory update failed: confidence must be 0-100.",
    );
    return;
  }
  if (!comment) {
    vscode.window.showWarningMessage(
      "Add a review comment before changing memory confidence.",
    );
    return;
  }

  const current = toRecord(await runCliJson(["memory-get", "--id", String(id)]));
  const confidence = Math.round(confidencePercent) / 100;
  const body = appendMemoryReviewNote(
    toText(current.body) || "",
    confidencePercent,
    comment,
  );
  await runCliJson([
    "memory-update",
    "--id",
    String(id),
    "--confidence",
    String(confidence),
    "--body",
    body,
  ]);
  vscode.window.showInformationMessage(`Updated memory #${id}.`);
}

async function deleteMemoryFromDashboard(message: unknown): Promise<boolean> {
  const input = toRecord(message);
  const id = toNumber(input.id);
  const title = toText(input.title) || `memory #${id}`;
  if (id === undefined || !Number.isInteger(id) || id <= 0) {
    vscode.window.showErrorMessage("Retentia memory delete failed: invalid memory id.");
    return false;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Delete ${title}? This removes the durable memory and memory-scoped evidence.`,
    { modal: true },
    "Delete",
  );
  if (confirmed !== "Delete") {
    return false;
  }

  await runCliJson(["memory-delete", "--id", String(id), "--yes"]);
  vscode.window.showInformationMessage(`Deleted memory #${id}.`);
  return true;
}

function appendMemoryReviewNote(
  currentBody: string,
  confidencePercent: number,
  comment: string,
): string {
  const normalizedBody = currentBody.trimEnd();
  const timestamp = new Date().toISOString();
  const note = [
    `Review note (${timestamp})`,
    `Confidence set to ${Math.round(confidencePercent)}%.`,
    `Comment: ${comment}`,
  ].join("\n");
  return normalizedBody ? `${normalizedBody}\n\n${note}` : note;
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
    quality: {
      memoryTotal: 0,
      activeMemoryTotal: 0,
      sampleSize: 0,
      averageConfidence: 0,
      highConfidence: 0,
      lowConfidence: 0,
      pinnedTotal: 0,
      evidenceChunks: 0,
      evidenceCoverage: null,
      staleMemories: 0,
      kindCounts: [],
    },
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
        --bg: oklch(0.16 0.014 246);
        --bg-2: oklch(0.19 0.016 246);
        --panel: oklch(0.215 0.018 246);
        --panel2: oklch(0.255 0.02 246);
        --line: oklch(0.38 0.026 246);
        --line-soft: oklch(0.31 0.02 246);
        --text: oklch(0.94 0.008 246);
        --muted: oklch(0.72 0.017 246);
        --green: oklch(0.72 0.14 155);
        --amber: oklch(0.78 0.14 80);
        --red: oklch(0.68 0.16 35);
        --blue: oklch(0.7 0.12 235);
        --violet: oklch(0.72 0.1 292);
      }
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; min-height: 100%; }
      body { margin: 0; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); }
      .shell { width: 100%; height: 100vh; min-height: 0; padding: 14px; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 10px; overflow: hidden; }
      .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; border: 1px solid var(--line-soft); background: var(--bg-2); border-radius: 8px; padding: 10px 12px; }
      h1 { margin: 0; font-size: 18px; font-weight: 720; letter-spacing: 0; }
      .sub { color: var(--muted); font-size: 12px; margin-top: 3px; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
      button { border: 1px solid var(--line); background: var(--panel2); color: var(--text); border-radius: 7px; padding: 7px 10px; cursor: pointer; font: inherit; font-size: 12px; }
      button:hover { border-color: var(--blue); background: oklch(0.28 0.025 246); }
      button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
      .tab { color: var(--muted); background: transparent; }
      .tab.active { color: var(--text); border-color: var(--blue); background: color-mix(in oklch, var(--blue), transparent 82%); }
      .live { display: inline-flex; align-items: center; gap: 7px; color: var(--green); font-size: 12px; min-height: 30px; }
      .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--green); box-shadow: 0 0 0 5px color-mix(in oklch, var(--green), transparent 84%); }
      #dashboardError:empty { display: none; }
      .panel, .map-panel, .inspector { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; }
      .insight-plane { min-height: 0; overflow: auto; display: grid; gap: 10px; }
      .insight-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: 76px; gap: 10px; }
      .wide-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); gap: 10px; }
      .trend-plane { padding: 10px 12px; display: grid; gap: 10px; }
      .trend-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .trend-card { min-width: 0; display: grid; gap: 8px; }
      .trend-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 700; }
      .trend-bars { height: 74px; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; align-items: end; gap: 4px; border-bottom: 1px solid var(--line); padding-top: 6px; }
      .trend-bar { min-width: 0; border-radius: 4px 4px 0 0; background: var(--blue); position: relative; }
      .trend-bar.failed { background: var(--red); }
      .trend-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; color: var(--muted); font-size: 11px; }
      .workbench { min-height: 0; height: 100%; max-height: 100%; overflow: hidden; display: grid; grid-template-columns: minmax(0, 1fr) minmax(330px, 390px); gap: 10px; }
      .map-panel, .inspector { min-width: 0; min-height: 0; height: 100%; max-height: 100%; overflow: hidden; display: flex; flex-direction: column; }
      .panel-head { flex: 0 0 auto; padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
      .panel-head h2 { margin: 0; font-size: 14px; }
      .panel-head-copy { min-width: 0; display: grid; gap: 2px; }
      .panel-head-copy .muted { font-size: 11px; }
      .map-panel .panel-head { flex-wrap: wrap; }
      .map-controls { display: flex; align-items: center; gap: 5px; }
      .map-control { min-width: 30px; height: 28px; padding: 3px 8px; line-height: 1; font-variant-numeric: tabular-nums; }
      .map-control.zoom-reset { min-width: 48px; }
      .map-control.zoom-fit { min-width: 42px; }
      .map-control:disabled { opacity: .45; cursor: not-allowed; }
      .map-control:disabled:hover { border-color: var(--line); background: var(--panel2); }
      .graph { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; padding: 10px; background: oklch(0.19 0.018 248); overscroll-behavior: contain; cursor: grab; touch-action: none; }
      .graph.is-panning { cursor: grabbing; user-select: none; }
      .graph:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
      .graph svg { display: block; width: 100%; min-width: 680px; height: auto; min-height: 500px; overflow: visible; }
      .map-edge { stroke-linecap: round; }
      .map-edge-active { stroke-dasharray: 8 10; animation: map-edge-flow 900ms linear infinite; }
      .map-edge-delegation { stroke-dasharray: 5 5; }
      .map-edge-spawn { stroke-dasharray: 5 6; }
      .map-edge-persisted { opacity: .45; }
      .map-node { cursor: pointer; }
      .map-node text { pointer-events: none; }
      .map-node-card { transition: fill 120ms ease-out, stroke 120ms ease-out, stroke-width 120ms ease-out; }
      .map-node:hover .map-node-card { fill: oklch(0.25 0.024 248); stroke-width: 2; }
      .map-node.selected .map-node-card { stroke: var(--amber); stroke-width: 2; }
      @keyframes map-edge-flow { from { stroke-dashoffset: 18; } to { stroke-dashoffset: 0; } }
      .inspector-body { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; padding: 12px; display: grid; align-content: start; gap: 12px; overscroll-behavior: contain; }
      .focus-title { min-width: 0; font-size: 16px; line-height: 1.25; font-weight: 760; margin-bottom: 4px; overflow-wrap: anywhere; }
      .focus-subtitle { min-width: 0; color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
      .kv { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 6px 10px; font-size: 12px; }
      .kv > div { min-width: 0; overflow-wrap: anywhere; }
      .kv .key { color: var(--muted); }
      .section { min-width: 0; border-top: 1px solid color-mix(in oklch, var(--line), transparent 35%); padding-top: 10px; }
      .section h3 { margin: 0 0 6px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
      ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 7px; }
      li { min-width: 0; border-bottom: 1px solid color-mix(in oklch, var(--line), transparent 45%); padding-bottom: 7px; display: grid; gap: 3px; }
      li strong, li span { min-width: 0; overflow-wrap: anywhere; }
      li span, .muted { color: var(--muted); }
      code { max-width: 100%; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
      .state { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; padding: 2px 7px; font-size: 11px; color: var(--muted); }
      .state-active { color: var(--green); border-color: color-mix(in oklch, var(--green), transparent 35%); }
      .state-completed { color: var(--blue); border-color: color-mix(in oklch, var(--blue), transparent 35%); }
      .state-failed { color: var(--red); border-color: color-mix(in oklch, var(--red), transparent 35%); }
      .state-pass { color: var(--green); border-color: color-mix(in oklch, var(--green), transparent 35%); }
      .state-warn { color: var(--amber); border-color: color-mix(in oklch, var(--amber), transparent 35%); }
      .state-bad, .state-fail { color: var(--red); border-color: color-mix(in oklch, var(--red), transparent 35%); }
      .text-block, .reasoning, .context { min-width: 0; max-width: 100%; margin: 0; white-space: pre-wrap; overflow-x: hidden; overflow-y: auto; overflow-wrap: anywhere; word-break: break-word; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.45; }
      .text-block { max-height: 280px; padding: 8px; border: 1px solid var(--line-soft); border-radius: 8px; background: oklch(0.17 0.014 246); }
      .text-block.compact { max-height: 160px; }
      .activity-item { gap: 6px; }
      .activity-meta { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .activity-summary { min-width: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
      .health-plane { padding: 10px 12px; display: grid; gap: 8px; min-width: 0; }
      .health-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .health-item { border: 1px solid var(--line); border-radius: 8px; padding: 8px; min-width: 0; }
      .health-item strong { display: block; font-size: 12px; margin-bottom: 4px; }
      .stat-tile { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 10px 12px; min-width: 0; display: grid; gap: 4px; }
      button.stat-tile { width: 100%; height: 100%; color: inherit; text-align: left; }
      button.stat-tile:hover { background: oklch(0.24 0.02 248); }
      .insight-grid .stat-tile { height: 76px; align-content: start; overflow: hidden; }
      .stat-tile strong { font-size: 20px; line-height: 1.15; }
      .stat-tile span { color: var(--muted); font-size: 12px; }
      .insight-grid .stat-tile strong, .insight-grid .stat-tile span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .stat-tile.good strong { color: var(--green); }
      .stat-tile.warn strong { color: var(--amber); }
      .stat-tile.bad strong { color: var(--red); }
      .stat-panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; min-width: 0; overflow: hidden; }
      .stat-body { padding: 10px 12px; display: grid; gap: 10px; }
      .meter-row { display: grid; gap: 5px; }
      .meter-label { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; }
      .meter { height: 8px; border-radius: 999px; background: oklch(0.17 0.014 246); overflow: hidden; border: 1px solid var(--line-soft); }
      .meter-fill { height: 100%; width: var(--value); background: var(--blue); }
      .meter-fill.good { background: var(--green); }
      .meter-fill.warn { background: var(--amber); }
      .meter-fill.bad { background: var(--red); }
      .distribution { display: grid; gap: 8px; }
      .dist-row { display: grid; grid-template-columns: minmax(80px, .8fr) minmax(90px, 1fr) auto; gap: 8px; align-items: center; font-size: 12px; }
      .dist-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dist-bar { height: 7px; border-radius: 999px; background: oklch(0.17 0.014 246); overflow: hidden; border: 1px solid var(--line-soft); }
      .dist-fill { height: 100%; width: var(--value); background: var(--violet); }
      .dist-value { color: var(--muted); font-variant-numeric: tabular-nums; }
      .full-span { grid-column: 1 / -1; }
      .review-toolbar { display: flex; flex-wrap: wrap; gap: 7px; }
      .review-filter { color: var(--muted); }
      .review-filter.active { color: var(--text); border-color: var(--blue); background: color-mix(in oklch, var(--blue), transparent 82%); }
      .review-summary { color: var(--muted); font-size: 12px; }
      .memory-review-list { display: grid; gap: 0; max-height: min(54vh, 620px); overflow: auto; overscroll-behavior: contain; border-top: 1px solid var(--line-soft); }
      .memory-review-item { min-width: 0; padding: 10px 0; display: grid; gap: 8px; }
      .memory-review-top { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; }
      .memory-review-title { min-width: 0; display: grid; gap: 3px; }
      .memory-review-title strong { overflow-wrap: anywhere; }
      .memory-review-meta, .memory-badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--muted); font-size: 11px; }
      .memory-review-actions { display: grid; grid-template-columns: minmax(112px, 140px) minmax(0, 1fr) auto auto; gap: 8px; align-items: end; }
      .memory-review-actions label { display: grid; gap: 4px; color: var(--muted); font-size: 11px; }
      .memory-review-actions input, .memory-review-actions textarea { width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 7px; background: oklch(0.17 0.014 246); color: var(--text); font: inherit; font-size: 12px; padding: 7px 8px; }
      .memory-review-actions textarea { min-height: 32px; max-height: 96px; resize: vertical; }
      .memory-review-actions input:focus-visible, .memory-review-actions textarea:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
      .danger-button { border-color: color-mix(in oklch, var(--red), transparent 35%); color: var(--red); }
      .danger-button:hover { border-color: var(--red); background: color-mix(in oklch, var(--red), transparent 88%); }
      .badge { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 2px 7px; color: var(--muted); }
      .badge.good { color: var(--green); border-color: color-mix(in oklch, var(--green), transparent 45%); }
      .badge.warn { color: var(--amber); border-color: color-mix(in oklch, var(--amber), transparent 45%); }
      .badge.bad { color: var(--red); border-color: color-mix(in oklch, var(--red), transparent 45%); }
      .overview-plane { min-height: 0; overflow: auto; padding: 12px; display: grid; align-content: start; gap: 14px; }
      .overview-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
      .overview-head h2 { margin: 0; font-size: 14px; }
      .overview-kpi-grid { display: grid; grid-template-columns: repeat(3, minmax(180px, 1fr)); grid-auto-rows: minmax(132px, auto); gap: 12px; }
      .kpi-card { min-width: 0; min-height: 132px; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 14px; display: grid; grid-template-rows: auto 1fr auto; gap: 12px; overflow: hidden; }
      .kpi-card.primary { grid-column: span 2; min-height: 160px; background: oklch(0.225 0.02 248); }
      .kpi-card-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .kpi-label { min-width: 0; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .kpi-marker { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 999px; background: var(--muted); box-shadow: 0 0 0 5px color-mix(in oklch, var(--muted), transparent 88%); }
      .kpi-marker.accent { background: var(--blue); box-shadow: 0 0 0 5px color-mix(in oklch, var(--blue), transparent 86%); }
      .kpi-marker.good { background: var(--green); box-shadow: 0 0 0 5px color-mix(in oklch, var(--green), transparent 86%); }
      .kpi-marker.warn { background: var(--amber); box-shadow: 0 0 0 5px color-mix(in oklch, var(--amber), transparent 86%); }
      .kpi-value { align-self: end; min-width: 0; font-size: 34px; line-height: 1; font-weight: 760; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .kpi-card.primary .kpi-value { font-size: 44px; }
      .kpi-detail { color: var(--muted); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
      .memory-plane { min-height: 0; overflow: auto; padding: 12px; }
      .hidden { display: none; }
      .error { border: 1px solid var(--red); color: var(--red); padding: 10px; border-radius: 8px; margin-bottom: 12px; }
      @media (max-width: 1120px) { .overview-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .insight-grid, .wide-grid, .memory-review-actions { grid-template-columns: 1fr; } }
      @media (max-width: 980px) { .overview-kpi-grid, .trend-grid, .workbench { grid-template-columns: 1fr; } .kpi-card.primary { grid-column: auto; } .workbench { grid-template-rows: minmax(0, 1fr) minmax(0, .8fr); } .top { align-items: flex-start; flex-direction: column; } .actions { justify-content: flex-start; } .graph svg { min-width: 680px; min-height: 480px; } .health-list { grid-template-columns: 1fr; } }
      @media (prefers-reduced-motion: reduce) { .map-edge-active { animation: none; } }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="top">
        <div><h1>Retentia Control Plane</h1><div id="dashboardSubtitle" class="sub">${loading ? "Waiting for Retentia stream" : "Retentia stream"}</div></div>
        <div class="actions"><button class="tab active" data-view="overview">Overview</button><button class="tab" data-view="control">Control</button><button class="tab" data-view="memory">Memory</button><button class="tab" data-view="quality">Retrieval</button><button class="tab" data-view="operations">Operations</button><span id="streamState" class="live"><span class="dot"></span>Connecting</span></div>
      </div>
      <div id="dashboardError"></div>
      <section id="overviewPlane" class="overview-plane"><div class="overview-head"><h2>Overview</h2><span class="muted">Live Retentia totals</span></div><div id="metricStrip" class="overview-kpi-grid"></div></section>
      <section id="controlPlane" class="workbench hidden">
        <div class="map-panel"><div class="panel-head"><div class="panel-head-copy"><h2>Agent Task Map</h2><span class="muted">Select latest active task in inspector</span></div><div class="map-controls" role="group" aria-label="Agent task map zoom controls"><button type="button" class="map-control" data-graph-zoom="out" aria-label="Zoom out" title="Zoom out">−</button><button type="button" class="map-control zoom-reset" data-graph-zoom="reset" aria-label="Reset zoom to 100 percent" title="Reset zoom"><span id="graphZoomValue" aria-live="polite">100%</span></button><button type="button" class="map-control" data-graph-zoom="in" aria-label="Zoom in" title="Zoom in">+</button><button type="button" class="map-control zoom-fit" data-graph-zoom="fit" aria-label="Fit map in viewport" title="Fit map in viewport">Fit</button></div></div><div id="graph" class="graph" tabindex="0" aria-label="Agent task map. Use Control or Command plus the mouse wheel, or the zoom controls, to zoom. Drag the background to pan."></div></div>
        <aside class="inspector"><div class="panel-head"><h2>Inspector</h2><span id="updatedAt" class="muted">n/a</span></div><div id="inspectorBody" class="inspector-body"></div></aside>
      </section>
      <section id="memoryPlane" class="panel memory-plane hidden"></section>
      <section id="qualityPlane" class="insight-plane hidden"></section>
      <section id="operationsPlane" class="insight-plane hidden"></section>
    </main>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      let pending = false;
      let lastSignature = "";
      let currentView = "overview";
      let selectedNodeId = "";
      let currentReviewFilter = "needs-review";
      let detailsByNode = {};
      let graphZoom = 1;
      let graphPan = null;
      let graphViewport = { left: 0, top: 0 };
      const graphZoomMin = 0.5;
      const graphZoomMax = 2.5;
      const graphZoomStep = 0.15;

      function setHtml(id, html) {
        const node = document.getElementById(id);
        if (node) node.innerHTML = html || "";
      }

      function getGraphElements() {
        const graph = document.getElementById("graph");
        const svg = graph ? graph.querySelector("svg") : null;
        return { graph, svg };
      }

      function getGraphBaseSize(svg) {
        const savedWidth = Number(svg.dataset.graphBaseWidth || "0");
        const savedHeight = Number(svg.dataset.graphBaseHeight || "0");
        if (savedWidth > 0 && savedHeight > 0) {
          return { width: savedWidth, height: savedHeight };
        }
        const bounds = svg.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return null;
        svg.dataset.graphBaseWidth = String(bounds.width);
        svg.dataset.graphBaseHeight = String(bounds.height);
        return { width: bounds.width, height: bounds.height };
      }

      function updateGraphZoomControls() {
        const hasGraph = Boolean(getGraphElements().svg);
        const zoomValue = document.getElementById("graphZoomValue");
        if (zoomValue) zoomValue.textContent = Math.round(graphZoom * 100) + "%";
        for (const button of document.querySelectorAll("button[data-graph-zoom]")) {
          const action = button.getAttribute("data-graph-zoom");
          button.disabled = !hasGraph ||
            (action === "out" && graphZoom <= graphZoomMin) ||
            (action === "in" && graphZoom >= graphZoomMax) ||
            (action === "reset" && Math.abs(graphZoom - 1) < 0.001);
        }
      }

      function applyGraphZoom() {
        const { graph, svg } = getGraphElements();
        updateGraphZoomControls();
        if (!graph || !svg) return false;
        const baseSize = getGraphBaseSize(svg);
        if (!baseSize) return false;
        const width = baseSize.width * graphZoom;
        const height = baseSize.height * graphZoom;
        svg.style.width = width + "px";
        svg.style.minWidth = width + "px";
        svg.style.height = height + "px";
        svg.style.minHeight = height + "px";
        return true;
      }

      function rememberGraphViewport() {
        const graph = document.getElementById("graph");
        if (!graph || graph.clientWidth <= 0 || graph.clientHeight <= 0) return;
        graphViewport = { left: graph.scrollLeft, top: graph.scrollTop };
      }

      function restoreGraphViewport() {
        const graph = document.getElementById("graph");
        if (!graph || graph.clientWidth <= 0 || graph.clientHeight <= 0) return;
        graph.scrollLeft = graphViewport.left;
        graph.scrollTop = graphViewport.top;
        graphViewport = { left: graph.scrollLeft, top: graph.scrollTop };
      }

      function setGraphZoom(nextZoom, anchor) {
        const { graph, svg } = getGraphElements();
        if (!graph || !svg) return;
        const oldZoom = graphZoom;
        const clampedZoom = Math.min(graphZoomMax, Math.max(graphZoomMin, nextZoom));
        if (Math.abs(clampedZoom - oldZoom) < 0.001) return;
        const viewportX = anchor && Number.isFinite(anchor.x) ? anchor.x : graph.clientWidth / 2;
        const viewportY = anchor && Number.isFinite(anchor.y) ? anchor.y : graph.clientHeight / 2;
        const contentX = graph.scrollLeft + viewportX;
        const contentY = graph.scrollTop + viewportY;
        graphZoom = clampedZoom;
        if (!applyGraphZoom()) return;
        const ratio = graphZoom / oldZoom;
        graphViewport = {
          left: contentX * ratio - viewportX,
          top: contentY * ratio - viewportY
        };
        restoreGraphViewport();
      }

      function fitGraphInViewport() {
        const { graph, svg } = getGraphElements();
        if (!graph || !svg) return;
        const baseSize = getGraphBaseSize(svg);
        if (!baseSize) return;
        const availableWidth = Math.max(1, graph.clientWidth - 20);
        const availableHeight = Math.max(1, graph.clientHeight - 20);
        graphZoom = Math.min(
          graphZoomMax,
          Math.max(graphZoomMin, Math.min(availableWidth / baseSize.width, availableHeight / baseSize.height))
        );
        applyGraphZoom();
        graphViewport = { left: 0, top: 0 };
        restoreGraphViewport();
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
        const allowed = new Set(["overview", "control", "memory", "quality", "operations"]);
        currentView = allowed.has(view) ? view : "overview";
        document.getElementById("overviewPlane").classList.toggle("hidden", currentView !== "overview");
        document.getElementById("controlPlane").classList.toggle("hidden", currentView !== "control");
        document.getElementById("memoryPlane").classList.toggle("hidden", currentView !== "memory");
        document.getElementById("qualityPlane").classList.toggle("hidden", currentView !== "quality");
        document.getElementById("operationsPlane").classList.toggle("hidden", currentView !== "operations");
        for (const button of document.querySelectorAll("button[data-view]")) {
          button.classList.toggle("active", button.getAttribute("data-view") === currentView);
        }
        if (currentView === "memory") applyReviewFilter();
        if (currentView === "control") {
          window.requestAnimationFrame(() => {
            applyGraphZoom();
            restoreGraphViewport();
          });
        }
      }

      function applyReviewFilter() {
        const filter = currentReviewFilter || "all";
        let visible = 0;
        let total = 0;
        for (const item of document.querySelectorAll("[data-review-filters]")) {
          total += 1;
          const filters = String(item.getAttribute("data-review-filters") || "").split(" ");
          const matches = filter === "all" || filters.includes(filter);
          item.classList.toggle("hidden", !matches);
          if (matches) visible += 1;
        }
        for (const button of document.querySelectorAll("button[data-review-filter]")) {
          button.classList.toggle("active", button.getAttribute("data-review-filter") === filter);
        }
        const summary = document.getElementById("reviewSummary");
        if (summary) {
          const label = document.querySelector(".review-filter[data-review-filter='" + filter + "']")?.getAttribute("data-review-label") || filter;
          summary.textContent = total ? "Showing " + visible + " of " + total + " loaded memories for " + label + "." : "No loaded memories match this filter.";
        }
      }

      function setReviewFilter(filter) {
        currentReviewFilter = filter || "all";
        applyReviewFilter();
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

      for (const button of document.querySelectorAll("button[data-graph-zoom]")) {
        button.addEventListener("click", () => {
          const action = button.getAttribute("data-graph-zoom");
          if (action === "in") setGraphZoom(graphZoom + graphZoomStep);
          if (action === "out") setGraphZoom(graphZoom - graphZoomStep);
          if (action === "reset") setGraphZoom(1);
          if (action === "fit") fitGraphInViewport();
        });
      }

      const graph = document.getElementById("graph");
      if (graph) {
        graph.addEventListener("scroll", rememberGraphViewport);
        graph.addEventListener("wheel", (event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          const bounds = graph.getBoundingClientRect();
          const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
          setGraphZoom(graphZoom * factor, {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top
          });
        }, { passive: false });
        graph.addEventListener("keydown", (event) => {
          if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            setGraphZoom(graphZoom + graphZoomStep);
          }
          if (event.key === "-") {
            event.preventDefault();
            setGraphZoom(graphZoom - graphZoomStep);
          }
          if (event.key === "0") {
            event.preventDefault();
            setGraphZoom(1);
          }
        });
        graph.addEventListener("pointerdown", (event) => {
          if (event.button !== 0 || (event.target.closest && event.target.closest(".map-node"))) return;
          if (graph.scrollWidth <= graph.clientWidth && graph.scrollHeight <= graph.clientHeight) return;
          graphPan = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: graph.scrollLeft,
            top: graph.scrollTop
          };
          graph.setPointerCapture(event.pointerId);
          graph.classList.add("is-panning");
        });
        graph.addEventListener("pointermove", (event) => {
          if (!graphPan || graphPan.pointerId !== event.pointerId) return;
          graph.scrollLeft = graphPan.left - (event.clientX - graphPan.x);
          graph.scrollTop = graphPan.top - (event.clientY - graphPan.y);
        });
        const endGraphPan = (event) => {
          if (!graphPan || graphPan.pointerId !== event.pointerId) return;
          graphPan = null;
          graph.classList.remove("is-panning");
          if (graph.hasPointerCapture(event.pointerId)) graph.releasePointerCapture(event.pointerId);
          rememberGraphViewport();
        };
        graph.addEventListener("pointerup", endGraphPan);
        graph.addEventListener("pointercancel", endGraphPan);
      }

      document.addEventListener("click", (event) => {
        const target = event.target;
        const reviewFilterButton = target && target.closest ? target.closest("button[data-review-filter]") : null;
        if (reviewFilterButton) {
          setView("memory");
          setReviewFilter(reviewFilterButton.getAttribute("data-review-filter") || "all");
          return;
        }

        const deleteButton = target && target.closest ? target.closest("button[data-memory-delete]") : null;
        if (!deleteButton) return;
        vscode.postMessage({
          command: "memory-delete",
          id: Number(deleteButton.getAttribute("data-memory-delete") || "0"),
          title: deleteButton.getAttribute("data-memory-title") || ""
        });
      });

      document.addEventListener("submit", (event) => {
        const form = event.target;
        if (!form || !form.matches || !form.matches("form[data-memory-review-form]")) return;
        event.preventDefault();
        const data = new FormData(form);
        vscode.postMessage({
          command: "memory-review-update",
          id: Number(form.getAttribute("data-memory-id") || "0"),
          confidencePercent: Number(data.get("confidencePercent") || "0"),
          comment: String(data.get("comment") || "")
        });
      });

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
        if (subtitle) subtitle.textContent = String(payload.subtitle || "Retentia stream");
        if (updated) updated.textContent = String(payload.updatedAt || "n/a");
        setHtml("dashboardError", payload.errorHtml);
        setHtml("metricStrip", payload.metricsHtml);
        rememberGraphViewport();
        setHtml("graph", payload.graphHtml);
        setHtml("inspectorBody", payload.inspectorHtml);
        setHtml("memoryPlane", payload.memoryHtml);
        setHtml("qualityPlane", payload.qualityHtml);
        setHtml("operationsPlane", payload.operationsHtml);
        detailsByNode = payload.detailsByNode || {};
        applyGraphZoom();
        restoreGraphViewport();
        bindMapNodes(String(payload.defaultNodeId || ""));
        applyReviewFilter();
        setView(currentView);
      });

      updateGraphZoomControls();
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
  const recentEvents = arrayOfRecords(data.recentEvents);
  const repositoryByTaskId = buildRepositoryByTaskId(recentEvents);
  const tasks = arrayOfRecords(data.tasks).map((task) =>
    withRepositoryLabel(task, repositoryByTaskId.get(toText(task.id) || "")),
  );
  const activities = arrayOfRecords(data.activities).map((activity) =>
    withRepositoryLabel(
      activity,
      repositoryByTaskId.get(toText(activity.taskId) || ""),
    ),
  );
  const memories = arrayOfRecords(data.memories);
  const edges = arrayOfRecords(data.edges);
  const trends = toRecord(data.trends);
  const contextPreview = toRecord(data.contextPreview);
  const quality = toRecord(data.quality);
  const health = toRecord(data.health);
  const activeTasks = tasks.filter(isActiveTask);
  const graphNodes = buildGraphNodes(agents, tasks, memories);
  const focusTask = pickFocusTask(tasks);
  const generatedAt = toText(data.generatedAt) || new Date().toISOString();

  return {
    signature: [
      generatedAt,
      toNumber(totals.events) ?? 0,
      toNumber(totals.tasks) ?? 0,
      toNumber(totals.memories) ?? 0,
      toNumber(totals.evidenceChunks) ?? 0,
      activities[0] ? toText(activities[0].id) : "0",
      JSON.stringify(trends),
      toText(health.status),
    ].join(":"),
    subtitle: `${toText(data.dataFile) || "n/a"} / ${formatIso(generatedAt)}`,
    updatedAt: formatIsoCompact(generatedAt),
    errorHtml: error ? `<div class="error">${escapeHtml(error)}</div>` : "",
    metricsHtml: [
      metric(
        "Events",
        toNumber(totals.events) ?? 0,
        "Signals currently available in the Retentia event stream.",
        "accent",
        "primary",
      ),
      metric(
        "Agents",
        toNumber(totals.agents) ?? agents.length,
        "Agents seen in the current dashboard snapshot.",
        "accent",
      ),
      metric(
        "Active",
        activeTasks.length,
        "Tasks currently marked active in the control plane.",
        activeTasks.length > 0 ? "good" : "default",
      ),
      metric(
        "Tasks",
        toNumber(totals.tasks) ?? tasks.length,
        "Task records loaded into this dashboard window.",
      ),
      metric(
        "Memories",
        toNumber(totals.memories) ?? memories.length,
        "Durable memories available for review and retrieval.",
      ),
      metric(
        "Relations",
        edges.length,
        "Graph edges linking agents, tasks, memory, and evidence.",
      ),
      metric(
        "Evidence",
        toNumber(totals.evidenceChunks) ?? 0,
        "Evidence chunks indexed for context and retrieval work.",
      ),
    ].join(""),
    graphHtml: renderAgentGraphSvg(graphNodes, edges),
    inspectorHtml: renderInspector(tasks, agents, activities, contextPreview),
    memoryHtml: renderMemoryPlane(memories, contextPreview),
    qualityHtml: renderQualityPlane(
      health,
      memories,
      contextPreview,
      totals,
      quality,
    ),
    operationsHtml: renderOperationsPlane(
      trends,
      agents,
      tasks,
      activities,
      totals,
    ),
    detailsByNode: buildNodeDetails(tasks, agents, activities, contextPreview),
    defaultNodeId: focusTask ? `task:${toText(focusTask.id)}` : "",
  };
}

function buildRepositoryByTaskId(events: JsonResult[]): Map<string, string> {
  const repositories = new Map<string, string>();
  for (const event of events) {
    const taskId = toText(event.taskId);
    if (!taskId || repositories.has(taskId)) {
      continue;
    }
    const workspacePath = extractWorkspacePathFromEvent(event);
    if (!workspacePath) {
      continue;
    }
    repositories.set(taskId, resolveRepositoryName(workspacePath));
  }
  return repositories;
}

function withRepositoryLabel(
  record: JsonResult,
  repository?: string,
): JsonResult {
  const fallback = toText(record.project) || "global";
  return {
    ...record,
    repository: repository || fallback,
  };
}

function extractWorkspacePathFromEvent(event: JsonResult): string | undefined {
  const payload = toRecord(event.payload);
  const metadata = toRecord(payload.metadata);
  const session = toRecord(payload.session);
  const turn = toRecord(payload.turn);
  return (
    toText(payload.cwd) ||
    toText(payload.projectPath) ||
    toText(payload.project_path) ||
    toText(payload.workspaceFolder) ||
    toText(payload.workspace_folder) ||
    toText(metadata.cwd) ||
    toText(metadata.projectPath) ||
    toText(metadata.project_path) ||
    toText(metadata.workspaceFolder) ||
    toText(metadata.workspace_folder) ||
    toText(session.cwd) ||
    toText(turn.cwd)
  );
}

function resolveRepositoryName(workspacePath: string): string {
  const normalizedPath = workspacePath.trim();
  if (!normalizedPath) {
    return "global";
  }
  const cached = REPOSITORY_NAME_CACHE.get(normalizedPath);
  if (cached) {
    return cached;
  }

  const gitRoot = findGitRoot(normalizedPath);
  const label = gitRoot
    ? readRepositoryNameFromGitConfig(gitRoot) || basename(gitRoot)
    : basename(normalizedPath);
  REPOSITORY_NAME_CACHE.set(normalizedPath, label || normalizedPath);
  return label || normalizedPath;
}

function findGitRoot(workspacePath: string): string | undefined {
  let current = workspacePath;
  try {
    if (existsSync(current) && statSync(current).isFile()) {
      current = dirname(current);
    }
  } catch {
    return undefined;
  }

  while (current && current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    current = dirname(current);
  }
  return undefined;
}

function readRepositoryNameFromGitConfig(gitRoot: string): string | undefined {
  const configPath = join(gitRoot, ".git", "config");
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const config = readFileSync(configPath, "utf8");
    const originUrl =
      /^\s*url\s*=\s*(.+)$/m.exec(config)?.[1]?.trim() || "";
    return repositoryNameFromRemoteUrl(originUrl);
  } catch {
    return undefined;
  }
}

function repositoryNameFromRemoteUrl(remoteUrl: string): string | undefined {
  if (!remoteUrl) {
    return undefined;
  }
  const withoutQuery = remoteUrl.split(/[?#]/)[0] || remoteUrl;
  const match = /[:/]([^/:]+?)(?:\.git)?$/.exec(withoutQuery);
  return match?.[1];
}

function getRepositoryLabel(record: JsonResult): string {
  return toText(record.repository) || toText(record.project) || "global";
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

function formatRelativeTime(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (elapsedSeconds < 60) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

function mapNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is number => typeof item === "number" && Number.isFinite(item),
  );
}

interface DashboardDistributionItem {
  label: string;
  value: number;
  detail?: string;
}

function renderQualityPlane(
  health: JsonResult,
  memories: JsonResult[],
  contextPreview: JsonResult,
  totals: JsonResult,
  quality: JsonResult,
): string {
  const activeMemorySample = memories.filter(
    (memory) => !toBoolean(memory.archived),
  );
  const sampleHighConfidence = activeMemorySample.filter(
    (memory) => (toNumber(memory.confidence) ?? 0) >= REVIEW_CONFIDENCE_THRESHOLD,
  ).length;
  const sampleLowConfidence = activeMemorySample.filter(
    (memory) => (toNumber(memory.confidence) ?? 0) < REVIEW_CONFIDENCE_THRESHOLD,
  ).length;
  const memoryTotal =
    toNumber(quality.memoryTotal) ??
    toNumber(totals.memories) ??
    memories.length;
  const activeMemoryTotal = toNumber(quality.activeMemoryTotal) ?? memoryTotal;
  const sampleSize = toNumber(quality.sampleSize) ?? activeMemorySample.length;
  const averageConfidence =
    toNumber(quality.averageConfidence) ??
    getAverageConfidence(activeMemorySample);
  const highConfidence =
    toNumber(quality.highConfidence) ?? sampleHighConfidence;
  const lowConfidence = toNumber(quality.lowConfidence) ?? sampleLowConfidence;
  const pinnedTotal =
    toNumber(quality.pinnedTotal) ??
    memories.filter((memory) => toBoolean(memory.pinned)).length;
  const evidenceTotal =
    toNumber(quality.evidenceChunks) ?? toNumber(totals.evidenceChunks) ?? 0;
  const evidenceCoverage = toNumber(quality.evidenceCoverage);
  const staleMemories = toNumber(quality.staleMemories) ?? 0;
  const usedChars = toNumber(contextPreview.usedChars) ?? 0;
  const maxChars = toNumber(contextPreview.maxChars) ?? 0;
  const contextRatio = maxChars > 0 ? usedChars / maxChars : 0;
  const contextMemoryCount = mapNumberList(contextPreview.memoryIds).length;
  const lastMemoryUpdatedAt = toText(quality.lastMemoryUpdatedAt);
  const lastEvidenceCreatedAt = toText(quality.lastEvidenceCreatedAt);
  const evidenceValue =
    evidenceCoverage === undefined
      ? "Store empty"
      : `${evidenceCoverage.toFixed(1)}x`;
  const evidenceDetail =
    evidenceCoverage === undefined
      ? "No evidence chunks have been linked yet"
      : `${evidenceTotal} chunks across ${activeMemoryTotal} active memories`;
  const activeDetail =
    activeMemoryTotal === memoryTotal
      ? `${activeMemoryTotal} active memories in store`
      : `${activeMemoryTotal} active, ${memoryTotal} total`;
  const snapshotScope =
    sampleSize < activeMemoryTotal
      ? `Full-store metrics, ${sampleSize} loaded`
      : `Full-store metrics, ${activeMemoryTotal} loaded`;
  const kindCounts = distributionFromCounts(quality.kindCounts);

  return `
    <div class="insight-grid">
      ${renderReviewMetric("Memories", String(activeMemoryTotal), activeDetail, "all", activeMemoryTotal > 0 ? "good" : "warn")}
      ${renderReviewMetric("Needs review", String(lowConfidence), "Confidence below 90%", "needs-review", lowConfidence === 0 ? "good" : lowConfidence < Math.max(5, activeMemoryTotal * 0.08) ? "warn" : "bad")}
      ${renderInsightMetric("Linked evidence", evidenceValue, evidenceDetail, evidenceCoverage === undefined ? "warn" : evidenceCoverage >= 1 ? "good" : "warn")}
      ${renderReviewMetric("Pinned memories", String(pinnedTotal), "Favored during retrieval", "pinned", pinnedTotal > 0 ? "good" : "warn")}
      ${renderInsightMetric("Last update", formatRelativeTime(lastMemoryUpdatedAt), lastMemoryUpdatedAt ? formatIsoCompact(lastMemoryUpdatedAt) : "No durable memory yet", lastMemoryUpdatedAt ? "good" : "warn")}
      ${renderReviewMetric("Stale memories", String(staleMemories), "Not updated in 90 days", "stale", staleMemories === 0 ? "good" : "warn")}
    </div>
    <div class="wide-grid">
      <section class="stat-panel">
        <div class="panel-head"><h2>Retrieval Snapshot</h2><span class="muted">${snapshotScope}, ${contextMemoryCount} in preview</span></div>
        <div class="stat-body">
          ${renderMeter("Avg memory confidence", averageConfidence, `${highConfidence} high confidence, ${lowConfidence} need review`, toneForRatio(averageConfidence, 0.9, 0.8))}
          ${renderMeter("Preview size", contextRatio, `${contextMemoryCount} memories, ${usedChars} of ${maxChars || "n/a"} characters`, toneForCeiling(contextRatio, 0.72, 0.9))}
          ${renderDistribution("Memory kinds", kindCounts.length ? kindCounts : countByField(memories, "kind"), "No active memories yet.")}
          <div class="muted">Evidence store: ${escapeHtml(evidenceTotal > 0 ? `${evidenceTotal} chunks, latest ${formatIsoCompact(lastEvidenceCreatedAt)}` : "empty, no linked source material")}</div>
        </div>
      </section>
      <section class="panel health-plane">${renderHealthPlane(health)}</section>
    </div>
  `;
}

function renderReviewMetric(
  label: string,
  value: string,
  detail: string,
  filter: string,
  tone = "",
): string {
  const toneClass = tone ? ` ${tone}` : "";
  return `
    <button type="button" class="stat-tile${toneClass}" data-review-filter="${escapeHtml(filter)}" data-review-label="${escapeHtml(label)}">
      <div class="k">${escapeHtml(label)}</div>
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(detail)}</span>
    </button>
  `;
}

function renderReviewFilterButton(
  label: string,
  filter: string,
  count: number,
): string {
  return `<button type="button" class="review-filter" data-review-filter="${escapeHtml(filter)}" data-review-label="${escapeHtml(label)}">${escapeHtml(label)} ${count}</button>`;
}

interface MemoryReviewCounts {
  all: number;
  needsReview: number;
  stale: number;
  probablyLowConfidence: number;
  pinned: number;
  archived: number;
}

function getMemoryReviewCounts(
  memories: JsonResult[],
  nowMs: number,
): MemoryReviewCounts {
  const counts: MemoryReviewCounts = {
    all: memories.length,
    needsReview: 0,
    stale: 0,
    probablyLowConfidence: 0,
    pinned: 0,
    archived: 0,
  };

  for (const memory of memories) {
    const flags = getMemoryReviewFlags(memory, nowMs);
    if (flags.includes("needs-review")) counts.needsReview += 1;
    if (flags.includes("stale")) counts.stale += 1;
    if (flags.includes("probably-low-confidence")) {
      counts.probablyLowConfidence += 1;
    }
    if (flags.includes("pinned")) counts.pinned += 1;
    if (flags.includes("archived")) counts.archived += 1;
  }

  return counts;
}

function renderMemoryReviewItems(
  memories: JsonResult[],
  nowMs: number,
): string {
  if (memories.length === 0) {
    return `<div class="muted">No durable memories loaded in this dashboard sample.</div>`;
  }

  return memories
    .map((memory) => renderMemoryReviewItem(memory, nowMs))
    .join("");
}

function renderMemoryReviewItem(memory: JsonResult, nowMs: number): string {
  const id = toNumber(memory.id);
  const title = toText(memory.title) || "Untitled memory";
  const body = toText(memory.body) || "";
  const kind = toText(memory.kind) || "memory";
  const project = toText(memory.project) || "global";
  const confidence = toNumber(memory.confidence) ?? 0;
  const createdAt = toText(memory.createdAt);
  const updatedAt = toText(memory.updatedAt);
  const tags = arrayOfTexts(memory.tags);
  const sourceEventIds = arrayOfNumbers(memory.sourceEventIds);
  const flags = getMemoryReviewFlags(memory, nowMs);
  const badges = [
    renderBadge(kind, ""),
    renderBadge(formatConfidence(confidence), toneForMemoryConfidence(confidence)),
    toBoolean(memory.pinned) ? renderBadge("pinned", "good") : "",
    toBoolean(memory.archived) ? renderBadge("archived", "warn") : "",
    flags.includes("stale") ? renderBadge("stale", "warn") : "",
    flags.includes("probably-low-confidence")
      ? renderBadge("probably low confidence", "bad")
      : flags.includes("needs-review")
        ? renderBadge("needs review", "warn")
        : "",
  ]
    .filter(Boolean)
    .join("");

  return `
    <article class="memory-review-item" data-review-filters="${escapeHtml(flags.join(" "))}">
      <div class="memory-review-top">
        <div class="memory-review-title">
          <strong>${escapeHtml(id === undefined ? title : `#${id} ${title}`)}</strong>
          <div class="memory-review-meta">
            <span>${escapeHtml(project)}</span>
            <span>Created ${escapeHtml(formatIsoCompact(createdAt))}</span>
            <span>Updated ${escapeHtml(formatIsoCompact(updatedAt))}</span>
            <span>${sourceEventIds.length} source event${sourceEventIds.length === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div class="memory-badges">${badges}</div>
      </div>
      ${tags.length ? `<div class="memory-review-meta">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      <code class="text-block compact">${escapeHtml(body || "No body recorded.")}</code>
      ${renderMemoryReviewActions(id, title, confidence)}
    </article>
  `;
}

function renderMemoryReviewActions(
  id: number | undefined,
  title: string,
  confidence: number,
): string {
  if (id === undefined) {
    return "";
  }

  return `
    <form class="memory-review-actions" data-memory-review-form data-memory-id="${id}">
      <label>
        Confidence
        <input type="number" name="confidencePercent" min="0" max="100" step="1" value="${Math.round(clampRatio(confidence) * 100)}" required>
      </label>
      <label>
        Review comment
        <textarea name="comment" rows="1" maxlength="600" placeholder="Reason for this confidence change" required></textarea>
      </label>
      <button type="submit">Update</button>
      <button type="button" class="danger-button" data-memory-delete="${id}" data-memory-title="${escapeHtml(title)}">Delete</button>
    </form>
  `;
}

function getMemoryReviewFlags(memory: JsonResult, nowMs: number): string[] {
  const flags = ["all"];
  const archived = toBoolean(memory.archived);
  const confidence = toNumber(memory.confidence) ?? 0;

  if (!archived && confidence < REVIEW_CONFIDENCE_THRESHOLD) {
    flags.push("needs-review");
  }
  if (!archived && confidence < PROBABLY_LOW_CONFIDENCE_THRESHOLD) {
    flags.push("probably-low-confidence");
  }
  if (!archived && isMemoryStale(memory, nowMs)) {
    flags.push("stale");
  }
  if (toBoolean(memory.pinned)) {
    flags.push("pinned");
  }
  if (archived) {
    flags.push("archived");
  }

  return flags;
}

function isMemoryStale(memory: JsonResult, nowMs: number): boolean {
  const updatedAt = toText(memory.updatedAt);
  if (!updatedAt) {
    return false;
  }
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return nowMs - parsed > STALE_MEMORY_REVIEW_DAYS * 24 * 60 * 60 * 1000;
}

function renderBadge(label: string, tone: string): string {
  const toneClass = tone ? ` ${tone}` : "";
  return `<span class="badge${toneClass}">${escapeHtml(label)}</span>`;
}

function toneForMemoryConfidence(confidence: number): string {
  if (confidence >= REVIEW_CONFIDENCE_THRESHOLD) {
    return "good";
  }
  if (confidence < PROBABLY_LOW_CONFIDENCE_THRESHOLD) {
    return "bad";
  }
  return "warn";
}

function formatConfidence(confidence: number): string {
  return `${Math.round(clampRatio(confidence) * 100)}% confidence`;
}

function renderOperationsPlane(
  trends: JsonResult,
  agents: JsonResult[],
  tasks: JsonResult[],
  activities: JsonResult[],
  totals: JsonResult,
): string {
  const activeTasks = tasks.filter(isActiveTask).length;
  const completedTasks = tasks.filter(
    (task) => toText(task.status) === "completed",
  ).length;
  const failedTasks = tasks.filter(
    (task) => toText(task.status) === "failed",
  ).length;
  const closedTasks = completedTasks + failedTasks;
  const successRatio = closedTasks > 0 ? completedTasks / closedTasks : 0;
  const eventTotal = toNumber(totals.events) ?? activities.length;

  return `
    <div class="insight-grid">
      ${renderInsightMetric("Task success", closedTasks > 0 ? formatPercent(successRatio) : "n/a", `${completedTasks} done, ${failedTasks} failed`, closedTasks === 0 ? "" : toneForRatio(successRatio, 0.8, 0.55))}
      ${renderInsightMetric("Active load", String(activeTasks), `${agents.length} agents seen in current snapshot`, activeTasks <= agents.length ? "good" : "warn")}
      ${renderInsightMetric("Event density", String(eventTotal), `${activities.length} recent activities in view`, eventTotal > 0 ? "good" : "")}
    </div>
    <div class="wide-grid">
      <section class="panel trend-plane">
        <div class="panel-head"><h2>Execution Trend</h2><span class="muted">Recent daily and weekly movement</span></div>
        ${renderTrendPlane(trends)}
      </section>
      <section class="stat-panel">
        <div class="panel-head"><h2>Operational Mix</h2><span class="muted">Current dashboard sample</span></div>
        <div class="stat-body">
          ${renderDistribution("Task status", taskStatusDistribution(activeTasks, completedTasks, failedTasks), "No task status data yet.")}
          ${renderDistribution("Agent workload", agentWorkloadDistribution(agents), "No agent workload data yet.")}
          ${renderDistribution("Activity types", countByField(activities, "type"), "No activity data yet.")}
          ${renderDistribution("Repository signal", repositorySignalDistribution(tasks, activities), "No repository signal data yet.")}
        </div>
      </section>
    </div>
  `;
}

function renderInsightMetric(
  label: string,
  value: string,
  detail: string,
  tone = "",
): string {
  const toneClass = tone ? ` ${tone}` : "";
  return `
    <div class="stat-tile${toneClass}">
      <div class="k">${escapeHtml(label)}</div>
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(detail)}</span>
    </div>
  `;
}

function renderMeter(
  label: string,
  ratio: number,
  detail: string,
  tone = "",
): string {
  const value = clampRatio(ratio);
  const toneClass = tone ? ` ${tone}` : "";
  return `
    <div class="meter-row">
      <div class="meter-label"><span>${escapeHtml(label)}</span><span>${escapeHtml(formatPercent(value))}</span></div>
      <div class="meter" title="${escapeHtml(detail)}"><div class="meter-fill${toneClass}" style="--value:${Math.round(value * 100)}%"></div></div>
      <div class="muted">${escapeHtml(detail)}</div>
    </div>
  `;
}

function renderDistribution(
  title: string,
  items: DashboardDistributionItem[],
  emptyText: string,
): string {
  const rows = renderDistributionRows(items, emptyText);
  return `
    <div>
      <div class="trend-title"><span>${escapeHtml(title)}</span><span class="muted">${items.length} groups</span></div>
      <div class="distribution">${rows}</div>
    </div>
  `;
}

function renderDistributionRows(
  items: DashboardDistributionItem[],
  emptyText: string,
): string {
  const visible = items.filter((item) => item.value > 0).slice(0, 8);
  if (visible.length === 0) {
    return `<div class="muted">${escapeHtml(emptyText)}</div>`;
  }

  const maxValue = Math.max(...visible.map((item) => item.value), 1);
  return visible
    .map((item) => {
      const width = Math.max(4, Math.round((item.value / maxValue) * 100));
      return `
        <div class="dist-row" title="${escapeHtml(item.detail || item.label)}">
          <div class="dist-label">${escapeHtml(item.label)}</div>
          <div class="dist-bar"><div class="dist-fill" style="--value:${width}%"></div></div>
          <div class="dist-value">${item.value}</div>
        </div>
      `;
    })
    .join("");
}

function countByField(
  records: JsonResult[],
  fieldName: string,
): DashboardDistributionItem[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const label = toText(record[fieldName]) || "unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return sortDistribution(
    Array.from(counts, ([label, value]) => ({ label, value })),
  );
}

function distributionFromCounts(value: unknown): DashboardDistributionItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return sortDistribution(
    value.map((item) => {
      const record = toRecord(item);
      const label = toText(record.key) || "unknown";
      const count = toNumber(record.count) ?? 0;
      return {
        label,
        value: count,
      };
    }),
  );
}

function taskStatusDistribution(
  active: number,
  completed: number,
  failed: number,
): DashboardDistributionItem[] {
  return sortDistribution([
    { label: "active", value: active },
    { label: "completed", value: completed },
    { label: "failed", value: failed },
  ]);
}

function agentWorkloadDistribution(
  agents: JsonResult[],
): DashboardDistributionItem[] {
  return sortDistribution(
    agents.map((agent) => {
      const label = toText(agent.id) || "agent";
      const active = toNumber(agent.activeTasks) ?? 0;
      const completed = toNumber(agent.completedTasks) ?? 0;
      const failed = toNumber(agent.failedTasks) ?? 0;
      return {
        label,
        value: active + completed + failed,
        detail: `${active} active, ${completed} done, ${failed} failed`,
      };
    }),
  );
}

function repositorySignalDistribution(
  tasks: JsonResult[],
  activities: JsonResult[],
): DashboardDistributionItem[] {
  const counts = new Map<string, number>();
  for (const record of [...tasks, ...activities]) {
    const repository = getRepositoryLabel(record);
    counts.set(repository, (counts.get(repository) ?? 0) + 1);
  }
  return sortDistribution(
    Array.from(counts, ([label, value]) => ({
      label,
      value,
      detail: `${value} task or activity signals`,
    })),
  );
}

function sortDistribution(
  items: DashboardDistributionItem[],
): DashboardDistributionItem[] {
  return items.sort(
    (a, b) => b.value - a.value || a.label.localeCompare(b.label),
  );
}

function getAverageConfidence(memories: JsonResult[]): number {
  if (memories.length === 0) {
    return 0;
  }
  const total = memories.reduce(
    (sum, memory) => sum + (toNumber(memory.confidence) ?? 0),
    0,
  );
  return total / memories.length;
}

function toneForRatio(
  value: number,
  goodAt: number,
  warnBelow: number,
): string {
  if (value >= goodAt) {
    return "good";
  }
  if (value < warnBelow) {
    return "bad";
  }
  return "warn";
}

function toneForCeiling(value: number, warnAt: number, badAt: number): string {
  if (value >= badAt) {
    return "bad";
  }
  if (value >= warnAt) {
    return "warn";
  }
  return "good";
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

function formatPercent(value: number): string {
  return `${Math.round(clampRatio(value) * 100)}%`;
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
      <div class="muted">No task events yet.</div>
      <div class="section"><h3>Required signal</h3><div class="reasoning text-block compact">Emit agent_event with taskId, actor, summary, and payload.reasoningSummary or payload.rationale.</div></div>
      <div class="section"><h3>Context</h3><div class="context text-block">${escapeHtml(toText(contextPreview.text) || "No context yet.")}</div></div>
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
  const knownAgentIds = new Set(
    agents.map((agent) => toText(agent.id)).filter(Boolean),
  );
  for (const task of tasks) {
    const actor = getTaskActor(task);
    if (knownAgentIds.has(actor)) {
      continue;
    }
    knownAgentIds.add(actor);
    const ownedTasks = tasks.filter((item) => getTaskActor(item) === actor);
    const syntheticAgent: JsonResult = {
      id: actor,
      source: toText(task.source) || "task",
      role: toText(task.role) || "agent",
      status: ownedTasks.some(isActiveTask) ? "active" : "idle",
      activeTasks: ownedTasks.filter(isActiveTask).length,
      completedTasks: ownedTasks.filter(
        (item) => toText(item.status) === "completed",
      ).length,
      failedTasks: ownedTasks.filter((item) => toText(item.status) === "failed")
        .length,
      lastSeenAt: ownedTasks
        .map((item) => toText(item.lastSeenAt) || "")
        .sort()
        .at(-1),
    };
    details[`agent:${actor}`] = renderAgentInspector(
      syntheticAgent,
      tasks,
      activities,
    );
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
      <div class="focus-subtitle">${escapeHtml(toText(task.description) || "No task description recorded yet.")}</div>
    </div>
    <div class="kv">
      <div class="key">Agent</div><div>${escapeHtml(actor)} <span class="state state-${escapeHtml(toText(agent.status) || "idle")}">${escapeHtml(toText(agent.status) || "idle")}</span></div>
      <div class="key">Role</div><div>${escapeHtml(toText(task.role) || toText(agent.role) || "primary")}</div>
      <div class="key">Task</div><div>${escapeHtml(taskId)}</div>
      <div class="key">Parent</div><div>${escapeHtml(toText(task.parentTaskId) || "root")}</div>
      <div class="key">Repository</div><div>${escapeHtml(getRepositoryLabel(task))}</div>
      <div class="key">Status</div><div><span class="state state-${escapeHtml(toText(task.status) || "active")}">${escapeHtml(toText(task.status) || "active")}</span></div>
      <div class="key">Seen</div><div>${escapeHtml(formatIsoCompact(toText(task.lastSeenAt)))}</div>
    </div>
    <div class="section"><h3>Reasoning Summary</h3><div class="reasoning text-block">${escapeHtml(reasoning)}</div></div>
    <div class="section"><h3>Task Activity</h3><ul>${renderActivityItems(matchingActivities)}</ul></div>
    <div class="section"><h3>Context Preview</h3><div class="context text-block">${escapeHtml(toText(contextPreview.text) || "No context yet.")}</div></div>
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
  const activeTask = ownedTasks.find(isActiveTask) || ownedTasks[0];
  const agentActivities = activities
    .filter(
      (activity) =>
        (toText(activity.actor) || toText(activity.source)) === agentId,
    )
    .slice(0, 8);

  return `
    <div>
      <div class="focus-title">${escapeHtml(agentId)}</div>
      <div class="focus-subtitle">${escapeHtml(toText(agent.role) || "agent")} / ${escapeHtml(toText(agent.source) || "source unknown")}</div>
    </div>
    <div class="kv">
      <div class="key">Status</div><div><span class="state state-${escapeHtml(toText(agent.status) || "idle")}">${escapeHtml(toText(agent.status) || "idle")}</span></div>
      <div class="key">On Task</div><div>${escapeHtml(activeTask ? toText(activeTask.title) || toText(activeTask.id) || "task" : "none")}</div>
      <div class="key">Active</div><div>${toNumber(agent.activeTasks) ?? 0}</div>
      <div class="key">Done</div><div>${toNumber(agent.completedTasks) ?? 0}</div>
      <div class="key">Failed</div><div>${toNumber(agent.failedTasks) ?? 0}</div>
      <div class="key">Seen</div><div>${escapeHtml(formatIsoCompact(toText(agent.lastSeenAt)))}</div>
    </div>
    <div class="section"><h3>Current Task Reasoning</h3><div class="reasoning text-block">${escapeHtml(activeTask ? toText(activeTask.reasoning) || toText(activeTask.description) || "No explicit reasoning summary recorded." : "No active task.")}</div></div>
    <div class="section"><h3>Agent Activity</h3><ul>${renderActivityItems(agentActivities)}</ul></div>
  `;
}

function renderMemoryPlane(
  memories: JsonResult[],
  contextPreview: JsonResult,
): string {
  const nowMs = Date.now();
  const reviewCounts = getMemoryReviewCounts(memories, nowMs);
  return `
    <div class="panel-head"><h2>Memory Review</h2><span class="muted">${reviewCounts.all} loaded, ${reviewCounts.archived} archived</span></div>
    <div class="inspector-body">
      <div class="review-toolbar">
        ${renderReviewFilterButton("All", "all", reviewCounts.all)}
        ${renderReviewFilterButton("Needs review", "needs-review", reviewCounts.needsReview)}
        ${renderReviewFilterButton("Stale", "stale", reviewCounts.stale)}
        ${renderReviewFilterButton("Probably low confidence", "probably-low-confidence", reviewCounts.probablyLowConfidence)}
        ${renderReviewFilterButton("Pinned", "pinned", reviewCounts.pinned)}
        ${renderReviewFilterButton("Archived", "archived", reviewCounts.archived)}
      </div>
      <div id="reviewSummary" class="review-summary"></div>
      <div class="memory-review-list">${renderMemoryReviewItems(memories, nowMs)}</div>
      <div class="section"><h3>Current Context Pack</h3><div class="context text-block">${escapeHtml(toText(contextPreview.text) || "No context yet.")}</div></div>
    </div>
  `;
}

function pickFocusTask(tasks: JsonResult[]): JsonResult | undefined {
  return tasks.find(isActiveTask) || tasks[0];
}

function isActiveTask(task: JsonResult): boolean {
  return (toText(task.status) || "active") === "active";
}

function renderActivityItems(activities: JsonResult[]): string {
  if (activities.length === 0) {
    return `<li class="muted">No events have been recorded for this task yet.</li>`;
  }

  return activities
    .map(
      (activity) => `
        <li class="activity-item">
          <div class="activity-meta">
            <strong>${escapeHtml(formatIsoCompact(toText(activity.createdAt)))}</strong>
            <span class="state">${escapeHtml(toText(activity.type) || "event")}</span>
          </div>
          <div class="activity-summary">${escapeHtml(toText(activity.summary) || "No summary")}</div>
          <code class="text-block compact">${escapeHtml(toText(activity.reasoning) || toText(activity.payloadPreview) || "No explicit reasoning or payload summary.")}</code>
        </li>`,
    )
    .join("");
}

function metric(
  label: string,
  value: number,
  detail: string,
  tone: "default" | "accent" | "good" | "warn" = "default",
  size: "normal" | "primary" = "normal",
): string {
  const sizeClass = size === "primary" ? " primary" : "";
  const toneClass = tone === "default" ? "" : ` ${tone}`;
  return `
    <article class="kpi-card${sizeClass}">
      <div class="kpi-card-top">
        <div class="kpi-label">${escapeHtml(label)}</div>
        <span class="kpi-marker${toneClass}" aria-hidden="true"></span>
      </div>
      <div class="kpi-value">${escapeHtml(formatDashboardNumber(value))}</div>
      <div class="kpi-detail">${escapeHtml(detail)}</div>
    </article>`;
}

function formatDashboardNumber(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0";
}

function arrayOfRecords(value: unknown): JsonResult[] {
  return Array.isArray(value) ? value.map((item) => toRecord(item)) : [];
}

function arrayOfTexts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => toText(item)?.trim() || "")
    .filter(Boolean);
}

function arrayOfNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is number => typeof item === "number" && Number.isFinite(item),
  );
}

interface AgentGraphRow {
  label: string;
  value: string;
}

interface AgentGraphNode {
  id: string;
  type: "agent" | "subagent" | "task";
  eyebrow: string;
  label: string;
  detail: string;
  rows: AgentGraphRow[];
  status: string;
  x: number;
  y: number;
  width: number;
  height: number;
  actorId?: string;
  parentAgentId?: string;
  taskId?: string;
}

function buildGraphNodes(
  agents: JsonResult[],
  tasks: JsonResult[],
  _memories: JsonResult[],
): AgentGraphNode[] {
  const activeTasks = tasks.filter(isActiveTask).slice(0, 16);
  if (activeTasks.length === 0) {
    return [];
  }

  const nodes: AgentGraphNode[] = [];
  const agentsById = new Map<string, JsonResult>();
  const agentOrder = new Map<string, number>();
  agents.forEach((agent, index) => {
    const agentId = toText(agent.id) || String(index);
    agentsById.set(agentId, agent);
    agentOrder.set(agentId, index);
  });

  const tasksById = new Map<string, JsonResult>();
  for (const task of tasks) {
    const taskId = toText(task.id);
    if (taskId) {
      tasksById.set(taskId, task);
    }
  }

  const activeTasksByActor = new Map<string, JsonResult[]>();
  const actorIds = new Set<string>();
  const parentAgentByActor = new Map<string, string>();
  const latestByActor = new Map<string, string>();

  const rememberActor = (actor: string, task?: JsonResult) => {
    actorIds.add(actor);
    const lastSeenAt = task ? toText(task.lastSeenAt) || "" : "";
    if (lastSeenAt && lastSeenAt > (latestByActor.get(actor) || "")) {
      latestByActor.set(actor, lastSeenAt);
    }
  };

  for (const task of activeTasks) {
    const actor = getTaskActor(task);
    rememberActor(actor, task);
    const actorTasks = activeTasksByActor.get(actor) || [];
    actorTasks.push(task);
    activeTasksByActor.set(actor, actorTasks);

    const parentTaskId = toText(task.parentTaskId);
    const parentTask = parentTaskId ? tasksById.get(parentTaskId) : undefined;
    const parentActor = parentTask ? getTaskActor(parentTask) : undefined;
    if (parentActor && parentActor !== actor) {
      rememberActor(parentActor, parentTask);
      parentAgentByActor.set(actor, parentActor);
    }
  }

  for (const agent of agents) {
    const agentId = toText(agent.id);
    if (!agentId) {
      continue;
    }
    if ((toNumber(agent.activeTasks) ?? 0) > 0 || actorIds.has(agentId)) {
      rememberActor(agentId);
    }
  }

  const fallbackRootActor = [...actorIds].find((actor) => {
    const role = toText(agentsById.get(actor)?.role) || "";
    return !isSubagentRole(role);
  });

  for (const task of activeTasks) {
    const actor = getTaskActor(task);
    const role =
      toText(task.role) || toText(agentsById.get(actor)?.role) || "";
    if (
      isSubagentRole(role) &&
      !parentAgentByActor.has(actor) &&
      fallbackRootActor &&
      fallbackRootActor !== actor
    ) {
      parentAgentByActor.set(actor, fallbackRootActor);
    }
  }

  const childrenByActor = new Map<string, string[]>();
  for (const [child, parent] of parentAgentByActor) {
    if (!actorIds.has(child)) {
      continue;
    }
    actorIds.add(parent);
    const children = childrenByActor.get(parent) || [];
    if (!children.includes(child)) {
      children.push(child);
      childrenByActor.set(parent, children);
    }
  }

  const compareActors = (left: string, right: string): number => {
    const leftOrder = agentOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = agentOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    const leftSeen =
      latestByActor.get(left) || toText(agentsById.get(left)?.lastSeenAt) || "";
    const rightSeen =
      latestByActor.get(right) ||
      toText(agentsById.get(right)?.lastSeenAt) ||
      "";
    const bySeen = rightSeen.localeCompare(leftSeen);
    return bySeen !== 0 ? bySeen : left.localeCompare(right);
  };

  const depthByActor = new Map<string, number>();
  const getActorDepth = (actor: string, seen = new Set<string>()): number => {
    const cached = depthByActor.get(actor);
    if (cached !== undefined) {
      return cached;
    }
    const parent = parentAgentByActor.get(actor);
    if (!parent || parent === actor || seen.has(parent)) {
      depthByActor.set(actor, 0);
      return 0;
    }
    seen.add(actor);
    const depth = getActorDepth(parent, seen) + 1;
    depthByActor.set(actor, depth);
    return depth;
  };

  const orderedActors: string[] = [];
  const visitedActors = new Set<string>();
  const visitActor = (actor: string) => {
    if (visitedActors.has(actor)) {
      return;
    }
    visitedActors.add(actor);
    orderedActors.push(actor);
    (childrenByActor.get(actor) || []).sort(compareActors).forEach(visitActor);
  };

  [...actorIds]
    .filter((actor) => !parentAgentByActor.has(actor))
    .sort(compareActors)
    .forEach(visitActor);
  [...actorIds].sort(compareActors).forEach(visitActor);

  const leftX = 116;
  const columnGap = 286;
  const rowGap = 108;
  const blockGap = 24;
  const agentWidth = 224;
  const agentHeight = 92;
  const taskWidth = 260;
  const taskHeight = 92;
  let cursorY = 72;

  for (const actor of orderedActors) {
    const ownedActiveTasks = activeTasksByActor.get(actor) || [];
    const rowCount = Math.max(1, ownedActiveTasks.length);
    const depth = getActorDepth(actor);
    const actorX = leftX + depth * columnGap;
    const actorY = cursorY + ((rowCount - 1) * rowGap) / 2;
    const agent = agentsById.get(actor) || {};
    const role =
      toText(agent.role) || toText(ownedActiveTasks[0]?.role) || "agent";
    const parentAgentId = parentAgentByActor.get(actor);
    const nodeType =
      depth > 0 || isSubagentRole(role) ? "subagent" : "agent";
    const roleLabel = formatGraphRole(role);
    const activeCount = toNumber(agent.activeTasks) ?? ownedActiveTasks.length;
    const completedCount = toNumber(agent.completedTasks) ?? 0;
    const failedCount = toNumber(agent.failedTasks) ?? 0;
    const status =
      toText(agent.status) ||
      (ownedActiveTasks.length > 0 ? "active" : "idle");
    const detail =
      nodeType === "subagent"
        ? parentAgentId
          ? `Parent ${parentAgentId}`
          : roleLabel
        : ownedActiveTasks.length === 1
          ? getTaskTitle(ownedActiveTasks[0])
          : `${activeCount} active task${activeCount === 1 ? "" : "s"}`;
    const agentRows: AgentGraphRow[] =
      nodeType === "subagent"
        ? [
            { label: "Status", value: status },
            { label: "Active", value: String(activeCount) },
          ]
        : [
            { label: "Role", value: roleLabel },
            { label: "Status", value: status },
          ];
    if (nodeType === "agent" && (failedCount > 0 || completedCount > 0)) {
      agentRows[1] = {
        label: "Load",
        value: `${activeCount} active, ${completedCount} done${
          failedCount > 0 ? `, ${failedCount} failed` : ""
        }`,
      };
    }

    nodes.push({
      id: `agent:${actor}`,
      type: nodeType,
      eyebrow: nodeType === "subagent" ? "SUBAGENT" : "AGENT",
      label: actor,
      detail,
      rows: agentRows.slice(0, 2),
      status,
      x: actorX,
      y: actorY,
      width: agentWidth,
      height: agentHeight,
      parentAgentId,
    });

    ownedActiveTasks.forEach((task, index) => {
      const taskId = toText(task.id) || `${actor}:${index}`;
      nodes.push({
        id: `task:${taskId}`,
        type: "task",
        eyebrow: "ACTIVE TASK",
        label: getTaskTitle(task),
        detail: toText(task.status) || "active",
        rows: [
          { label: "Owner", value: actor },
          { label: "Repository", value: getRepositoryLabel(task) },
        ],
        status: toText(task.status) || "active",
        x: actorX + columnGap,
        y: cursorY + index * rowGap,
        width: taskWidth,
        height: taskHeight,
        actorId: actor,
        taskId,
      });
    });

    cursorY += Math.max(agentHeight, rowCount * rowGap) + blockGap;
  }

  return nodes;
}

function renderAgentGraphSvg(
  nodes: AgentGraphNode[],
  edges: JsonResult[],
): string {
  if (nodes.length === 0) {
    return `<div class="muted" style="padding:16px;">No active tasks right now. Completed and failed work stays available in Operations.</div>`;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const viewBoxWidth = Math.max(
    680,
    Math.ceil(Math.max(...nodes.map((node) => node.x + node.width / 2)) + 24),
  );
  const viewBoxHeight = Math.max(
    320,
    Math.ceil(Math.max(...nodes.map((node) => node.y + node.height / 2)) + 24),
  );
  const renderConnection = (
    from: AgentGraphNode,
    to: AgentGraphNode,
    className: string,
    stroke: string,
    width: number,
    opacity = 0.86,
  ) => {
    const leftToRight = from.x <= to.x;
    const fromX = leftToRight
      ? from.x + from.width / 2
      : from.x - from.width / 2;
    const toX = leftToRight ? to.x - to.width / 2 : to.x + to.width / 2;
    const midX = fromX + (toX - fromX) / 2;
    return `<path class="map-edge ${className}" d="M ${fromX} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${toX} ${to.y}" stroke="${stroke}" stroke-width="${width}" fill="none" opacity="${opacity}" />`;
  };
  const spawnLines = nodes
    .filter((node) => node.type !== "task" && node.parentAgentId)
    .map((node) => {
      const parent = node.parentAgentId
        ? byId.get(`agent:${node.parentAgentId}`)
        : undefined;
      return parent
        ? renderConnection(
            parent,
            node,
            "map-edge-active map-edge-spawn",
            "oklch(0.78 0.14 80)",
            1.7,
          )
        : "";
    })
    .join("");
  const taskLines = nodes
    .filter((node) => node.type === "task")
    .map((node) => {
      const owner = node.actorId ? byId.get(`agent:${node.actorId}`) : undefined;
      return owner
        ? renderConnection(
            owner,
            node,
            "map-edge-active map-edge-ownership",
            "oklch(0.72 0.14 155)",
            1.8,
            0.82,
          )
        : "";
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
      return renderConnection(
        from,
        to,
        "map-edge-persisted",
        "oklch(0.58 0.05 248)",
        1.4,
        0.45,
      );
    })
    .join("");
  const renderedNodes = nodes
    .map((node) => {
      const fill =
        node.type === "agent"
          ? "oklch(0.72 0.14 155)"
          : node.type === "subagent"
            ? "oklch(0.78 0.14 80)"
            : "oklch(0.7 0.12 235)";
      const cardFill =
        node.type === "agent"
          ? "oklch(0.21 0.022 155)"
          : node.type === "subagent"
            ? "oklch(0.22 0.026 80)"
            : "oklch(0.21 0.026 235)";
      const stroke =
        node.status === "failed"
          ? "oklch(0.68 0.16 35)"
          : node.status === "completed"
            ? "oklch(0.7 0.12 235)"
            : node.status === "active"
              ? "oklch(0.72 0.14 155)"
              : "oklch(0.38 0.03 248)";
      const statusClass = cssClassToken(node.status);
      const left = node.x - node.width / 2;
      const top = node.y - node.height / 2;
      const titleX = left + 14;
      const valueX = left + 66;
      const rowStart = top + 63;
      const rowGap = 12;
      const titleLimit = node.type === "task" ? 34 : 28;
      const detailLimit = node.type === "task" ? 42 : 34;
      const valueLimit = node.type === "task" ? 34 : 28;
      const rows = node.rows
        .slice(0, 2)
        .map(
          (row, index) =>
            `<text x="${titleX}" y="${rowStart + index * rowGap}" fill="oklch(0.66 0.018 248)" font-size="8.5" font-weight="700">${escapeHtml(row.label)}</text><text x="${valueX}" y="${rowStart + index * rowGap}" fill="oklch(0.86 0.01 248)" font-size="8.5">${escapeHtml(clipLabel(row.value, valueLimit))}</text>`,
        )
        .join("");
      const card = renderGraphNodeCard(
        node.type,
        left,
        top,
        node.width,
        node.height,
        cardFill,
        stroke,
      );
      const marker = renderGraphNodeMarker(node.type, titleX, top + 33, fill);
      return `<g class="map-node map-node-${escapeHtml(node.type)} status-${escapeHtml(statusClass)}" data-node-id="${escapeHtml(node.id)}"><title>${escapeHtml(`${node.eyebrow}: ${node.label}: ${node.detail}`)}</title>${card}<text x="${titleX}" y="${top + 16}" fill="${fill}" font-size="7.5" font-weight="800">${escapeHtml(node.eyebrow)}</text>${marker}<text x="${titleX + 15}" y="${top + 36}" fill="oklch(0.94 0.008 248)" font-size="12" font-weight="750">${escapeHtml(clipLabel(node.label, titleLimit))}</text><text x="${titleX}" y="${top + 51}" fill="oklch(0.72 0.018 248)" font-size="9">${escapeHtml(clipLabel(node.detail, detailLimit))}</text>${rows}</g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${viewBoxWidth} ${viewBoxHeight}" style="min-width:${viewBoxWidth}px;" role="img" aria-label="Live active agent and task graph">${spawnLines}${taskLines}${persistedLines}${renderedNodes}</svg>`;
}

function renderGraphNodeCard(
  type: AgentGraphNode["type"],
  left: number,
  top: number,
  width: number,
  height: number,
  fill: string,
  stroke: string,
): string {
  if (type === "agent") {
    return `<rect class="map-node-card" x="${left}" y="${top}" width="${width}" height="${height}" rx="8" fill="${fill}" stroke="${stroke}" />`;
  }
  if (type === "subagent") {
    return `<rect class="map-node-card" x="${left}" y="${top}" width="${width}" height="${height}" rx="8" fill="${fill}" stroke="${stroke}" />`;
  }
  return `<rect class="map-node-card" x="${left}" y="${top}" width="${width}" height="${height}" rx="8" fill="${fill}" stroke="${stroke}" />`;
}

function renderGraphNodeMarker(
  type: AgentGraphNode["type"],
  x: number,
  y: number,
  fill: string,
): string {
  if (type === "agent") {
    return `<circle class="map-node-dot" cx="${x}" cy="${y}" r="5.5" fill="${fill}" />`;
  }
  if (type === "subagent") {
    return `<rect class="map-node-dot" x="${x - 5}" y="${y - 5}" width="10" height="10" transform="rotate(45 ${x} ${y})" rx="1.2" fill="${fill}" />`;
  }
  return `<rect class="map-node-dot" x="${x - 5.5}" y="${y - 4.8}" width="11" height="9.6" rx="2.2" fill="${fill}" /><path d="M ${x - 2.8} ${y} L ${x - 0.6} ${y + 2.2} L ${x + 3.6} ${y - 2.7}" stroke="oklch(0.16 0.014 246)" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" />`;
}

function getTaskActor(task: JsonResult): string {
  return toText(task.actor) || toText(task.source) || "unknown";
}

function getTaskTitle(task: JsonResult): string {
  const title =
    toText(task.title) ||
    toText(task.summary) ||
    toText(task.id) ||
    "active task";
  if (!isNoisyTaskLabel(title)) {
    return title;
  }
  const actor = getTaskActor(task);
  const role = toText(task.role);
  if (isSubagentRole(role)) {
    return `${actor} turn`;
  }
  return toText(task.status) === "active" ? "Current Codex turn" : "Codex turn";
}

function isSubagentRole(role: string | undefined): boolean {
  const normalized = role?.toLowerCase() || "";
  return normalized.includes("subagent") || normalized.includes("sub-agent");
}

function formatGraphRole(role: string | undefined): string {
  const normalized = (role || "agent").replace(/^subagent:?/i, "").trim();
  return normalized || "agent";
}

function isNoisyTaskLabel(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  const normalized = trimmed.toLowerCase();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    normalized.includes("chunk id:") ||
    normalized.includes("original token count") ||
    normalized.startsWith("codex task_started") ||
    normalized.startsWith("codex reasoning") ||
    normalized.startsWith("codex tool_call") ||
    normalized.startsWith("codex function_call_output")
  );
}

function clipLabel(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
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

function getDashboardLimit(): number {
  const configured = vscode.workspace
    .getConfiguration("retentia")
    .get<number>("dashboardLimit", DEFAULT_DASHBOARD_LIMIT);
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_DASHBOARD_LIMIT;
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
        --bg-0: oklch(0.16 0.014 246);
        --bg-1: oklch(0.205 0.017 246);
        --bg-2: oklch(0.245 0.02 246);
        --line: oklch(0.37 0.026 246);
        --line-soft: oklch(0.31 0.02 246);
        --fg-0: oklch(0.94 0.008 246);
        --fg-1: oklch(0.72 0.017 246);
        --accent: oklch(0.72 0.14 155);
        --accent-2: oklch(0.7 0.12 235);
        --danger: oklch(0.68 0.16 35);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 10px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
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
        background: var(--bg-1);
        border-radius: 8px;
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
        background: color-mix(in oklch, var(--accent), transparent 80%);
        color: var(--accent);
      }

      .warn {
        background: color-mix(in oklch, var(--danger), transparent 82%);
        color: oklch(0.82 0.12 35);
      }

      .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }

      button {
        border: 1px solid var(--line);
        background: var(--bg-2);
        color: var(--fg-0);
        font-size: 12px;
        border-radius: 7px;
        padding: 7px 8px;
        cursor: pointer;
        font-family: inherit;
      }

      button:hover {
        border-color: var(--accent-2);
      }

      button:focus-visible,
      input:focus-visible,
      select:focus-visible,
      textarea:focus-visible {
        outline: 2px solid var(--accent-2);
        outline-offset: 2px;
      }

      button.primary {
        background: color-mix(in oklch, var(--accent), var(--bg-2) 62%);
        border-color: color-mix(in oklch, var(--accent), transparent 20%);
      }

      button.ghost {
        background: transparent;
      }

      button.icon {
        width: 28px;
        height: 28px;
        display: inline-grid;
        place-items: center;
        padding: 0;
      }

      input,
      select,
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        background: var(--bg-0);
        color: var(--fg-0);
        border-radius: 7px;
        padding: 6px 7px;
        font-size: 12px;
        font-family: inherit;
      }

      textarea {
        min-height: 74px;
        resize: vertical;
      }

      label {
        display: grid;
        gap: 4px;
        color: var(--fg-1);
        font-size: 11px;
      }

      label span {
        color: var(--fg-1);
      }

      .form-grid {
        display: grid;
        gap: 8px;
      }

      .form-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-top: 10px;
      }

      .note {
        color: var(--fg-1);
        font-size: 11px;
      }

      .error {
        border: 1px solid color-mix(in oklch, var(--danger), transparent 35%);
        background: color-mix(in oklch, var(--danger), transparent 88%);
        color: oklch(0.82 0.12 35);
        border-radius: 8px;
        padding: 7px 8px;
        font-size: 12px;
        margin-bottom: 10px;
        display: none;
      }

      .modal-backdrop {
        position: fixed;
        inset: 0;
        padding: 10px;
        background: color-mix(in oklch, var(--bg-0), transparent 18%);
        display: none;
        align-items: flex-start;
        justify-content: center;
        overflow: auto;
        z-index: 20;
      }

      .modal-backdrop.open {
        display: flex;
      }

      .dialog {
        width: min(100%, 360px);
        margin: 6px auto 18px;
        border: 1px solid var(--line);
        background: var(--bg-1);
        border-radius: 8px;
        padding: 0;
        box-shadow: 0 18px 48px color-mix(in oklch, var(--bg-0), transparent 20%);
      }

      .dialog[hidden] {
        display: none;
      }

      .dialog-head {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: start;
        padding: 10px;
        border-bottom: 1px solid var(--line);
      }

      .dialog-head h3 {
        margin: 0 0 3px;
      }

      .dialog-head p {
        margin: 0;
        color: var(--fg-1);
        font-size: 11px;
        line-height: 1.35;
      }

      .dialog-body {
        padding: 10px;
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
        <button data-open-modal="observation">Add Memory</button>
        <button data-open-modal="summary">Add Summary</button>
        <button data-action="open-dashboard">Dashboard</button>
        <button data-action="doctor">Doctor</button>
        <button data-action="sync-tasks">Sync Tasks</button>
        <button data-action="refresh-status">Refresh</button>
        <button data-action="install-mcp">Install MCP</button>
      </div>
    </section>

    <div id="modalBackdrop" class="modal-backdrop" aria-hidden="true" data-close-modal>
      <section id="observationDialog" class="dialog" role="dialog" aria-modal="true" aria-labelledby="observationTitle" hidden>
        <div class="dialog-head">
          <div>
            <h3 id="observationTitle">Add Memory</h3>
            <p>Capture a compact observation, decision, feature note, or file-linked finding.</p>
          </div>
          <button class="icon ghost" type="button" title="Close" aria-label="Close" data-close-modal>&times;</button>
        </div>
        <div class="dialog-body">
          <div class="form-grid">
            <label><span>Project</span><input id="obsProject" type="text" placeholder="Optional" /></label>
            <label><span>Type</span><select id="obsType">
              <option value="note">note</option>
              <option value="bugfix">bugfix</option>
              <option value="feature">feature</option>
              <option value="refactor">refactor</option>
              <option value="discovery">discovery</option>
              <option value="decision">decision</option>
              <option value="change">change</option>
            </select></label>
            <label><span>Title</span><input id="obsTitle" type="text" placeholder="Required" /></label>
            <label><span>Content</span><textarea id="obsContent" placeholder="Required"></textarea></label>
            <label><span>Tags</span><input id="obsTags" type="text" placeholder="Comma-separated" /></label>
            <label><span>Files</span><input id="obsFiles" type="text" placeholder="Comma-separated" /></label>
          </div>
          <div class="form-actions">
            <button class="ghost" type="button" data-close-modal>Cancel</button>
            <button class="primary" type="button" id="submitObservation">Save Memory</button>
          </div>
        </div>
      </section>

      <section id="summaryDialog" class="dialog" role="dialog" aria-modal="true" aria-labelledby="summaryTitle" hidden>
        <div class="dialog-head">
          <div>
            <h3 id="summaryTitle">Save Summary</h3>
            <p>Store the durable handoff that should survive the current chat context.</p>
          </div>
          <button class="icon ghost" type="button" title="Close" aria-label="Close" data-close-modal>&times;</button>
        </div>
        <div class="dialog-body">
          <div class="form-grid">
            <label><span>Project</span><input id="sumProject" type="text" placeholder="Optional" /></label>
            <label><span>Learned</span><textarea id="sumLearned" placeholder="Required"></textarea></label>
            <label><span>Request</span><textarea id="sumRequest" placeholder="Optional"></textarea></label>
            <label><span>Completed</span><textarea id="sumCompleted" placeholder="Optional"></textarea></label>
            <label><span>Next steps</span><textarea id="sumNextSteps" placeholder="Optional"></textarea></label>
            <label><span>Tags</span><input id="sumTags" type="text" placeholder="Comma-separated" /></label>
          </div>
          <div class="form-actions">
            <button class="ghost" type="button" data-close-modal>Cancel</button>
            <button class="primary" type="button" id="submitSummary">Save Summary</button>
          </div>
        </div>
      </section>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();

      const statusWorker = document.getElementById("statusWorker");
      const statusEntries = document.getElementById("statusEntries");
      const statusProjects = document.getElementById("statusProjects");
      const statusDb = document.getElementById("statusDb");
      const statusUpdated = document.getElementById("statusUpdated");
      const errorNode = document.getElementById("error");
      const modalBackdrop = document.getElementById("modalBackdrop");
      const observationDialog = document.getElementById("observationDialog");
      const summaryDialog = document.getElementById("summaryDialog");

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

      function openDialog(kind) {
        showError("");
        const isSummary = kind === "summary";
        observationDialog.hidden = isSummary;
        summaryDialog.hidden = !isSummary;
        modalBackdrop.classList.add("open");
        modalBackdrop.setAttribute("aria-hidden", "false");
        const focusTarget = document.getElementById(isSummary ? "sumLearned" : "obsTitle");
        if (focusTarget) {
          focusTarget.focus();
        }
      }

      function closeDialog() {
        modalBackdrop.classList.remove("open");
        modalBackdrop.setAttribute("aria-hidden", "true");
        observationDialog.hidden = true;
        summaryDialog.hidden = true;
      }

      for (const button of document.querySelectorAll("button[data-action]")) {
        button.addEventListener("click", () => {
          showError("");
          post(button.getAttribute("data-action") || "");
        });
      }

      for (const button of document.querySelectorAll("button[data-open-modal]")) {
        button.addEventListener("click", () => {
          openDialog(button.getAttribute("data-open-modal") || "observation");
        });
      }

      for (const node of document.querySelectorAll("[data-close-modal]")) {
        node.addEventListener("click", (event) => {
          const target = event.target;
          if (target instanceof HTMLElement && target.hasAttribute("data-close-modal")) {
            closeDialog();
          }
        });
      }

      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeDialog();
        }
      });

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
          const available = payload.engineAvailable === true;
          statusWorker.textContent = available ? "SQLite direct" : "Unavailable";
          statusWorker.className = available ? "pill ok" : "pill warn";
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
          closeDialog();
          return;
        }

        if (message.command === "clear-summary") {
          document.getElementById("sumLearned").value = "";
          document.getElementById("sumRequest").value = "";
          document.getElementById("sumCompleted").value = "";
          document.getElementById("sumNextSteps").value = "";
          document.getElementById("sumTags").value = "";
          closeDialog();
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

function cssClassToken(value: string | undefined): string {
  return (
    value
      ?.toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
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
