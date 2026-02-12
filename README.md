# Project Memory MCP Server

Shared, project-scoped memory for **Claude Code**, **Codex**, and **Gemini CLI** — so all three agents remember the same context.

```
You (any CLI) ──► MCP Server ──► .ai/memory.json (per project)
```

This repository ships a Node.js MCP server that persists project facts/decisions into `<project>/.ai/memory.json`. Any supported CLI can read/write the same file, so switching between Claude, Codex, and Gemini feels stateful: load context with `memory_get_bundle`, perform work, and save what changed with `memory_save`.

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

## Quick setup (per project)

1. **Install / update this repo once**
   ```bash
   cd /path/to/project-memory-mcp-js
   git pull && npm install
   ```
2. **From the target project folder (e.g. `/path/to/my-app`) wire each CLI**
   - **Claude Code** – edit `~/.claude.json` and add:
     ```json
     "mcpServers": {
       "project-memory": {
         "command": "node",
         "args": ["/path/to/project-memory-mcp-js/server.js"],
         "cwd": "/path/to/my-app"
       }
     }
     ```
     Restart Claude inside `/path/to/my-app`.
   - **Gemini CLI**
     ```bash
     cd /path/to/my-app
     gemini mcp add project-memory node /path/to/project-memory-mcp-js/server.js --trust
     gemini mcp list          # should show CONNECTED
     /mcp                     # (in-session) inspect tools/resources
     ```
     Edit `.gemini/settings.json` if you need custom `cwd` or env vars.
   - **Codex CLI**
     ```bash
     cd /path/to/my-app
     codex mcp add project-memory node /path/to/project-memory-mcp-js/server.js
     codex mcp list
     ```
     Always start `codex` from `/path/to/my-app` so the server detects the right root.
3. **Verify routing**
   - In that project, ask your CLI to `Call memory_status and show the output.` You should see `projectRoot` = `/path/to/my-app` and `memoryFilePath` = `/path/to/my-app/.ai/memory.json`. If not, fix the MCP config (`cwd`, env vars, etc.) before continuing.
   - Need a reminder of commands? Run `memory_help` anytime for the cheat sheet.

> Prefer the long-form guide (env overrides, troubleshooting, auto hooks)? See `docs/LOCAL_SETUP.md`.

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

### Automatic compaction & archives

- The server automatically compacts when more than **400** active items exist (see `CONFIG.autoCompact`). Oldest entries are moved to `.ai/memory-archive.json`, and a summary note is added so you still know what was archived.
- To trigger compaction manually (or tune thresholds per project), call `memory_compact` and provide overrides such as `{ "maxItems": 250 }`.
- Archived content stays available for future manual review—`memory_get_bundle` only surfaces the most relevant active notes while summaries keep the historical trail discoverable.
- Want zero-click context? Configure the optional `hooks/auto-memory.mjs` script (`... start` on `UserPromptSubmit`, `... stop` on `Stop`) to auto-inject bundles and auto-save transcripts.

---

## Reference

<details>
<summary><strong>All Tools</strong></summary>

### Read

| Tool | Purpose |
|---|---|
| `memory_help` | Quick-start usage tips + sample prompts |
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

### Maintenance

| Tool | Purpose |
|---|---|
| `memory_compact` | Archive older items into `.ai/memory-archive.json` and add a summary note, keeping the active store lean |

All write tools accept an optional `projectRoot` input for multi-project routing.

</details>

### Tool invocation cheatsheet

| Tool | Minimal CLI prompt | Notes |
|---|---|---|
| `memory_status` | `Call memory_status and show the output.` | Confirms `projectRoot` + `.ai/memory.json` before you start. |
| `memory_help` | `Call memory_help.` | Returns this cheat sheet + best-practice prompts. |
| `memory_get_bundle` | `Call memory_get_bundle with {"prompt":"Fixing login bugs"}` | Adjust `maxItems`, `types`, or `projectRoot` per task. |
| `memory_save` | `Call memory_save with {"title":"New API",...}` | Provide `content`; optionally `tags`, `pinned`, `source`. |
| `memory_search` | `Call memory_search with {"query":"redis"}` | Add `includeContent`, `tags`, or `types` filters. |
| `memory_propose` | `Call memory_propose with {"items":[...],"reason":"code review"}` | Use when you want an approval step before saving. |
| `memory_approve_proposal` | `Call memory_approve_proposal with {"proposalId":"prop_...","action":"approve"}` | Include `edits` to tweak proposal content before approval. |
| `memory_pin` | `Call memory_pin with {"itemId":"mem_...","pinned":true}` | Pinning keeps key notes surfaced in bundles. |
| `memory_compact` | `Call memory_compact with {"maxItems":250}` | Keeps the active store lean; omit payload to use defaults. |

