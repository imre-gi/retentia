# Retentia

Retentia is a local-first memory, task history, and agent graph engine for
AI-assisted development. It gives Codex, Claude Code, Copilot-oriented workflows,
and other MCP-compatible clients a durable SQLite memory instead of relying only
on chat context.

The current runtime is Retentia. It stores:

- events: task starts, completions, failures, tool calls, file changes, decisions,
  and other execution activity
- memories: durable facts, decisions, procedures, constraints, preferences,
  artifacts, todos, and episodes
- graph edges: relationships between tasks, agents, artifacts, decisions, and
  memories
- dashboard snapshots: compact operational state for agents, tasks, activities,
  memories, graph edges, and context preview

Retentia is designed to be useful even when no remote service is available. The
default database lives on the local machine at:

```text
~/.retentia/retentia-v2.db
```

## What Retentia Does

Retentia solves a specific problem: AI coding sessions lose project memory unless
the user manually re-explains previous work. Retentia provides a local memory
layer that agents can query before work starts and update while work progresses.

It supports four core workflows.

1. Local memory retrieval

   Search previous facts, decisions, procedures, constraints, artifacts, and
   episodes by text, project, kind, or tags.

2. Prompt-ready context packs

   Build compact context blocks with hard character budgets so a model can be
   primed without dumping an entire history.

3. Task and agent observability

   Record execution events with source, actor, role, task id, project, summary,
   artifacts, tags, and structured payloads.

4. Execution graph

   Link memories, tasks, artifacts, and decisions so later sessions can recover
   why something exists and what it relates to.

## Who It Is For

Use Retentia when you want:

- Codex to recall prior implementation decisions before touching a repo
- a persistent task log across coding sessions
- a local memory database that is not tied to one model vendor
- MCP tools for memory search and update
- a VS Code dashboard for inspecting agents, tasks, memories, and graph edges
- a way to ingest local session logs from Codex, Claude Code, and Copilot Chat

Do not use Retentia as a secret store. It is local by default, but it can contain
sensitive development context if an agent writes secrets into memory. Do not add
credentials, private tokens, production customer data, or raw participant data.

## Repository Layout

```text
.
├── src/
│   ├── cli.ts              # CLI entrypoint
│   ├── v2-engine.ts        # SQLite-backed memory/event/graph engine
│   ├── v2-mcp-server.ts    # MCP stdio server exposing Retentia tools
│   ├── v2-task-ingest.ts   # Local session-log ingestion
│   └── v2-types.ts         # public data types
├── vscode-extension/       # VS Code dashboard and command integration
├── scripts/
│   ├── clean-dist.mjs      # removes generated build output before compiling
│   └── vscode-install.mjs  # one-command local installer
├── tests/                  # Vitest coverage
├── docs/                   # benchmark notes and images
└── README.md
```

## Requirements

- Node.js 20 or newer
- npm
- Codex CLI if you want automatic Codex MCP registration
- VS Code CLI (`code`) if you want the extension installed automatically

The installer can still build and configure the core runtime if VS Code is not
available. It will skip extension installation when it cannot find a usable
`code` command.

## Quick Start

From the repository root:

```bash
npm install
npm run build
node dist/cli.js init
```

If you install the package globally or link it locally, you can use the shorter
binary:

```bash
retentia init
```

The examples below use `retentia`. If the binary is not on your `PATH`, replace
`retentia` with:

```bash
node dist/cli.js
```

## Install Everything Locally

The recommended local install command is:

```bash
npm run install:vscode
```

This command:

- installs root dependencies
- rebuilds the native `better-sqlite3` dependency for the current Node runtime
- builds the Retentia CLI
- registers the Retentia MCP server for Codex when Codex is available
- writes a Claude Code MCP config reference to `~/.retentia/claude-code-mcp.json`
- installs Retentia-first hooks for Codex and Claude Code
- installs VS Code extension dependencies
- packages the VSIX
- installs the VS Code extension into detected profiles

