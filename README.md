# Project Memory MCP Server

Shared, project-scoped memory for **Claude Code**, **Codex**, and **Gemini CLI** — so all three agents remember the same context.

```
You (any CLI) ──► MCP Server ──► .ai/memory.json (per project)
```

This repository ships a Node.js MCP server that persists project facts/decisions into `<project>/.ai/memory.json`. Any supported CLI can read/write the same file, so switching between Claude, Codex, and Gemini feels stateful: load context with `memory_get_bundle`, perform work, and save what changed with `memory_save`.

## Why Project Memory MCP?

- **Shared context** – one `.ai/memory.json` per repo keeps Claude, Codex, and Gemini in sync.
- **Batteries included tools** – search, bundle generation, pinning, proposals, auto-compaction.
- **Silent capture** – optional hooks auto-save versions, deps, and commits at the end of a session.
- **CLI + programmatic** – run the stdio server via `project-memory-mcp` or import the build artifacts in Node projects.

## Installation Options

Pick the workflow that fits your team:

### 1. Global CLI (recommended for everyday use)

```bash
npm install -g project-memory-mcp
project-memory-mcp setup
```

This installs the CLI once, adds a globally available `project-memory-mcp` command, and stores the server inside your global npm cache.

### 2. On-demand via npx (no global install)

```bash
npx project-memory-mcp setup
```

npx downloads the package on first run and reuses the cached copy afterwards. Great for trying the tool or wiring up a single machine.

### 3. Local clone (development / hacking)

```bash
git clone https://github.com/nicobailon/project-memory-mcp-js.git
cd project-memory-mcp-js
npm install
npm run build
```

