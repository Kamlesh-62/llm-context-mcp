# Project Memory MCP Server (JSON backend)

This is a **project-scoped** centralized memory service you can share across **Claude Code**, **Codex**, and **Gemini CLI** via **MCP (stdio)**.

- Storage file: `./.ai/memory.json` (per project)
- Multi-project routing: optional `projectRoot` input on tools
- Safer writes: `memory_propose` → `memory_approve_proposal`
- Fast writes: `memory_save` (direct write)
- Retrieval: `memory_search`, `memory_get_bundle`

## Quick start

```bash
npm install
npm run start
```

> Important: For STDIO MCP servers, do not print to stdout inside the server. This server logs only to stderr.

## Recommended: keep memory project-only

If your MCP client launches this server from a target project, memory is auto-scoped to that project (`.git` ancestor detection).

If you run one shared server for many projects, pass `projectRoot` in tool calls so each call writes/reads from the correct project folder.

You can override paths with env vars:

- `MEMORY_PROJECT_ROOT=/absolute/path/to/project`
- `MEMORY_FILE_PATH=./.ai/memory.json` (relative paths resolve from project root)

## Tooling

### Read
- `memory_status` — show resolved project root + memory file path
- `memory_search` — keyword/tag search
- `memory_get_bundle` — compact context bundle for the current task

### Write (gated)
- `memory_propose` — create proposals (pending approval)
- `memory_list_proposals` — list proposals
- `memory_approve_proposal` — approve/reject proposal (approval writes the actual memory item)

### Write (direct)
- `memory_save` — save memory item immediately (no approval step)
- `memory_pin` — pin/unpin an item

## Cross-model workflow

Use this loop in each project:

1. Call `memory_status` (with `projectRoot` when needed) to verify the exact memory file path.
2. Before working, call `memory_get_bundle` with the current task prompt.
3. After meaningful changes, call `memory_save` with a concise summary of what changed.
4. Any model (Claude/Codex/Gemini) can then call `memory_search` or `memory_get_bundle` and see the same project context.

## CLI setup guide

- See `docs/CLI_MCP_SETUP.md` for copy-paste setup and testing steps for:
  - Claude Code
  - Gemini CLI
  - Codex CLI
- Kid-friendly explanation: `docs/PROJECT_DOCS_FOR_KIDS.md`

## File layout

```text
server.js                # entrypoint
src/config.js            # constants
src/runtime.js           # project root + memory path resolution
src/storage.js           # JSON store I/O + locking
src/domain.js            # tokenization/scoring/normalization helpers
src/tools.js             # MCP tool registrations
src/main.js              # server bootstrap (stdio)
.ai/memory.json          # persisted project memory
```

You may want to add `.ai/` to `.gitignore` if you do not want memory committed to the repo.