If VS Code CLI is not on `PATH`, provide it explicitly:

```bash
RETENTIA_VSCODE_CLI="/path/to/code" npm run install:vscode
```

For a clean reinstall:

```bash
npm run reinstall:vscode
```

For a specific VS Code profile:

```bash
RETENTIA_VSCODE_PROFILE="Profile Name" npm run reinstall:vscode
```

## Installed Hooks

`npm run install:vscode` installs one shared hook script:

```text
~/.retentia/hooks/retentia-enforcement.mjs
```

The installer registers that script in:

```text
~/.codex/hooks.json
~/.claude/settings.json
```

The hooks run on these lifecycle events:

- `UserPromptSubmit`: injects Retentia-first task instructions into the model context.
- `PreToolUse`: blocks non-Retentia technical tools until a Retentia read is observed.
- `PostToolUse`: tracks whether the current turn has inspected and updated Retentia.
- `Stop`: blocks task completion until Retentia has been updated after substantive work.

Valid Retentia read tools are:

- `memory_search`
- `memory_context`
- `dashboard_snapshot`

Valid Retentia write tools are:

- `agent_event`
- `memory_add`

The hook installation is idempotent. Re-running the installer replaces older
Retentia enforcement hooks while preserving unrelated hooks already configured
for Codex or Claude Code.

## CLI Basics

The package exposes one primary binary:

```bash
retentia
```

Local development equivalent:

```bash
node dist/cli.js
```

Show help:

```bash
retentia help
```

Retentia commands are top-level only. There is no compatibility namespace for
older command surfaces.

## Data File

Default database:

```text
~/.retentia/retentia-v2.db
```

Override per command:

```bash
retentia search --data-file /tmp/retentia-v2.db --query "oauth"
```

Override by environment:

```bash
RETENTIA_DB_FILE=/tmp/retentia-v2.db retentia dashboard
```

Older store formats and command surfaces are not supported.

## MCP Setup

### Codex

Register Retentia as a Codex MCP server:

```bash
retentia install --client codex
```

Preview the Codex registration command without changing config:

```bash
retentia install --client codex --dry-run
```

Use a custom MCP server name:

```bash
retentia install --client codex --name retentia
```

Verify with Codex:

```bash
codex mcp list
codex mcp get retentia
```

### Claude Code

Generate a Claude Code-compatible MCP configuration:

```bash
retentia mcp-config --client claude-code
```

The local installer also writes this reference file:

```text
~/.retentia/claude-code-mcp.json
```

Copy the generated `mcpServers` block into your Claude Code MCP configuration.

### Manual MCP Server

Start the MCP stdio server directly:

```bash
retentia mcp
```

With an explicit database:

```bash
retentia mcp --data-file ~/.retentia/retentia-v2.db
```

Most users do not run this manually. MCP clients start it from their configured
command.

## MCP Tools

Retentia exposes these MCP tools.

### `agent_event`

Records live execution activity from an agent, subagent, task, tool call, or
outcome.

Required fields:

- `type`
- `source`

Useful optional fields:

- `actor`
- `role`
- `taskId`
- `parentTaskId`
- `project`
- `summary`
- `tags`
- `artifacts`
- `payload`

Example:

```json
{
  "type": "task_started",
  "source": "codex",
  "actor": "codex",
  "project": "Fred-Client",
  "summary": "Investigating tenant retrieval tests",
  "tags": ["tests", "ai-retrieval"]
}
```

### `memory_add`

Adds a durable memory.

Required fields:

- `kind`
- `title`
- `body`

Allowed memory kinds:

```text
episode, fact, decision, preference, procedure, constraint, artifact, todo
```

Useful optional fields:

- `project`
- `tags`
- `sourceEventIds`
- `confidence`
- `pinned`

Example:

```json
{
  "kind": "decision",
  "project": "Fred-Client",
  "title": "Tenant retrieval must preserve project scoping",
  "body": "AI tenant retrieval tests should validate tenant boundaries before broadening search.",
  "tags": ["ai", "tenant", "tests"],
  "confidence": 0.9,
  "pinned": true
}
```

