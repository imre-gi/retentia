# Retentia VS Code Extension

Retentia for VS Code adds persistent memory workflows, multi-LLM task sync, and execution observability directly into your editor.

![Retentia Dashboard Preview](./assets/retentia-dashboard-preview.png)

## Install

In commands below, `<repo-root>` means the directory where you cloned this repository.

### One-command install (recommended)

```bash
cd <repo-root>
npm run install:vscode
```

This root command installs both the core Retentia runtime and this extension, then installs the MCP stdio server configuration.

### Clean reinstall

```bash
cd <repo-root>
npm run reinstall:vscode
```

Profile-specific reinstall:

```bash
cd <repo-root>
RETENTIA_VSCODE_PROFILE="<profile-name>" npm run reinstall:vscode
```

### Development host

```bash
cd <repo-root>/vscode-extension
npm install
npm run build
```

Open `vscode-extension` in VS Code and press `F5`.

### VSIX install

```bash
cd <repo-root>/vscode-extension
npm install
npm run install:local
```

If VS Code CLI is not on PATH:

```bash
RETENTIA_VSCODE_CLI="<path-or-command-for-code>" npm run install:local
```

## Commands

| Command title | Command ID | What it does |
| --- | --- | --- |
| `Retentia: Install MCP for Codex` | `retentia.installMcp` | Registers the MCP stdio server in Codex config. |
| `Retentia: Initialize Store` | `retentia.initStore` | Initializes and verifies local storage. |
| `Retentia: Sync LLM Tasks (Copilot/Codex/Claude Code)` | `retentia.syncTasks` | Imports provider task execution events. |
| `Retentia: Project Explorer + Visualizer` | `retentia.projectExplorer` | Opens dashboard exploration view. |
| `Retentia: Status Dashboard` | `retentia.statusDashboard` | Opens full operational dashboard. |
| `Retentia: Open Settings` | `retentia.openSettings` | Opens extension settings in VS Code. |
| `Retentia: Add Observation` | `retentia.addObservation` | Interactive observation capture flow. |
| `Retentia: Add Summary` | `retentia.addSummary` | Interactive summary capture flow. |
| `Retentia: Search Memory` | `retentia.search` | Search entries and open detail payloads. |
| `Retentia: Generate Context Pack` | `retentia.contextPack` | Build prompt-ready context pack. |
| `Retentia: Open Memory File` | `retentia.openMemoryFile` | Open active SQLite file in editor. |

Sidebar:
- `Retentia` activity bar icon includes `Quick Input` for MCP install, task sync, and direct memory/session-summary entry forms.

## Settings

| Setting | Default | Intent |
| --- | --- | --- |
| `retentia.cliPath` | `""` | Explicit CLI path (`retentia` or script path). |
| `retentia.defaultProject` | `""` | Default project for new entries. |
| `retentia.autoSyncTasks` | `true` | Auto-sync task execution on dashboard refresh. |
| `retentia.enabledProviders` | `["copilot","codex","claude-code"]` | Provider list for ingestion. |
| `retentia.autoSyncLookbackDays` | `7` | Session log lookback window. |
| `retentia.autoSyncMaxImport` | `25` | Max imported tasks per sync run. |
| `retentia.autoSyncMaxFiles` | `24` | Max files scanned per provider. |
| `retentia.codexSessionsPath` | `""` | Optional Codex sessions path override. |
| `retentia.claudeSessionsPath` | `""` | Optional Claude sessions path override. |
| `retentia.dashboardLimit` | `600` | Max recent events loaded into dashboard views. |

## Dashboard Walkthrough

The dashboard provides:

- Action bar: `Refresh`, `Install MCP`, `Sync LLM Tasks`.
- KPI cards: events, tasks, memories, evidence, projects, providers, and agents.
- Runtime panel: MCP command/args and active SQLite DB file.
- Provider Sync matrix: detected/imported/skipped/failed by provider.
- Execution Visualizer: distribution bars by provider/status/agent/model.
- Execution trend charts: daily and weekly execution deltas.
- Project Explorer: per-project totals and outcomes.
- Task Explorer: filterable task list by project/provider/agent/model/status.

## About "Tasks Executed"

`Tasks Executed` reflects persisted memory entries.

- If your workflow does not write memory entries, totals may stay low.
- The extension can auto-import execution events from enabled providers.
- Trigger manual import with `Retentia: Sync LLM Tasks (Copilot/Codex/Claude Code)`.

## CLI Discovery

The extension resolves CLI in this order:

1. `retentia.cliPath`
2. `<workspace>/dist/cli.js`
3. `<workspace>/../dist/cli.js`
4. `<workspace>/retentia/dist/cli.js`
5. `<workspace>/../retentia/dist/cli.js`
6. `<workspace>/../../retentia/dist/cli.js`
7. `retentia` from PATH

## Troubleshooting

### Commands are missing in command palette

```bash
cd <repo-root>
npm run reinstall:vscode
```

Then:

1. Run `Developer: Reload Window`.
2. Search for `Retentia` in `Ctrl+Shift+P`.

### CLI path resolution fails

Set `retentia.cliPath` to:

- `<repo-root>/dist/cli.js`, or
- `retentia`.

### MCP visible in extension but not active in Codex

```bash
codex mcp list
codex mcp get retentia
cd <repo-root>
node dist/cli.js install --client codex
```

## Development

```bash
cd <repo-root>/vscode-extension
npm install
npm run build
```

Start Extension Development Host with `F5`.
