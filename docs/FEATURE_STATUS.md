# Feature Status & Roadmap

> Living document tracking completed work, planned features, and design specs for `project-memory-mcp`.

---

## 1. Completed

- **Dynamic server IDs** – setup prompts (or accepts `--server-id`) and validates `[a-z0-9-]{3,32}`, so multiple installs can coexist without clobbering a single `project-memory` entry.
- **Per-project defaults cache** – `.ai/memory-mcp.json` remembers the last `{serverId, runner}` so rerunning the wizard in CI or local shells uses sane defaults automatically.
- **Runner recall** – saved runner definitions (including custom commands/args) are restored on the next setup run, cutting down on re-entry when switching between `npx`, global, and local builds.
- **Runner profiles** – `--runner-profile` alias on `setup` accepts the same values as `--runner` (`npx`, `global`, `node`, `custom`), making the flag name more discoverable.
- **`switch` command** – `project-memory-mcp switch [--project <path>] [--cli <list>]` reapplies the saved `.ai/memory-mcp.json` config to selected CLIs in one step, no interactive prompts required.
- **Duplicate server ID detection** – interactive `setup` checks whether the chosen server ID already exists in `~/.claude.json` and prompts the user to either update the existing entry or pick a different ID.
- **Claude config override** – `PROJECT_MEMORY_MCP_CLAUDE_CONFIG_PATH` / `CLAUDE_CONFIG_PATH` lets us wire Claude inside sandboxes or CI without writing to `~/.claude.json`.
- **Version flag** – `project-memory-mcp --version` prints the package version for quick build verification.
- **`memory_update` & `memory_delete`** – modify or permanently remove memory items by ID through MCP tools, eliminating the need for manual JSON editing.
- **Suggestion Engine** – live, mid-session pattern detection via `memory_observe` → scoring → `memory_suggest` → `memory_suggestion_feedback`. 5 rule types (version-check, dependency-change, deploy-release, error-fix, config-change), scoring with recency boost and feedback multipliers, persistent feedback in `.ai/suggestion-feedback.json`.
- **MCP Prompts** – 11 slash-command prompts registered via `server.prompt()` for all tools including suggestion engine.
- **Pluggable storage backends** – `withStore()` sits behind a `StorageBackend` seam (`src/storage/`). JSON stays the zero-config default; SQLite is opt-in via `.ai/memory-mcp.json` `storage.backend` (driver: built-in `node:sqlite` ≥22.5, else optional `better-sqlite3`). See [ARCHITECTURE.md](./ARCHITECTURE.md) and [STORAGE_BACKENDS.md](./STORAGE_BACKENDS.md).
- **Store-format version safety** – `migrateRawStore()` distinguishes a missing store (fresh start) from a corrupt/too-new one (throws instead of silently overwriting), with a version-dispatch registry for future format changes.
- **`migrate` command** – `project-memory-mcp migrate --to <json|sqlite> [--from] [--dry-run] [--force] [--set-default]` copies memory between backends, verifies counts, and leaves the source intact (reversible).

---

## 2. Planned — Setup & CLI

| Category | Feature | Description |
|---|---|---|
| Diagnostics | `doctor` | Health checks across CLIs, validates `cwd` + version alignment, emits actionable fixes when `memory_status` fails. |
| Security | Signed runner allowlist | Verifies the resolved server command against a project-defined hash/signature before wiring CLIs. |

---

## 3. Planned — Memory Tools

Five features ranked by impact.

### 3.1 Memory Decay & Staleness Detection

**Priority**: High

`lastUsedAt` already exists on items but isn't leveraged. A `memory_stale` tool (or `stale_days` flag on `memory_search`) would surface items not accessed in N days so agents can self-clean.

**Scope**:
- Track `lastUsedAt` on every read/bundle access
- New tool or search parameter: `stale_days`
- Agent prompt: *"These items haven't been used in 60 days — archive or update?"*

### 3.2 Contradiction Detection on Save

**Priority**: High — most differentiating feature

When `memory_save` writes "Node version: 20.11.0", it should detect an existing "Node version: 18.17.1" and either auto-supersede or return both items for the agent to resolve.