Usage tips:

- **Claude Code / Codex CLI**: type the phrase exactly (e.g. “Call memory_status…”). They’ll run the tool and return the output inline.
- **Gemini CLI**: either type the sentence or run `memory_compact {"maxItems":250}` directly in the terminal. `/mcp` shows the live list of tools + descriptions.

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

<details>
<summary><strong>Auto-Save Hook (Claude Code + Gemini CLI + Codex CLI)</strong></summary>

The `hooks/` directory contains hooks that **automatically capture** memory items from your session — no manual `memory_save` needed for routine facts.

### How it works

The auto-save hook runs **silently in the background** after each session:

1. **Trigger**: When your CLI session ends:
   - Claude Code: on `Stop` event (Ctrl+C or session end)
   - Gemini CLI: on `SessionEnd` event
   - Codex CLI: on notify events (when configured)

2. **Processing**:
   - `hooks/auto-save.mjs` reads the session transcript (JSONL or JSON format)
   - Heuristic extractors analyze tool calls and results
   - Extracts structured facts like versions, dependencies, commits, error fixes

3. **Saving**:
   - Deduplicates against existing memory using title hashing and similarity checks
   - Saves new items to `.ai/memory.json` with `source: "auto-hook"` and `tags: ["auto-hook"]`
   - Updates cursor in `.ai/.auto-save-cursor.json` to track progress

4. **Next session**: Only processes new transcript lines since last cursor position

### What gets captured automatically

| Category | Example Command | Extracted Item | Type |
|---|---|---|---|
| **Version checks** | `node -v` | "node version: v20.11.0" | fact |
| | `python --version` | "python version: 3.11.5" | fact |
| | `npm -v`, `pip -v`, `go version` | version facts | fact |
| **Dependencies** | `npm install express` | "Added dependency: express" | fact |
| | `pip install requests` | "Added dependency: requests" | fact |
| | `cargo add tokio` | "Added dependency: tokio" | fact |
| **Git commits** | `git commit -m "fix auth bug"` | "Commit: fix auth bug" | note |
| **Error fixes** | Command fails → retried command succeeds | "Resolved: [error summary]" | fact |
| **File changes** | Write/Edit tool calls | "Files modified this session (5)" | note |

All auto-saved items get these tags:
- `auto-hook` - identifies auto-captured items
- Category-specific tags: `version`, `environment`, `dependency`, `commit`, `error-resolution`, `file-changes`

### Example: What you'll see

**During session:**
```bash
$ node -v
v20.11.0
$ npm install express
added 57 packages
$ git commit -m "Add express server"
[main abc1234] Add express server
```

**After session ends** (automatic, silent):

Your `.ai/memory.json` will contain:
```json
{
  "items": [
    {
      "id": "mem_a1b2c3d4",
      "type": "fact",
      "title": "node version: v20.11.0",
      "content": "Detected via `node -v`",
      "tags": ["version", "environment", "auto-hook"],
      "source": "auto-hook",
      "createdAt": "2026-02-12T13:39:17.364Z"
    },
    {
      "id": "mem_e5f6g7h8",
      "type": "fact",
      "title": "Added dependency: express",
      "content": "Installed via `npm install express`",
      "tags": ["dependency", "auto-hook"],
      "source": "auto-hook",
      "createdAt": "2026-02-12T13:39:18.123Z"
    },
    {
      "id": "mem_i9j0k1l2",
      "type": "note",
      "title": "Commit: Add express server",
      "content": "Full command: git commit -m \"Add express server\"",
      "tags": ["commit", "auto-hook"],
      "source": "auto-hook",
      "createdAt": "2026-02-12T13:39:19.456Z"
    }
  ]
}
```

### Setup per CLI

#### Claude Code (already configured)

This repo includes `.claude/settings.json`:
```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node \"$CLAUDE_PROJECT_DIR/hooks/auto-save.mjs\"",
        "async": true,
        "timeout": 15
      }]
    }]
  }
}
```

**Status**: ✅ Works automatically in this project

