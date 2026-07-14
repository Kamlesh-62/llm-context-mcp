# Architecture

A short map of how project-memory-mcp is put together. For backend specifics and
migration, see [STORAGE_BACKENDS.md](./STORAGE_BACKENDS.md).

## Overview

An MCP stdio server that gives Claude Code, Codex, and Gemini a shared,
project-scoped memory. All reads and writes for a project funnel through a single
entry point and land in one local store under `.ai/`.

## The storage seam

`withStore()` in `src/storage.ts` is the one choke point every tool and hook uses:

```
withStore(writeFn, { projectRoot }) ->
  resolveStoreLocation(projectRoot)   // which backend + path
  getBackend(kind).begin(ctx)         // exclusive session + live store
  writeFn(store, ctx)                 // caller mutates the store in place
  if dirty: bump revision/updatedAt, session.commit()
  finally: session.release()
```

The callback receives the **live, mutable** store and returns a boolean: `true`
means "I changed something, persist it", `false` means read-only. `withStore`
owns the `revision`/`updatedAt` bump. This contract is backend-agnostic, so
adding a backend never touches the ~13 tool call sites or the hooks.

### Backends (`src/storage/`)

| File | Role |
|---|---|
| `backend.ts` | `StorageBackend` / `StoreSession` interfaces + shared `emptyStore()` |
| `json-backend.ts` | Default: one JSON file, lockfile + atomic temp-and-rename write |
| `sqlite-backend.ts` | Opt-in: one `.sqlite` file, `BEGIN IMMEDIATE` transaction |
| `sqlite-driver.ts` | Driver adapter — `node:sqlite` preferred, `better-sqlite3` fallback |
| `config.ts` | `resolveStoreLocation()` — picks backend by env / project config / default |
| `migrations.ts` | `STORE_VERSION`, version-dispatch, `migrateRawStore()` |

Each backend owns its own locking model (JSON lockfile vs SQLite transaction), so
`withStore` stays a thin orchestrator.

### Store-format versioning

A store file carries a `version`. On load:

- **absent file** → fresh empty store (the only reset path);
- **present but corrupt / too-new** → throw (never silently overwrite real data);
- **older version** → run registered transforms up to `STORE_VERSION`.

This lives in `migrations.ts` and is shared by both backends.

## Store shape

```
Store { version, project, items[], proposals[], revision }
MemoryItem { id, type, title, content, tags[], source?, pinned?,
             createdAt, updatedAt, lastUsedAt?, expiresAt?, archivedAt?, ... }
```

Search/scoring (`src/domain.ts`) runs in memory over the loaded `items` array —
simple and fast at the expected scale (hundreds of items). The archive
(`.ai/memory-archive.json`) is a separate JSON file in both backends.

## Auto-capture hooks (`hooks/`)

Memory is captured automatically from session transcripts:

- `auto-save.ts` / `auto-memory.ts` — run on the session `Stop` event, extract
  facts via heuristics (`extractors.ts`), and persist through `withStore` (so they
  benefit from the backend abstraction unchanged).
- `cursor.ts` — tracks processed transcript lines to avoid reprocessing.
- `codex-transcript.ts` — normalizes Codex rollout files (OpenAI Responses API
  shape: `response_item` / `function_call` / `function_call_output`) into the
  Claude-shaped lines the extractors expect, so one set of extractors serves both
  CLIs. Called at the top of `extractAll`; Claude lines pass through untouched.
- `codex-notify.ts` — legacy fallback that adapts Codex's `notify` into the same
  entry point (for Codex versions predating native hooks).

Both `Stop` (end of session) and `PostToolUse` (real-time, opt-in) modes are
supported for Claude and Codex; real-time uses a lower capture threshold and
shares the same cursor + hash dedup as the Stop sweep. Items captured this way
are tagged `source: "auto-hook"`.