**Scope**:
- On save, compare new item against existing items with overlapping title/tags
- Use token overlap or heuristics to detect conflicts
- Return conflicts in the tool response so the agent decides

### 3.3 Archive Search & Restore

**Priority**: Medium

Compacted items in `.ai/memory-archive.json` are invisible to all tools. Agents should recover historical context when needed.

**Scope**:
- `memory_search_archive` — keyword/tag search over archived items
- `memory_restore` — move an archived item back to the active store
- Reuse existing scoring logic from `domain.js`

### 3.4 Item TTL / Expiry

**Priority**: Medium

Some memory is inherently temporary (sprint goals, blocking issues, "currently investigating X"). An optional `expiresAt` field auto-archives stale items.

**Scope**:
- Optional `expiresAt` (ISO timestamp) on items
- Bundle generator and search skip expired items
- Expired items archived on next compaction or eagerly on read

### 3.5 Named Contexts / Workspaces

**Priority**: Lower — nice-to-have for large projects

Named contexts like `auth-refactor` or `v2-migration` let agents get scoped bundles without losing access to the full store.

**Scope**:
- `memory_set_context("auth-refactor")` — biases `memory_get_bundle`
- Items belong to contexts via tags or a dedicated field
- Context is a soft filter, not a hard partition

---

## 4. Memory Suggestion Engine (Implemented)

Mid-session proactive memory suggestions via MCP notifications and a pull-based API.

### How it works

Agents push observations via `memory_observe`. The engine matches against 5 rule categories, scores suggestions using `base_weight × recency_boost × feedback_multiplier`, and surfaces those above threshold. Agents review via `memory_suggest` and accept/reject via `memory_suggestion_feedback`. The server also pushes `notifications/message` to MCP clients that support it.

### 4.1 Rule-Based Triggers

Watch for patterns across a sliding window of the last 2–3 tool interactions:

| Pattern | Example | Auto-tag |
|---|---|---|
| Version check | `node -v`, `python --version` | `version` |
| Dependency change | `npm install`, `pip install`, `cargo add` | `dependency` |
| Deploy / release | `docker push`, `npm publish`, `git tag` | `release` |
| Error → fix cycle | tool output with "error" followed by resolution | `error-resolution` |
| Config change | `.env` edits, config file writes | `configuration` |

Each rule carries a base weight. The server maintains a short queue and only surfaces suggestions whose cumulative score crosses a threshold (e.g., score >= 3).

### 4.2 Scoring & Threshold

```
suggestion_score = base_weight × recency_boost × feedback_multiplier
```

- **base_weight** — set per rule (e.g., version: 2, dependency: 3, error-fix: 4)
- **recency_boost** — higher if the pattern appeared in the last 1–2 exchanges
- **feedback_multiplier** — adjusted by accept/reject history (starts at 1.0)
- **threshold** — only notify the client when `suggestion_score >= 3`

High-confidence suggestions (score >= 5) can auto-save; lower scores produce a nudge for the developer to confirm.

### 4.3 Developer Feedback Loop

When the user accepts or rejects a suggestion:

1. Record the decision in `.ai/suggestion-feedback.json`
2. Update the `feedback_multiplier` for that rule category
   - Accepted → multiplier increases (cap at 2.0)
   - Rejected → multiplier decreases (floor at 0.3)
3. Over time, the engine learns which patterns the developer actually cares about

### 4.4 Notification Payload Schema

```jsonc
{
  "method": "notifications/message",
  "params": {
    "level": "info",
    "data": {
      "type": "memory_suggestion",
      "title": "Node.js version updated to 22.1.0",
      "content": "Detected version change from node -v output",
      "tags": ["version", "node"],
      "confidence": 0.85,       // 0–1 scale
      "priority": 3,            // 1–5
      "autoSave": false,        // true if confidence > threshold
      "source": "suggestion-engine",
      "triggeredBy": "version-check-rule"
    }
  }
}
```

Downstream `memory_save` calls copy `tags` and `priority` so bundles can rank items by the same themes.

### 4.5 Implementation Status

