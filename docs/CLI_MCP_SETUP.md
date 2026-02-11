# Developer Guide: MCP Memory for Claude, Gemini, and Codex

This guide explains how to configure all three CLIs to use this server and share memory per project.

Server code:

- `/Users/itsupport4/Documents/project-memory-mcp-js/server.js`

Memory file written by this server:

- `<target-project>/.ai/memory.json`

## 1. How it works

1. Your CLI (Claude/Gemini/Codex) starts this MCP server over stdio.
2. The CLI calls memory tools (`memory_get_bundle`, `memory_save`, etc.).
3. The server resolves target project root and writes to `<project>/.ai/memory.json`.

Important:

- Chat text is not auto-saved.
- Only explicit memory write tools save data (`memory_save`, approved proposals) unless you enable the auto-save hook.

## 2. Prerequisites

1. Node.js installed and available in PATH.
2. This repo exists at `/Users/itsupport4/Documents/project-memory-mcp-js`.
3. Dependencies installed:

```bash
cd /Users/itsupport4/Documents/project-memory-mcp-js
npm install
```

## 3. Claude Code setup (project-specific)

Claude uses `~/.claude.json`.

Edit this project block:

- `projects["/Users/itsupport4/Documents/opulence_api"].mcpServers`

Use:

```json
"mcpServers": {
  "project-memory": {
    "command": "node",
    "args": ["/Users/itsupport4/Documents/project-memory-mcp-js/server.js"],
    "cwd": "/Users/itsupport4/Documents/opulence_api"
  }
}
```

Then restart Claude CLI from the same project folder.

Optional: enable auto-save hook by keeping `.claude/settings.json` in this repo.

## 4. Gemini CLI setup (project scope)

Run from target project folder:

```bash
cd /Users/itsupport4/Documents/opulence_api
gemini mcp add project-memory node /Users/itsupport4/Documents/project-memory-mcp-js/server.js
gemini mcp list
```

Remove server:

```bash
gemini mcp remove project-memory
```

Notes:

- Gemini `mcp add` default scope is `project`.
- Run this per repository where you want memory.

Optional: enable auto-save hook by keeping `.gemini/settings.json` in this repo.

## 5. Codex CLI setup

Codex MCP entries are global, managed by `codex mcp`.

Add server:

```bash
codex mcp add project-memory node /Users/itsupport4/Documents/project-memory-mcp-js/server.js
codex mcp list
codex mcp get project-memory
```

Remove server:

```bash
codex mcp disable node
codex mcp remove project-memor
```

Important for project-local memory:

- Start Codex in the target repo (`cd /Users/itsupport4/Documents/opulence_api` then run `codex`).
- The server resolves memory using that working directory.

Optional: enable auto-save hook (Codex notify).

Add to `~/.codex/config.toml`:

```toml
notify = ["node", "/Users/itsupport4/Documents/project-memory-mcp-js/hooks/codex-notify.mjs"]
history.persistence = "save-all"
```

## 6. Verify routing (must do once per CLI)

Call tool:

- `memory_status`

Expected for this project:

- `projectRoot`: `/Users/itsupport4/Documents/opulence_api`
- `memoryFilePath`: `/Users/itsupport4/Documents/opulence_api/.ai/memory.json`

If `projectRoot` is wrong, fix CLI setup before continuing.

## 7. Store context (step by step)

Use this prompt in Claude/Gemini/Codex:

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

Expected:

- Tool returns `Saved memory item ...`
- `memory_search` returns same item
- File contains entry:

```bash
cat /Users/itsupport4/Documents/opulence_api/.ai/memory.json
```

## 8. Read context (before coding)

Use:

- `memory_get_bundle` with your current task prompt

Example prompt:

```text
Call `memory_get_bundle` with prompt "I am fixing login API bugs" and maxItems 12.
Return only the bundle text.
```

## 9. Update existing context

There is no direct edit tool yet. Use one of these patterns:

1. Add a corrected item with `memory_save`.
2. Add tags like `supersedes:<old_item_id>` in the new item.
3. Optionally `memory_pin` the newest canonical item.

Alternative controlled flow:

- `memory_propose` -> `memory_approve_proposal` with `edits`

## 10. Delete context

No `memory_delete` tool exists yet.

Delete all project memory:

```bash
rm -f /Users/itsupport4/Documents/opulence_api/.ai/memory.json
```

Delete specific item manually:

1. Open `/Users/itsupport4/Documents/opulence_api/.ai/memory.json`.
2. Remove matching object from `items` array.
3. Save file.

## 11. Full test checklist

1. Configure CLI MCP server.
2. Restart CLI.
3. Run `memory_status` and verify project path.
4. Run `memory_save` with test value.
5. Run `memory_search` and confirm result.
6. Confirm file exists and contains item.
7. Open another CLI (Gemini/Codex/Claude), run `memory_search`, confirm same item is visible.

## 12. Troubleshooting

`memory.json` not created:

- `memory_status` is pointing to wrong project root.
- Fix `cwd` (Claude) or run CLI from correct folder (Gemini/Codex).

Server not available in CLI:

- Check CLI MCP config/list command output.
- Confirm file path `/Users/itsupport4/Documents/project-memory-mcp-js/server.js` exists.
- Confirm `node` works: `node -v`.

Data not saved:

- You did not call a write tool.
- `Shell`/chat/todos do not persist memory by themselves.
