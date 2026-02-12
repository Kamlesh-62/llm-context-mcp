# Project Memory MCP Server – Local Setup

This guide walks through installing the server, wiring it into each CLI, and confirming `memory_get_bundle` / `memory_save` work end-to-end on your machine.

## 1. Requirements

- Node.js 18+ on PATH (`node -v`)
- This repo cloned locally (example path: `/Users/itsupport4/Documents/project-memory-mcp-js`)
- Target project(s) checked out locally (each one gets its own `.ai/memory.json`)

## 2. Install dependencies

```bash
cd /Users/itsupport4/Documents/project-memory-mcp-js
npm install
```

You normally do **not** run `npm start` manually; each CLI spawns `node server.js` when it needs the tools.

## 3. Optional environment overrides

The server auto-detects project root, but you can override behavior with env vars:

| Variable | Purpose |
|---|---|
| `MEMORY_PROJECT_ROOT` | Force the project root path (overrides `.git` detection + cwd) |
| `MEMORY_FILE_PATH` | Override memory JSON path (relative paths resolve under project root) |

Example manual start (for debugging):

```bash
MEMORY_PROJECT_ROOT=/Users/.../repo \
MEMORY_FILE_PATH=.ai/custom-memory.json \
node server.js
```

## 4. Guided setup command (recommended)

Skip the manual wiring by running the built-in wizard inside the project you want to enable (or pass `--project /path/to/project`):

```bash
npx project-memory-mcp setup
# or, after a global install
project-memory-mcp setup
```

What it does:

- Prompts for the project directory (defaults to your current working directory).
- Lets you pick how the server should be launched (`npx project-memory-mcp`, global binary, `node /absolute/path/server.js`, or a fully custom command/args).
- Lets you choose which CLIs to configure (Claude Code, Gemini CLI, Codex CLI).
- Updates `~/.claude.json` (with a `.bak` backup), then runs `gemini mcp` / `codex mcp` commands so they point to the right repo. Each CLI must already be installed and available on your `PATH`.
- Supports automation via flags such as `--project`, `--cli claude,gemini`, `--runner global`, `--command`, `--args`, and `--yes` to skip prompts. Run `project-memory-mcp setup --help` for the full list.

You can re-run the wizard anytime; it safely overwrites the `project-memory` entries with your latest choices.

## 5. Manual quick setup for a new project

Follow these minimal steps whenever you want to enable shared memory in another repo (e.g. `/path/to/my-app`):

1. **Update the server repo once**  
   ```bash
   cd /Users/itsupport4/Documents/project-memory-mcp-js
   git pull && npm install
   ```

2. **From the target project folder (`/path/to/my-app`) configure MCP per CLI**  
   - *Claude Code*: edit `~/.claude.json` → under that project’s block add  
     ```json
     "mcpServers": {
       "project-memory": {
         "command": "node",
         "args": ["/Users/itsupport4/Documents/project-memory-mcp-js/server.js"],
         "cwd": "/path/to/my-app"
       }
     }
     ```
     Restart Claude from `/path/to/my-app`.
   - *Gemini CLI*:  
     ```bash
     cd /path/to/my-app
     gemini mcp add project-memory node /Users/itsupport4/Documents/project-memory-mcp-js/server.js --trust
     gemini mcp list
     ```
   - *Codex CLI*:  
     ```bash
     cd /path/to/my-app
     codex mcp add project-memory node /Users/itsupport4/Documents/project-memory-mcp-js/server.js
     codex mcp list
     ```

3. **Verify routing**  
   Inside the target repo, start your CLI and say “Call `memory_status` and show the output.” You should see `projectRoot` set to `/path/to/my-app` and `memoryFilePath` pointing to `/path/to/my-app/.ai/memory.json`. Fix any `cwd`/env misconfigurations before continuing.
   - Need a refresher on prompts? Run `memory_help` from the same session to see the quick command list.

Once these steps pass, all subsequent sessions in that repo automatically use the latest MCP server code.

## 6. Configure each CLI (details)

Run these commands from the project whose memory you want to persist (e.g. `/Users/.../opulence_api`).

### Claude Code

Edit `~/.claude.json` and add/merge this under the matching project block:

```json
"mcpServers": {
  "project-memory": {
    "command": "node",
    "args": ["/Users/itsupport4/Documents/project-memory-mcp-js/server.js"],
    "cwd": "/Users/.../opulence_api"
  }
}
```

