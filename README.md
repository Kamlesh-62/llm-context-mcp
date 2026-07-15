# Project Memory MCP Server

Shared, project-scoped memory for **Claude Code**, **Codex CLI**, and **Gemini CLI** — so all three agents remember the same context.

```
You (any CLI) ──► MCP Server ──► .ai/memory.json (per project)
```

## Install

```bash
npm install -g context-bridge-mcp
```

## Upgrading

Already have it installed? Update, then re-sync each project:

```bash
npm update -g context-bridge-mcp        # get the new version
cd ~/my-project
project-memory-mcp setup                 # re-writes hooks at the new package path
project-memory-mcp doctor                # verify config, store, hooks, SQLite driver
```

Re-running `setup` is what installs newly added features (e.g. the auto-save hooks and real-time capture) — the wizard is idempotent and merges into existing config without clobbering it. Your memory data is untouched by an upgrade. To also change where memory is stored, see [Storage](#storage).

## Setup

Run the wizard from any project you want to enable:

```bash
cd ~/my-project
project-memory-mcp setup
```

The wizard will:
- Ask for a server ID (e.g. `my-project-memory`)
- Detect your project directory
- Ask your name and team so shared memory records who added what (see [Team attribution](#team-attribution))
- Let you pick which CLIs to configure (Claude / Gemini / Codex)
- Write the MCP config for each CLI automatically
- Offer to install the auto-save hooks (Stop, plus optional real-time `PostToolUse`) at the correct installed-package path

Verify it works — ask your CLI:

> Call `memory_status` and show the output.

You should see `projectRoot` pointing to your project and `memoryFilePath` to `.ai/memory.json`.

### Re-apply config without prompts

```bash
project-memory-mcp switch                  # all CLIs
project-memory-mcp switch --cli claude     # one CLI only
```

### Scripted setup (CI / automation)

```bash
project-memory-mcp setup --yes --server-id my-server --runner npx --cli claude,gemini
```

Run `project-memory-mcp setup --help` for all flags.

### Other commands

```bash
project-memory-mcp doctor    # health-check setup: MCP config, store readable, hooks wired + run
project-memory-mcp migrate --to sqlite   # move memory between JSON and SQLite (see Storage)
project-memory-mcp help      # list all commands
```

## Usage

The core loop is three steps:

```
1. memory_get_bundle  →  load context for your task
2. ... do your work ...
3. memory_save        →  store what you learned
```

Any CLI (Claude, Codex, Gemini) can then pick up where another left off.

### Save something

```
Call memory_save with:
  title: "API uses JWT auth"
  type: "decision"
  content: "All endpoints require Bearer token. Tokens expire in 24h."
  tags: ["auth", "api"]
```

### Load context

```
Call memory_get_bundle with prompt "fixing login bugs"
```

### Search memory

```
Call memory_search with query "auth"
```

## All Tools

| Tool | What it does |
|---|---|
| `memory_status` | Check setup — shows project root and memory file path |
| `memory_help` | Quick-start tips and sample prompts |
| `memory_get_bundle` | Load ranked context for your current task |
| `memory_search` | Search saved items by keyword or tags |
| `memory_save` | Save a memory item directly |
| `memory_propose` | Save with an approval step (creates a proposal) |
| `memory_approve_proposal` | Approve or reject a pending proposal |
| `memory_list_proposals` | List proposals by status |
| `memory_pin` | Pin/unpin items (pinned items always appear in bundles) |
| `memory_update` | Update an existing item's fields |
| `memory_delete` | Permanently remove an item |
| `memory_compact` | Archive old items to keep the store lean |
| `memory_search_archive` | Search archived (compacted) items |
| `memory_restore` | Move an archived item back into the active store |
| `memory_export` | Export the full store (active + archive) |
| `memory_observe` | Push an observation for pattern detection |
| `memory_suggest` | See pending suggestions from the engine |
| `memory_suggestion_feedback` | Accept or reject a suggestion |
| `memory_configure_suggestions` | Tune the suggestion engine at runtime |

All tools accept an optional `projectRoot` for multi-project routing.

See [`docs/TOOL_EXAMPLES.md`](docs/TOOL_EXAMPLES.md) for copy-paste examples of every tool.

## Suggestion Engine

The server detects patterns mid-session and nudges you to save useful context:

1. Push observations — `memory_observe` with `{"type":"bash_command","content":"npm install axios"}`
2. Engine matches rules — version checks, dependency changes, deploys, error-fix cycles, config edits
3. Review — `memory_suggest` to see suggestions, `memory_suggestion_feedback` to accept/reject
4. Feedback loop — accepts boost that category's score; rejects lower it. Persists in `.ai/suggestion-feedback.json`.

## Auto-Save Hooks

Hooks automatically capture versions, dependencies, commits, error fixes, TODOs, config values, and chosen-library decisions from your session transcript — no manual `memory_save` needed. `setup` installs them for you (at the correct installed-package path).

Two capture modes:

- **`Stop` (session end)** — sweeps the whole transcript when the session ends. Installed by default.
- **`PostToolUse` (real-time)** — captures incrementally after each tool call, so nothing is lost if the session crashes. Opt-in during `setup`; shares one cursor + dedup with the Stop sweep.

Per CLI:

- **Claude Code** — `.claude/settings.json` (`Stop` + optional `PostToolUse`).
- **Codex CLI** — `notify` bridge in `~/.codex/config.toml`, plus optional native `PostToolUse` hook (`.codex/hooks.json` + `[features] hooks = true`). Codex rollout transcripts (Responses API shape) are normalized to the same extractors.
- **Gemini CLI** — `SessionEnd` event via `.gemini/settings.json`.

Items are deduplicated across sessions via title hashing and Jaccard similarity, which also decides **update-in-place** vs skip vs add so memory doesn't fill with restatements. Auto-captured items are tagged `source: "auto-hook"`.

Verify hooks are wired and have run: `project-memory-mcp doctor`. Test the extractors: `npm run test:hooks`.

## Team attribution

When a team shares a memory store, every item can record **who added it**. `setup` asks for your name and (optional) team once; new items are then stamped with an `author` field — whether you save them by hand (`memory_save`), through a proposal, or via the auto-save hooks.

Your identity is per-user, not per-project: it lives in `~/.project-memory-mcp/identity.json` and is reused everywhere. It is **never** written into the shared `.ai/` store, so it can't leak into git.

Resolution order (first hit wins):

1. env `MEMORY_AUTHOR_NAME` / `MEMORY_AUTHOR_TEAM` — for CI or one-offs
2. `~/.project-memory-mcp/identity.json` — what `setup` writes
3. git `user.name` — a name-only fallback so attribution works even before you run setup

Change it any time by re-running `project-memory-mcp setup`, or check the resolved value with `project-memory-mcp doctor`. If no name resolves, items are saved without an `author` — nothing breaks.

## Storage

Memory lives in one local file per project. Two backends:

- **JSON** (`.ai/memory.json`) — the zero-config default. Human-readable and git-diffable.
- **SQLite** (`.ai/memory.sqlite`) — opt-in for larger stores / faster search. Binary, not git-diffable. Uses built-in `node:sqlite` (Node ≥22.5) or `better-sqlite3` as a fallback.

Select per project via `.ai/memory-mcp.json` (`{"storage":{"backend":"sqlite"}}`) or the `MEMORY_STORAGE_BACKEND` env var. Move between them with `project-memory-mcp migrate --to <json|sqlite>` — the source is left intact, so it's reversible.

See [`docs/STORAGE_BACKENDS.md`](docs/STORAGE_BACKENDS.md) for the full comparison and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

## Environment Variables

| Variable | Purpose |
|---|---|
| `MEMORY_PROJECT_ROOT` | Force a specific project root |
| `MEMORY_FILE_PATH` | Override the JSON memory file path |
| `MEMORY_STORAGE_BACKEND` | Force the storage backend (`json` \| `sqlite`) |
| `MEMORY_DB_PATH` | Override the SQLite database path |
| `MEMORY_AUTHOR_NAME` | Author name stamped on new items (overrides the saved identity) |
| `MEMORY_AUTHOR_TEAM` | Author team stamped on new items |
| `PROJECT_MEMORY_MCP_HOME` | Override the per-user config dir (default `~/.project-memory-mcp`) |
| `PROJECT_MEMORY_MCP_CLAUDE_CONFIG_PATH` | Override Claude config path (default `~/.claude.json`) |
| `CODEX_HOME` | Override Codex config dir (default `~/.codex`) |

## Troubleshooting

Run `project-memory-mcp doctor` first — it checks MCP config, store readability, SQLite driver, and whether hooks are wired and have run.

| Problem | Fix |
|---|---|
| `memory.json` not created | Run `memory_status` — project root is probably wrong. Fix `cwd` in MCP config. |
| Server not available | Check CLI MCP config. Confirm `node -v` works and the server file exists. |
| Data not saved | You must call a write tool. Chat alone does not persist. |
| Auto-save never fires | Run `doctor` — the hook may not be installed. Re-run `setup` and accept the hooks step. |
| SQLite selected but errors | Node < 22.5 needs `npm i better-sqlite3`. `doctor` reports driver availability. |

## Development

```bash
git clone https://github.com/nicobailon/project-memory-mcp-js.git
cd project-memory-mcp-js
npm install && npm run build
npm run test:hooks
```

See [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md) for the full guide and [`docs/LOCAL_NPM_DEPLOY.md`](docs/LOCAL_NPM_DEPLOY.md) for publishing.