### `memory_search`

Searches compact memories with full-text search and metadata filters.

Optional filters:

- `query`
- `project`
- `kind`
- `tags`
- `limit`

Use it at the start of a task to recover previous decisions and constraints.

### `memory_context`

Builds a prompt-ready context pack.

Optional fields:

- `query`
- `project`
- `kind`
- `tags`
- `limit`
- `mode`
- `maxChars`

Allowed context modes:

```text
ids, brief, task-primer, full-evidence
```

Default mode is `brief`. Use `task-primer` when starting implementation work.
Use `full-evidence` only when you need more source detail.

### `graph_edge`

Records a relationship between two nodes.

Required fields:

- `fromType`
- `fromId`
- `toType`
- `toId`
- `relation`

Optional fields:

- `weight`
- `metadata`

Example relationship:

```json
{
  "fromType": "memory",
  "fromId": "42",
  "toType": "artifact",
  "toId": "README.md",
  "relation": "documents",
  "weight": 1
}
```

### `graph_neighborhood`

Lists graph edges around a node.

Required fields:

- `nodeType`
- `nodeId`

Optional field:

- `limit`

### `dashboard_snapshot`

Returns a compact dashboard payload with agents, tasks, activities, memories,
graph edges, recent events, evidence chunk totals, and a context preview.

Optional field:

- `limit`

## Recommended Agent Workflow

For non-trivial technical work, the intended Retentia workflow is:

1. Inspect memory first.

   Use `memory_search` or `memory_context` with the target project, module,
   issue id, feature name, or file path.

2. Record the task start.

   Use `agent_event` with `type: "task_started"`, a concrete project, summary,
   tags, and relevant artifacts.

3. Keep durable findings out of chat-only context.

   Use `memory_add` for decisions, constraints, facts, procedures, or todos that
   should survive the current session.

4. Link important artifacts.

   Use `graph_edge` when a memory explains a file, plan, decision, task, or
   result.

5. Record completion.

   Use `agent_event` with `type: "task_completed"` or `type: "task_failed"` and
   include validation status and edited artifacts.

## CLI Command Reference

### `init`

Initializes the store and prints the active data file.

```bash
retentia init
```

### `install`

Registers the MCP server for a supported client.

```bash
retentia install --client codex
retentia install --client claude-code
retentia install --client codex --dry-run
```

Options:

- `--client codex|claude-code`
- `--name <mcp-name>`
- `--data-file <path>`
- `--dry-run`

### `mcp-config`

Prints MCP configuration without installing it.

```bash
retentia mcp-config --client claude-code
retentia mcp-config --client codex
```

### `mcp`

Starts the MCP stdio server.

```bash
retentia mcp
```

### `event`

Adds an execution event.

```bash
retentia event \
  --type task_started \
  --source codex \
  --actor codex \
  --project Fred-Client \
  --task-id fred-123 \
  --summary "Inspect AI retrieval tests" \
  --tags tests,ai
```

With structured payload:

```bash
retentia event \
  --type decision \
  --source codex \
  --project retentia \
  --summary "Document top-level Retentia commands" \
  --payload '{"reason":"CLI commands route to the current store"}'
```

### `memory`

Adds a durable memory.

```bash
retentia memory \
  --kind procedure \
  --project retentia \
  --title "Install Retentia locally" \
  --body "Run npm install, npm run build, then retentia install --client codex." \
  --tags install,mcp \
  --confidence 0.95
```

Pinned memory:

```bash
retentia memory \
  --kind constraint \
  --title "Do not store secrets" \
  --body "Retentia is local-first but must not be used as a credential store." \
  --pinned
```

### `search`

Searches memories.

```bash
retentia search --query "oauth" --project Fred-Client --limit 10
```

Filter by kind:

```bash
retentia search --kind decision --project retentia
```

Filter by tags:

```bash
retentia search --tags docs,mcp
```

### `context`

Builds a compact context pack.

```bash
retentia context --query "tenant retrieval" --project Fred-Client
```

Task-primer mode:

```bash
retentia context \
  --query "retentia install" \
  --mode task-primer \
  --max-chars 4000
```

JSON output:

```bash
retentia context --query "mcp" --json
```

### `edge`

Creates a graph relationship.

```bash
retentia edge \
  --from-type memory \
  --from-id 42 \
  --to-type artifact \
  --to-id README.md \
  --relation documents \
  --weight 1
```

With metadata:

```bash
retentia edge \
  --from-type task \
  --from-id readme-update \
  --to-type memory \
  --to-id 42 \
  --relation produced \
  --metadata '{"source":"manual"}'
```

### `graph`

Lists relationships around a node.

```bash
retentia graph --node-type memory --node-id 42
```

### `dashboard`

Prints a dashboard snapshot.

```bash
retentia dashboard --limit 80
```

The payload includes:

- totals for events, memories, graph edges, evidence chunks, agents, tasks, and
  projects
- agent summaries
- task summaries
- recent activities
- recent memories
- graph edges
- execution trend buckets with daily and weekly deltas
- context preview

### `ingest`

Imports local session events from supported providers.

```bash
retentia ingest --providers all --lookback-days 7 --max-import 100
```

Supported providers:

- `copilot`
- `codex`
- `claude-code`

Aliases:

- `github-copilot` and `copilot-chat` map to `copilot`
- `claude` and `claude_code` map to `claude-code`
- `all` means `copilot,codex,claude-code`

The importer keeps provider-specific metadata where available:

- Copilot: model, conversation ID, request ID, workspace folder, tool calls, and
  tool request metadata
- Codex: session metadata, turn context, model, cwd, sandbox/approval context,
  response item IDs, and tool call names
- Claude Code: model, cwd, message/UUID fields, permission mode, usage,
  tool use IDs, subagent type, and result status

Useful options:

- `--providers <list>`
- `--copilot-path <path>`
- `--codex-path <path>`
- `--claude-path <path>`
- `--lookback-days <n>`
- `--max-files <n>`
- `--max-import <n>`
- `--project <fallback-name>`

Default session roots:

```text
Codex:      ~/.codex/sessions
Claude:     ~/.claude/projects
Copilot:    VS Code workspaceStorage transcript locations
```

## VS Code Extension

The extension is in `vscode-extension/`.

Install from the repository root:

```bash
npm run install:vscode
```

Open the command palette and search for `Retentia`.

Important commands:

- `Retentia: Install MCP for Codex`
- `Retentia: Initialize Store`
- `Retentia: Import Copilot, Codex, and Claude Code Tasks`
- `Retentia: Run Doctor`
- `Retentia: Agent Command Center`
- `Retentia: Inspect Agents and Swarms`
- `Retentia: Open Settings`
- `Retentia: Add Memory`
- `Retentia: Save Session Memory`
- `Retentia: Search Memory`
- `Retentia: Generate Context Pack`
- `Retentia: Open Memory File`

The Retentia activity bar view includes a compact Quick Input panel. The panel
keeps frequent work visible: add a memory, save a session summary, open the
dashboard, run Doctor, sync tasks, and refresh status. `Add Memory` and
`Save Summary` open focused popover forms that can be closed with the close
button, Cancel, the backdrop, or Escape. MCP installation and path settings
remain in the command palette so the sidebar stays focused on daily capture.

`Retentia: Inspect Agents and Swarms` opens the control plane dashboard. It
has four tabs:

- `Control`: live agent/task map with an inspector for reasoning, activity, and
  context preview.
- `Memory`: durable memories plus the current compact context pack.
- `Quality`: retrieval health, memory confidence, evidence coverage, pinned
  context, context-budget usage, memory-kind distribution, and Doctor checks.
- `Operations`: execution trends, task success/failure mix, active load, agent
  workload, activity types, and project signal distribution.