Then point your CLI at `node /absolute/path/dist/server.js`. This is also how you contribute and run the hook tests. See [Local development](#local-development) for details.

## Quick Start (any install path)

1. **Run the setup wizard** inside the repo you want to enable (or pass `--project /path`):
   ```bash
   project-memory-mcp setup        # global install
   # or
   npx project-memory-mcp setup    # on-demand
   ```
2. Choose how the CLI should spawn the server (`npx`, global binary, `node dist/server.js`, or a custom command).
3. Pick which CLIs to configure (Claude Code, Gemini CLI, Codex CLI).
4. Ask your CLI: “Call `memory_status` and show the output.” You should see the correct `projectRoot` and `.ai/memory.json`.

Prefer the manual route or need automation flags? Jump to [Local development](#local-development) and `docs/LOCAL_SETUP.md`.

## Run it as a project dependency

If you want every teammate to install the server via your project’s `package.json`, add it as a dev dependency:

```bash
npm install --save-dev project-memory-mcp
```

Now you can expose scripts:

```jsonc
{
  "scripts": {
    "memory:serve": "project-memory-mcp serve",
    "memory:setup": "project-memory-mcp setup --yes --runner node"
  }
}
```

From there your CLI entries can point at `npx project-memory-mcp` or `node ./node_modules/project-memory-mcp/dist/server.js`. The published package bundles the `dist/` tree, so no build step is needed on consumer machines.

## Local development

Working out of this repo?

1. `npm install`
2. `npm run build`
3. `npm run test:hooks` (optional smoke test for hook flows)
4. Wire your CLIs using `node dist/server.js` or `project-memory-mcp` (after linking via `npm link`)

See [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md) for the long-form guide, env overrides, troubleshooting, and hook wiring defaults.  
Need to ship a new npm release from your workstation? Follow [`docs/LOCAL_NPM_DEPLOY.md`](docs/LOCAL_NPM_DEPLOY.md).

## CLI Setup & Tool Map

Already installed globally, via npx, or from source? Run the wizard from the repo you want to enable:

```bash
# Install globally (recommended)
npm install -g project-memory-mcp

# Or use npx (no install needed)
npx project-memory-mcp

# Or clone and run locally
git clone https://github.com/nicobailon/project-memory-mcp-js.git
cd project-memory-mcp-js && npm install && npm run build && npm start
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

1. **Install the package** (pick one)
   ```bash
   npm install -g project-memory-mcp   # global install
   # or use npx — no install needed
   ```

2. **Run the guided setup (recommended)**
   ```bash
   # from the repo you want to wire up (or pass --project)
   npx project-memory-mcp setup
   # or, after a global install:
   project-memory-mcp setup
   ```
   - Prompts for the project directory (defaults to your current working folder).
   - Lets you choose how to launch the MCP server (`npx`, global binary, `node /path/to/dist/server.js`, or a custom command).
   - Lets you pick which CLIs to configure (Claude Code, Gemini CLI, Codex CLI).
   - Automatically updates `~/.claude.json` (with a `.bak` backup) and runs the necessary `gemini mcp` / `codex mcp` commands so they point at the right project.
   - Flags: `--project /path`, `--cli claude,gemini`, `--runner global`, `--yes`, `--command`, and `--args` let you script it or skip prompts. Run `project-memory-mcp setup --help` for the full list.
   - Requires the corresponding CLIs to already be installed and on your `PATH`.

   > Claude setup in sandboxes: set `PROJECT_MEMORY_MCP_CLAUDE_CONFIG_PATH=/custom/path/claude.json` (or `CLAUDE_CONFIG_PATH`) before running the wizard if `~/.claude.json` isn’t writeable. The wizard reads/writes that custom file and still produces a `.bak` alongside it.

   <details>
   <summary>Prefer the fully manual wiring? Expand for the original commands.</summary>

   - **Claude Code** – edit `~/.claude.json` and add:
     ```json
     "mcpServers": {
       "project-memory": {
         "command": "npx",
         "args": ["project-memory-mcp"],
         "cwd": "/path/to/my-app"
       }
     }
     ```
     Restart Claude inside `/path/to/my-app`.
   - **Gemini CLI**
     ```bash
     cd /path/to/my-app
     gemini mcp add project-memory npx project-memory-mcp --trust
     gemini mcp list          # should show CONNECTED
     /mcp                     # (in-session) inspect tools/resources
     ```
     Edit `.gemini/settings.json` if you need custom `cwd` or env vars.
   - **Codex CLI**
     ```bash
     cd /path/to/my-app
     codex mcp add project-memory npx project-memory-mcp
     codex mcp list
     ```
     Always start `codex` from `/path/to/my-app` so the server detects the right root.
   </details>

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
- Want zero-click context? Configure the optional `dist/hooks/auto-memory.js` script (`... start` on `UserPromptSubmit`, `... stop` on `Stop`) to auto-inject bundles and auto-save transcripts.

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
| `PROJECT_MEMORY_MCP_CLAUDE_CONFIG_PATH` | Override where the setup wizard reads/writes Claude’s config (defaults to `~/.claude.json`) |
| `CLAUDE_CONFIG_PATH` | Same as above, kept for compatibility; only used if the project-specific variable is unset |

```bash
MEMORY_PROJECT_ROOT=/path/to/project npm run start
# Point setup at a sandbox-friendly Claude config file
PROJECT_MEMORY_MCP_CLAUDE_CONFIG_PATH=.tmp/claude-test.json \
  npx project-memory-mcp setup --claude
```

</details>

<details>
<summary><strong>File Layout</strong></summary>

```text
server.ts              # entrypoint (source)
dist/server.js         # entrypoint (runtime)
src/main.ts            # MCP bootstrap and transport connection
src/tools.ts           # tool registration and handlers
src/storage.ts         # lock, load/write, atomic persistence
src/runtime.ts         # project root/path resolution
src/domain.ts          # scoring/tokenization/validation helpers
src/config.ts          # constants
src/logger.ts          # stderr logger
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
   - `dist/hooks/auto-save.js` reads the session transcript (JSONL or JSON format)
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
        "command": "node \"$CLAUDE_PROJECT_DIR/dist/hooks/auto-save.js\"",
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
        "command": "node \"$GEMINI_PROJECT_DIR/dist/hooks/auto-save.js\""
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
command = ["node", "/absolute/path/to/project-memory-mcp-js/dist/hooks/codex-notify.js"]
```

Replace `/absolute/path/to/project-memory-mcp-js` with your actual installation path.

**Optional**: Pass explicit history file path:
```toml
[notify]
command = ["node", "/path/to/dist/hooks/codex-notify.js", "--history", "/path/to/history.jsonl"]
```

**To disable**: Remove the `[notify]` section from `config.toml`

**Environment**: Hook receives `CODEX_PROJECT_DIR` env var pointing to project root

**How it works**:
1. Codex calls `codex-notify.js` with its notification payload
2. The notify hook parses Codex's payload format and forwards it to `auto-save.js`
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
echo '{"session_id":"test","transcript_path":"/tmp/test.jsonl","cwd":"'$(pwd)'"}' | node dist/hooks/auto-save.js
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
node dist/hooks/auto-save.js < test-payload.json
```

</details>

---