**To disable**: Remove or rename `.claude/settings.json`

**Environment**: Hook receives `CLAUDE_PROJECT_DIR` env var pointing to project root

---

#### Gemini CLI (already configured)

This repo includes `.gemini/settings.json`:
```json
{
  "hooks": {
    "SessionEnd": [{
      "matcher": "*",
      "hooks": [{
        "name": "auto-save",
        "type": "command",
        "command": "node \"$GEMINI_PROJECT_DIR/hooks/auto-save.mjs\""
      }]
    }]
  }
}
```

**Status**: ✅ Works automatically in this project

**To disable**: Remove or rename `.gemini/settings.json`

**Environment**: Hook receives `GEMINI_PROJECT_DIR` env var pointing to project root

**Important**: Gemini hooks must output valid JSON to stdout. The hook returns `{}` for compatibility.

---

#### Codex CLI (needs manual setup)

**Setup required**: Edit your global Codex config at `~/.codex/config.toml`:

```toml
# Enable history persistence (required for hooks to access transcript)
[history]
persistence = "save-all"  # or just true

# Add the notify hook (adjust path to your installation)
[notify]
command = ["node", "/absolute/path/to/project-memory-mcp-js/hooks/codex-notify.mjs"]
```

Replace `/absolute/path/to/project-memory-mcp-js` with your actual installation path.

**Optional**: Pass explicit history file path:
```toml
[notify]
command = ["node", "/path/to/hooks/codex-notify.mjs", "--history", "/path/to/history.jsonl"]
```

**To disable**: Remove the `[notify]` section from `config.toml`

**Environment**: Hook receives `CODEX_PROJECT_DIR` env var pointing to project root

**How it works**:
1. Codex calls `codex-notify.mjs` with its notification payload
2. The notify hook parses Codex's payload format and forwards it to `auto-save.mjs`
3. Same extraction and saving process as Claude/Gemini

---

### Deduplication strategy

The hook prevents duplicate items using multiple strategies:

1. **Title hash tracking**: SHA-256 hash of each title stored in cursor file
2. **Jaccard similarity**: Compares word overlap between new and existing titles (threshold: 80%)
3. **Cross-session dedup**: Hashes persist across sessions to prevent re-capturing the same facts
4. **Cursor position**: Only processes new transcript lines since last run

### Cursor tracking

State tracked in `.ai/.auto-save-cursor.json`:
```json
{
  "sessionId": "current-session-id",
  "lastLineIndex": 42,
  "itemHashes": ["hash1", "hash2", "..."],
  "updatedAt": "2026-02-12T13:39:17.658Z"
}
```

- `sessionId` - Current session ID (resets cursor position on session change)
- `lastLineIndex` - Last processed transcript line (0-indexed)
- `itemHashes` - Recent title hashes (keeps last 200 for dedup)
- `updatedAt` - Last update timestamp

**Session change behavior**: When `sessionId` changes, `lastLineIndex` resets to -1 but `itemHashes` are preserved for cross-session deduplication.

### Minimum threshold

To reduce noise, the hook only processes transcripts with **at least 2 assistant messages** in the new lines since last cursor position.

Single-turn exchanges are skipped.

### Testing the hook

**Automated test** (all three CLIs):
```bash
npm run test:hooks
```

This creates a test transcript and verifies all three hooks work correctly.

**Manual test** (single hook):
```bash
echo '{"session_id":"test","transcript_path":"/tmp/test.jsonl","cwd":"'$(pwd)'"}' | node hooks/auto-save.mjs
```

**Verify saved items**:
```bash
# Check memory file
cat .ai/memory.json | jq '.items[] | select(.source == "auto-hook")'

# Check cursor
cat .ai/.auto-save-cursor.json
```

### Troubleshooting

| Issue | Solution |
|---|---|
| Hook not running | Check CLI settings file exists (`.claude/settings.json`, `.gemini/settings.json`) or Codex `config.toml` |
| No items saved | Check transcript has at least 2 assistant messages. Try running `node -v` and ending session. |
| Items not appearing | Verify `.ai/memory.json` exists and check for errors in hook stderr |
| Duplicates appearing | Check cursor file `.ai/.auto-save-cursor.json` is being updated |
| Codex hook not working | Ensure `history.persistence` is enabled and history file exists |

**Debug mode**: Run hook manually with test payload to see errors:
```bash
node hooks/auto-save.mjs < test-payload.json
```

</details>

---