Useful settings:

| Setting                         | Purpose                                                                   |
| ------------------------------- | ------------------------------------------------------------------------- |
| `retentia.cliPath`              | Explicit CLI path, such as `/path/to/retentia/dist/cli.js` or `retentia`. |
| `retentia.defaultProject`       | Default project for new entries.                                          |
| `retentia.autoSyncTasks`        | Auto-sync task execution on dashboard refresh.                            |
| `retentia.enabledProviders`     | Provider list used by the extension sync flow.                            |
| `retentia.autoSyncLookbackDays` | Session log lookback window.                                              |
| `retentia.autoSyncMaxImport`    | Max imported tasks per sync run.                                          |
| `retentia.autoSyncMaxFiles`     | Max session files scanned per provider.                                   |
| `retentia.codexSessionsPath`    | Optional Codex session path override.                                     |
| `retentia.claudeSessionsPath`   | Optional Claude session path override.                                    |
| `retentia.dashboardLimit`       | Max recent events loaded into dashboard views.                            |

## Development

Install and build:

```bash
npm install
npm run build
```

Run tests:

```bash
npm test
```

Run the MCP server from TypeScript during development:

```bash
npm run dev
```

Build the VS Code extension:

```bash
npm run vscode:build
```

Package the VS Code extension:

```bash
npm run vscode:package
```

## Troubleshooting

### `retentia` is not found

Use the local script path:

```bash
node dist/cli.js help
```

Or link/install the package so the `retentia` binary is on `PATH`.

### Native SQLite build errors

Rebuild `better-sqlite3` for the current Node runtime:

```bash
npm rebuild better-sqlite3
npm run build
```

### Codex does not show the MCP server

Check registration:

```bash
codex mcp list
codex mcp get retentia
```

Reinstall:

```bash
retentia install --client codex
```

Preview the command if you want to inspect it first:

```bash
retentia install --client codex --dry-run
```

### Claude Code needs manual config

Generate the config:

```bash
retentia mcp-config --client claude-code
```

Then copy the returned `mcpServers` object into Claude Code's MCP config.

### VS Code commands are missing

Reinstall the extension:

```bash
npm run reinstall:vscode
```

Then run `Developer: Reload Window` in VS Code.

### VS Code CLI is not detected

Set:

```bash
RETENTIA_VSCODE_CLI="/path/to/code" npm run install:vscode
```

### The dashboard is empty

Add at least one memory:

```bash
retentia memory \
  --kind fact \
  --title "Retentia is installed" \
  --body "The local Retentia store is available." \
  --project retentia
```

Or ingest recent local sessions:

```bash
retentia ingest --providers all --lookback-days 7 --max-import 100
```

Then:

```bash
retentia dashboard --limit 80
```

## Security And Privacy

Retentia is local-first, but local does not mean risk-free.

Use these rules:

- Do not store secrets, tokens, credentials, private URLs, or production keys.
- Do not store raw customer, participant, transcript, audio, video, or biometric
  data unless your project has explicit consent, retention, and access rules.
- Prefer summaries, decisions, constraints, and links to local artifacts over
  sensitive raw material.
- Treat exported database files as sensitive.
- Review memories before sharing logs, screenshots, or database backups.

## FAQ

### Is Retentia only for Codex?

No. Codex registration is automated because this repo is optimized for Codex
workflows, but the runtime is an MCP stdio server and can be used by other
MCP-compatible clients. The CLI can also generate Claude Code MCP config.

### Does Retentia require a cloud service?

No. The default store is local SQLite.

### What is the difference between events and memories?

Events are execution activity: what happened during a run. Memories are compact,
durable knowledge distilled from work: facts, decisions, procedures,
constraints, preferences, artifacts, todos, and episodes.

### When should I add a memory instead of an event?

Use an event for the timeline of work. Use a memory when the information should
influence future decisions.

## License

MIT. See [LICENSE](./LICENSE).