| Component | Status |
|---|---|
| `hooks/extractors.mjs` — version, dep, commit, error extractors | Exists (runs at session end) |
| `hooks/auto-save.mjs` — transcript scanner | Exists (session-end hook) |
| `hooks/cursor.mjs` — sliding window cursor | Exists |
| Mid-session notification delivery | Implemented (`memory_observe` → `sendLoggingMessage`) |
| Scoring + threshold gating | Implemented (base × recency × feedback, threshold 3/5) |
| Feedback loop + weight tuning | Implemented (`.ai/suggestion-feedback.json`) |
| Suggestion payload with confidence/priority | Implemented |
| MCP Prompts (slash commands) | Implemented (11 prompts) |

The extractors provided the regex foundation. The suggestion engine (`src/suggestions.ts`) promotes them to a live pipeline with scoring, feedback, and MCP notifications. Three new tools (`memory_observe`, `memory_suggest`, `memory_suggestion_feedback`) and 11 MCP prompts complete the developer-facing API.

---

## 5. VS Code Extension — `project-memory-vscode`

A companion VS Code extension that acts as a visual client for the MCP server, giving developers a GUI layer on top of the CLI-first workflow.

### Why

CLI agents (Claude Code, Codex, Gemini) interact with memory through tool calls — invisible to the developer unless they inspect `.ai/memory.json`. The extension makes memory **visible and actionable** inside the editor where developers already work.

### Architecture

```
┌─────────────────────────────────────────────┐
│  VS Code Extension (Node.js)                │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ MCP      │  │ Sidebar  │  │ Status    │ │
│  │ Client   │  │ TreeView │  │ Bar       │ │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘ │
│       │              │              │       │
└───────┼──────────────┼──────────────┼───────┘
        │              │              │
        ▼              ▼              ▼
   MCP Server     .ai/memory.json   Badge count
   (stdio)        (read/display)    (suggestions)
```

The extension spawns the MCP server as a child process (same stdio transport Claude Code uses) and communicates via `@modelcontextprotocol/sdk` client.

### Features

| Feature | Description |
|---|---|
| **Suggestion toasts** | Receives `notifications/message` from the suggestion engine (§4), shows VS Code notification with Accept / Reject / Edit buttons |
| **Feedback capture** | Accept/reject actions write to `.ai/suggestion-feedback.json`, closing the feedback loop from §4.3 |
| **Memory sidebar** | TreeView panel listing all active items — search, filter by tag/type, pin/unpin, delete |
| **Item quick-edit** | Click an item to open an editor panel for inline title/content/tag editing via `memory_update` |
| **Bundle preview** | Command palette action: "Preview Memory Bundle" — shows what `memory_get_bundle` would return for a given prompt |
| **Status bar** | Badge showing pending suggestion count, click to expand suggestion list |
| **Auto-detect project** | Uses `workspaceFolders` to resolve the project root, same as `findProjectRoot()` in the server |

### Suggestion Flow (end-to-end)

```
1. Developer works in VS Code, AI agent runs in terminal
2. MCP server detects pattern (e.g., npm install lodash)
3. Server sends notification → extension receives it
4. Toast appears: "💡 Save to memory? New dependency: lodash"
5. Developer clicks Accept → extension calls memory_save via MCP
6. Decision logged to .ai/suggestion-feedback.json
7. Scoring weights updated for next suggestion
```

### Tech Stack

| Layer | Choice |
|---|---|
| Extension runtime | VS Code Extension API (Node.js) |
| MCP communication | `@modelcontextprotocol/sdk` client over stdio |
| UI components | VS Code TreeView, WebviewPanel (for item editor), StatusBarItem |
| Package | Standalone repo (`project-memory-vscode`), published to VS Code Marketplace |
| Dependency | `project-memory-mcp` as peer — extension spawns the server binary |

### Milestones

| Phase | Deliverable |
|---|---|
| **v0.1** | MCP client connection + suggestion toast notifications + accept/reject feedback |
| **v0.2** | Memory sidebar (TreeView) with search, filter, pin/unpin |
| **v0.3** | Item quick-edit panel + bundle preview command |
| **v0.4** | Status bar badge, polish, Marketplace publish |
