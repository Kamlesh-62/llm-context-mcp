# Project Memory MCP Server

Shared, project-scoped memory for **Claude Code**, **Codex**, and **Gemini CLI** — so all three agents remember the same context.

```
You (any CLI) ──► MCP Server ──► .ai/memory.json (per project)
```

## TL;DR

```bash
npm install && npm start          # start the server
```

| What you want | Tool to call |
|---|---|
| Check setup is correct | `memory_status` |
| Load context before a task | `memory_get_bundle` |
| Save something to memory | `memory_save` |
| Search past memory | `memory_search` |

That's the core loop: **get bundle → do work → save what matters**.

---

## Get Started

### 1. Install

```bash
cd /path/to/project-memory-mcp-js
npm install
```

### 2. Connect your CLI

<details>
<summary><strong>Claude Code</strong></summary>

Edit `~/.claude.json` — add to your target project's `mcpServers`:

```json
"mcpServers": {
  "project-memory": {
    "command": "node",
    "args": ["/path/to/project-memory-mcp-js/server.js"],
    "cwd": "/path/to/your-target-project"
  }
}
```

Restart Claude CLI from the project folder.

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Run from your target project folder:

```bash
cd /path/to/your-target-project
gemini mcp add project-memory node /path/to/project-memory-mcp-js/server.js
```

Gemini scopes to `project` by default. Run this per repo where you want memory.

Remove: `gemini mcp remove project-memory`

</details>

<details>
<summary><strong>Codex CLI</strong></summary>

Codex MCP entries are global:

```bash
codex mcp add project-memory node /path/to/project-memory-mcp-js/server.js
```

Important: start Codex from the target repo folder so the server resolves the correct project root.

Remove: `codex mcp remove project-memory`

</details>

### 3. Verify

In any connected CLI, call `memory_status`. Confirm:

- `projectRoot` → your target repo
- `memoryFilePath` → `<target>/.ai/memory.json`

If wrong, fix your CLI config before continuing.

---

## Daily Workflow

```
1. memory_get_bundle  →  load relevant context for your task
2. ... do your work ...
3. memory_save        →  store what changed / what you learned
```

Any model (Claude, Codex, Gemini) can then pick up where another left off.

<details>
<summary><strong>Example: save context</strong></summary>

```text
Call MCP tool `memory_save` with:
- title: "Project runtime versions"
- type: "fact"
- content: "PHP 7.4.33, Laravel 5.6.40"
- tags: ["php","laravel","environment"]
- source: "claude"
```

</details>

<details>
<summary><strong>Example: load context</strong></summary>

```text
Call `memory_get_bundle` with prompt "I am fixing login API bugs" and maxItems 12.
```

</details>

---

## Reference

<details>
<summary><strong>All Tools</strong></summary>

### Read

| Tool | Purpose |
|---|---|
| `memory_status` | Show resolved project root, memory file path, counts, revision |
| `memory_search` | Keyword/tag search over saved items |
| `memory_get_bundle` | Compact ranked memory bundle for current task |
| `memory_list_proposals` | List proposals by status |

### Write (direct)

| Tool | Purpose |
|---|---|
| `memory_save` | Save memory item immediately (no approval step) |
| `memory_pin` | Pin or unpin an existing item |

### Write (gated)

| Tool | Purpose |
|---|---|
| `memory_propose` | Create proposals (pending approval) |
| `memory_approve_proposal` | Approve/reject proposal, optional edits |

All write tools accept an optional `projectRoot` input for multi-project routing.

</details>

<details>
<summary><strong>Data Model</strong></summary>

`memory.json` structure:

| Field | Description |
|---|---|
| `version` | Format version (currently `1`) |
| `project` | Metadata: `id`, `root`, timestamps |
| `items` | Approved/saved memory entries |
| `proposals` | Gated workflow entries (`pending`, `approved`, `rejected`) |
| `revision` | Incremented on every write |

</details>

<details>
<summary><strong>Memory Resolution Rules</strong></summary>

`projectRoot` is resolved in this priority:

1. Tool input `projectRoot` (if provided)
2. `MEMORY_PROJECT_ROOT` env var
3. Nearest ancestor with `.git`
4. Current working directory

Storage path:

- `MEMORY_FILE_PATH` env var if set (relative paths resolve from project root)
- Otherwise `<projectRoot>/.ai/memory.json`

</details>

<details>
<summary><strong>Update and Delete</strong></summary>

There is no `memory_update` or `memory_delete` tool yet.

**To update:** save a corrected item with `memory_save`. Add a tag like `supersedes:<old_id>` and optionally `memory_pin` the new one.

**To delete all:** `rm -f <projectRoot>/.ai/memory.json`

**To delete one item:** manually edit the `items` array in the JSON file.

</details>

<details>
<summary><strong>Environment Variables</strong></summary>

| Variable | Purpose |
|---|---|
| `MEMORY_PROJECT_ROOT` | Force a specific project root |
| `MEMORY_FILE_PATH` | Override the memory file path (relative resolves from project root) |

```bash
MEMORY_PROJECT_ROOT=/path/to/project npm run start
```

</details>

<details>
<summary><strong>File Layout</strong></summary>

```text
server.js              # entrypoint
src/main.js            # MCP bootstrap and transport connection
src/tools.js           # tool registration and handlers
src/storage.js         # lock, load/write, atomic persistence
src/runtime.js         # project root/path resolution
src/domain.js          # scoring/tokenization/validation helpers
src/config.js          # constants
src/logger.js          # stderr logger
.ai/memory.json        # persisted project memory (per project)
```

Add `.ai/` to `.gitignore` if you don't want memory committed to the repo.

</details>

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `memory.json` not created | Call `memory_status` — project root is probably wrong. Fix `cwd` (Claude) or run CLI from correct folder. |
| Server not available in CLI | Check CLI MCP config. Confirm `node -v` works and server file exists. |
| Data not saved | You must call a write tool (`memory_save` or approve a proposal). Chat alone does not persist. |

### Testing checklist

1. Configure CLI MCP server for target project
2. Restart CLI session
3. `memory_status` returns expected path
4. `memory_save` returns success
5. `memory_search` finds the saved item
6. Verify another CLI (Claude/Gemini/Codex) can see the same item

---

## For Kids

> This section explains the project in super simple words.

You have 3 robot helpers: **Claude**, **Codex**, and **Gemini**. They help you write code — but each one forgets things between chats.

This project is a **shared notebook** they can all read and write:

```
Robot saves a note  ──►  .ai/memory.json  ──►  Another robot reads it later
```

### What gets saved?

Only things you ask to save with `memory_save`. Your chat is **not** saved automatically.

### Daily steps

1. Open your coding project
2. Start Claude or Gemini in that folder
3. Ask: "Call `memory_get_bundle`" to load old notes
4. Do your work
5. Ask: "Call `memory_save`" to store what you learned

### What is MCP?

MCP is like a phone line between your AI and tools:

- AI says: "Please run `memory_save`"
- MCP server does it
- AI gets the result back

### Why this helps

- Less repeating yourself
- All robots share one memory
- Works on your local machine
- Memory stays inside each project
