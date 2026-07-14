# Storage Backends

Project memory can be stored in one of two backends. **JSON is the default** and
requires no setup. **SQLite** is opt-in for larger stores or faster search.

You choose per project — nothing is forced.

## At a glance

| | **JSON** (default) | **SQLite** (opt-in) |
|---|---|---|
| File | `.ai/memory.json` | `.ai/memory.sqlite` |
| Human-readable | ✅ yes | ❌ binary |
| Git-diffable / committable | ✅ yes | ❌ no |
| Setup / dependencies | none | Node ≥22.5, or `npm i better-sqlite3` |
| Concurrency | lock file | DB transaction + `busy_timeout` |
| Best for | small stores, team-shared-via-git | large stores, local-only |

**The tradeoff:** SQLite is faster and searchable but is a binary file you can't
commit meaningfully to git. That's why JSON stays the default — pick SQLite only
when you don't need git-diffable memory. You can always [migrate back](#migrating).

## Choosing a backend

Selection precedence (highest first):

1. `MEMORY_STORAGE_BACKEND` environment variable (`json` | `sqlite`) — for CI/one-offs.
2. `.ai/memory-mcp.json`:
   ```json
   { "storage": { "backend": "sqlite" } }
   ```
3. Default: `json`.

An unknown backend value fails loudly — it is never silently ignored (that would
send you to the wrong store).

### Paths

- JSON path: `.ai/memory.json`, overridable with `MEMORY_FILE_PATH`.
- SQLite path: `.ai/memory.sqlite`, overridable with the distinct `MEMORY_DB_PATH`.

## SQLite requirements

The SQLite backend needs a driver, resolved at runtime:

1. **`node:sqlite`** — built into Node **≥22.5** (stable on 24+). Zero install; preferred.
2. **`better-sqlite3`** — an optional native dependency, used as a fallback on
   older Node. Install it with `npm i better-sqlite3`.

If SQLite is selected but no driver is available, the server throws an actionable
error rather than falling back to JSON — falling back would split your memory
across two stores. Run `project-memory-mcp doctor` to check driver availability.

## Migrating

Because both backends speak the identical store format, migration is a copy —
the source is never modified, so it is always reversible.

```bash
# JSON -> SQLite
project-memory-mcp migrate --to sqlite

# SQLite -> JSON
project-memory-mcp migrate --to json --from sqlite

# Preview without writing
project-memory-mcp migrate --to sqlite --dry-run

# Overwrite a non-empty target
project-memory-mcp migrate --to sqlite --force

# Also set it as the default afterward
project-memory-mcp migrate --to sqlite --set-default
```

Flags:

- `--to <json|sqlite>` (required) — target backend.
- `--from <json|sqlite>` — source backend (defaults to the opposite of `--to`).
- `--project <path>` / `-p` — project root (defaults to auto-detection).
- `--dry-run` — report what would move; write nothing.
- `--force` — overwrite a target that already contains data.
- `--set-default` — write `storage.backend` into `.ai/memory-mcp.json` after a
  successful migration.

After migrating, the tool verifies item/proposal counts match the source before
reporting success. The source store is left in place, so you can switch back at
any time.
