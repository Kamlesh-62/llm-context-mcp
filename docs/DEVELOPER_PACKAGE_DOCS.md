# Project Memory MCP Server - Developer Documentation

## Overview

`project-memory-mcp` is a local MCP stdio server that provides shared, project-scoped memory for coding agents (Claude Code, Gemini CLI, Codex CLI).

It stores memory in JSON at:

- `<projectRoot>/.ai/memory.json`

## Features

- Project-scoped memory by default (via working directory + `.git` detection)
- Optional explicit routing using `projectRoot`
- Direct write workflow (`memory_save`)
- Gated write workflow (`memory_propose` -> `memory_approve_proposal`)
- Search and context bundle retrieval (`memory_search`, `memory_get_bundle`)
- File lock + atomic write for safer concurrent access

## Installation

```bash
cd /Users/itsupport4/Documents/project-memory-mcp-js
npm install
```

Run locally:

```bash
npm run start
```

## Runtime Configuration

Environment variables (optional):

- `MEMORY_PROJECT_ROOT`: force project root
- `MEMORY_FILE_PATH`: override memory file path

Examples:

```bash
MEMORY_PROJECT_ROOT=/Users/itsupport4/Documents/opulence_api npm run start
MEMORY_FILE_PATH=.ai/custom-memory.json npm run start
```

## Memory Resolution Rules

`projectRoot` is resolved in this priority order:

1. Tool input `projectRoot` (if provided)
2. `MEMORY_PROJECT_ROOT` env var
3. Nearest ancestor with `.git`
4. Current working directory

Final storage path is:

- `MEMORY_FILE_PATH` if set (relative values resolved under project root)
- else `<projectRoot>/.ai/memory.json`

## Tool API Reference

### Read tools

- `memory_status`
  - Purpose: show resolved `projectRoot`, `memoryFilePath`, counts, revision
- `memory_search`
  - Purpose: keyword/tag search over saved items
  - Key inputs: `query`, `limit`, `types`, `tags`, `includeContent`, `projectRoot`
- `memory_get_bundle`
  - Purpose: compact ranked memory bundle for current task
  - Key inputs: `prompt`, `maxItems`, `maxChars`, `types`, `includePinned`, `projectRoot`
- `memory_list_proposals`
  - Purpose: list proposals by status
  - Key inputs: `limit`, `status`, `includeContent`, `projectRoot`

### Write tools

- `memory_save`
  - Purpose: direct save without approval
  - Key inputs: `title`, `content`, `type`, `tags`, `pinned`, `source`, `projectRoot`
- `memory_propose`
  - Purpose: add pending proposal(s)
  - Key inputs: `items[]`, `reason`, `projectRoot`
- `memory_approve_proposal`
  - Purpose: approve/reject proposal, optional edits before decision
  - Key inputs: `proposalId`, `action`, `edits`, `projectRoot`
- `memory_pin`
  - Purpose: pin or unpin an existing item
  - Key inputs: `itemId`, `pinned`, `projectRoot`

## Data Model

`memory.json` structure:

- `version`: format version (currently `1`)
- `project`: metadata (`id`, `root`, timestamps)
- `items`: approved/saved memory entries
- `proposals`: gated workflow entries (`pending|approved|rejected`)
- `revision`: incremented on writes

## Common Workflows

### 1) Verify routing

Call `memory_status` and confirm:

- `projectRoot` is your target repo
- `memoryFilePath` is `<target>/.ai/memory.json`

### 2) Save context directly

Example prompt for any connected CLI:

```text
Call MCP tool `memory_save` with:
- title: "Project runtime versions"
- type: "fact"
- content: "PHP version is 7.4.33 and Laravel version is 5.6.40."
- tags: ["php","laravel","environment","version"]
- source: "claude"
Then call `memory_search` with query "php laravel version" and includeContent=true.
Return both tool outputs.
```

### 3) Read context before task

Call `memory_get_bundle` with current task prompt.

## Update and Delete Strategy

Current behavior:

- No direct `memory_update` tool
- No direct `memory_delete` tool

Recommended update approach:

1. Write corrected context as new `memory_save` item.
2. Add tags like `supersedes:<old_id>`.
3. Optionally pin latest canonical item.

Delete options:

- Delete all project memory:

```bash
rm -f <projectRoot>/.ai/memory.json
```

- Delete specific records manually from `items`/`proposals` arrays.

## Testing Checklist

1. Configure CLI MCP server for target project.
2. Restart CLI session.
3. `memory_status` returns expected path.
4. `memory_save` returns success item ID.
5. `memory_search` finds saved item.
6. JSON file exists and contains expected item.
7. Verify cross-client read from another CLI (Claude/Gemini/Codex).

## Troubleshooting

`memory.json` not updating:

- Write tool was not called (`memory_save` or proposal approval).
- `memory_status` points to wrong project root.

Server not available in CLI:

- Check CLI MCP server registration.
- Confirm `node` is installed (`node -v`).
- Confirm server file exists at configured path.

Unexpected storage location:

- Inspect `memory_status` output.
- Fix `cwd` in CLI config, or pass explicit `projectRoot` input.

## Architecture Map

- `server.js`: process entrypoint
- `src/main.js`: MCP bootstrap and transport connection
- `src/tools.js`: tool registration and handlers
- `src/storage.js`: lock, load/write, atomic persistence
- `src/runtime.js`: project root/path resolution + timestamps
- `src/domain.js`: scoring/tokenization/validation helpers
- `src/config.js`: constants
- `src/logger.js`: stderr logger