Restart Claude CLI from that project folder so it resolves the correct working directory. Optional auto-save hook: keep `.claude/settings.json` from this repo inside your project.

### Gemini CLI

Follows the [Gemini MCP workflow](https://geminicli.com/docs/tools/mcp-server/):

```bash
cd /Users/.../opulence_api
gemini mcp add project-memory node /Users/itsupport4/Documents/project-memory-mcp-js/server.js --trust
gemini mcp list    # should show project-memory CONNECTED
/mcp               # in-session command to inspect tools/resources
```

- Default scope is `project`, so `.gemini/settings.json` gains the entry under `mcpServers`.
- Use `--trust` (or later `gemini mcp trust project-memory`) to skip confirmation prompts.
- If Gemini runs from a different directory, edit `.gemini/settings.json` and add `"cwd": "/Users/.../opulence_api"` or env overrides like `"MEMORY_PROJECT_ROOT": "$GEMINI_PROJECT_DIR"`.
- Disable/enable without deleting: `gemini mcp disable project-memory`; remove with `gemini mcp remove project-memory`.

### Codex CLI

Codex MCP entries are global, so add the server once:

```bash
codex mcp add project-memory node /Users/itsupport4/Documents/project-memory-mcp-js/server.js
codex mcp list
codex mcp get project-memory
```

Always start Codex from the target repo (`cd /Users/.../opulence_api && codex`) so the server sees that folder as the project root. Optional notify hook: add to `~/.codex/config.toml`.

## 7. Verify routing & run a smoke test

1. Start a fresh CLI session in the target repo.
2. Run `memory_status`. Expected output:
   - `projectRoot` → `/path/to/your-project`
   - `memoryFilePath` → `/path/to/your-project/.ai/memory.json`
3. Call `memory_save` with test content, then `memory_search` to confirm it appears.
4. Check `.ai/memory.json` for the saved entry.
5. Switch to another CLI (e.g., Gemini after Claude) and run `memory_get_bundle` to ensure cross-client sharing works.

## 8. Troubleshooting checklist

| Symptom | Fix |
|---|---|
| Server shows `DISCONNECTED` in `/mcp` | Verify `node` path, server file path, and restart CLI |
| Tools missing in Gemini | Re-run `gemini mcp add … --trust`; confirm entry in `.gemini/settings.json`; ensure `cwd` points at project |
| `memory_status` shows wrong project | Adjust CLI config `cwd` or export `MEMORY_PROJECT_ROOT` |
| Writes not saving | Make sure you called `memory_save` or approved proposals; check `.ai` folder permissions |
| Lock errors | Check for stale `.ai/memory.json.lock` file and remove after ensuring no other process is running |

## 9. Optional auto-save hooks

Leave the provided hook configs inside your project to capture info automatically when sessions end:

- `.claude/settings.json` – runs `hooks/auto-save.mjs` after Claude sessions.
- `.gemini/settings.json` – registers a `SessionEnd` hook for Gemini.
- `hooks/codex-notify.mjs` – wire via `~/.codex/config.toml` to capture Codex history events.

Run `npm run test:hooks` inside this repo to simulate all hook flows end-to-end.

### Auto-memory (bundle + save) hook

For a fully hands-off flow, use the new `hooks/auto-memory.mjs` script:

| CLI Event | Command | What it does |
|---|---|---|
| `UserPromptSubmit` (first user message) | `node "$CLAUDE_PROJECT_DIR/hooks/auto-memory.mjs" start` | Compacts if needed, then injects a fresh `memory_get_bundle` result into the conversation. |
| `Stop` (session end) | `node "$CLAUDE_PROJECT_DIR/hooks/auto-memory.mjs" stop` | Mirrors `auto-save.mjs`: parses transcript, auto-saves important facts/decisions. |

Use the same command for Gemini (`"$GEMINI_PROJECT_DIR"` in the path) or Codex (`"$CODEX_PROJECT_DIR"`). The script auto-detects which CLI invoked it and prints `{}` for Gemini when no output is needed.

## 10. Managing store size

- The server auto-compacts once more than 400 active items exist (see `src/config.js > CONFIG.autoCompact`). Oldest entries move into `.ai/memory-archive.json`, and a summary item (tagged `archive`) stays in the main store.
- Trigger the same logic manually via the `memory_compact` tool, e.g. `Call memory_compact with {"maxItems":250}` to keep only the latest 250 active records.
- Archived entries remain available in the archive file for audits; `memory_get_bundle` continues to use the lean active list so responses stay fast.
