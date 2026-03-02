# Project Memory MCP Server

Shared, project-scoped memory for **Claude Code**, **Codex CLI**, and **Gemini CLI** — so all three agents remember the same context.

```
You (any CLI) ──► MCP Server ──► .ai/memory.json (per project)
```

## Install

```bash
npm install -g project-memory-mcp
```

## Setup

Run the wizard from any project you want to enable:

```bash
cd ~/my-project
project-memory-mcp setup
```

The wizard will:
- Ask for a server ID (e.g. `my-project-memory`)
- Detect your project directory
- Let you pick which CLIs to configure (Claude / Gemini / Codex)
- Write the MCP config for each CLI automatically

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
| `memory_observe` | Push an observation for pattern detection |
| `memory_suggest` | See pending suggestions from the engine |
| `memory_suggestion_feedback` | Accept or reject a suggestion |

All tools accept an optional `projectRoot` for multi-project routing.

See [`docs/TOOL_EXAMPLES.md`](docs/TOOL_EXAMPLES.md) for copy-paste examples of every tool.

## Suggestion Engine

The server detects patterns mid-session and nudges you to save useful context:

1. Push observations — `memory_observe` with `{"type":"bash_command","content":"npm install axios"}`
2. Engine matches rules — version checks, dependency changes, deploys, error-fix cycles, config edits
3. Review — `memory_suggest` to see suggestions, `memory_suggestion_feedback` to accept/reject
4. Feedback loop — accepts boost that category's score; rejects lower it. Persists in `.ai/suggestion-feedback.json`.

## Auto-Save Hooks

Optional hooks automatically capture versions, dependencies, commits, and error fixes from your session transcript — no manual `memory_save` needed.

- **Claude Code**: runs on `Stop` event via `.claude/settings.json`
- **Gemini CLI**: runs on `SessionEnd` event via `.gemini/settings.json`
- **Codex CLI**: requires manual setup in `~/.codex/config.toml`

Items are deduplicated across sessions using title hashing and similarity checks.

Test hooks: `npm run test:hooks`

## Environment Variables

| Variable | Purpose |
|---|---|
| `MEMORY_PROJECT_ROOT` | Force a specific project root |
| `MEMORY_FILE_PATH` | Override the memory file path |
| `PROJECT_MEMORY_MCP_CLAUDE_CONFIG_PATH` | Override Claude config path (default `~/.claude.json`) |

## Troubleshooting

| Problem | Fix |
|---|---|
| `memory.json` not created | Run `memory_status` — project root is probably wrong. Fix `cwd` in MCP config. |
| Server not available | Check CLI MCP config. Confirm `node -v` works and the server file exists. |
| Data not saved | You must call a write tool. Chat alone does not persist. |

## Development

```bash
git clone https://github.com/nicobailon/project-memory-mcp-js.git
cd project-memory-mcp-js
npm install && npm run build
npm run test:hooks
```

See [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md) for the full guide and [`docs/LOCAL_NPM_DEPLOY.md`](docs/LOCAL_NPM_DEPLOY.md) for publishing.
