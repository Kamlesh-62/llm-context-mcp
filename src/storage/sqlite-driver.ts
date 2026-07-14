import { createRequire } from "node:module";

/**
 * A minimal synchronous SQLite surface shared by both drivers. Deliberately
 * tiny — just what the backend needs — so `node:sqlite` and `better-sqlite3`
 * can be normalized behind one shape.
 */
export interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type OpenFn = (dbPath: string) => SqliteDb;

let cachedOpen: OpenFn | null | undefined;

/**
 * Wrap Node's built-in `node:sqlite` `DatabaseSync`. Available on Node ≥22.5
 * (stable on 24+). Emits an experimental warning to stderr on some versions —
 * harmless for an MCP server, whose protocol runs on stdout.
 */
function tryNodeSqlite(): OpenFn | null {
  let DatabaseSync: unknown;
  try {
    const mod = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync?: new (p: string) => SqliteDb;
    };
    DatabaseSync = mod.DatabaseSync;
  } catch {
    return null;
  }
  if (typeof DatabaseSync !== "function") return null;
  const Ctor = DatabaseSync as new (p: string) => SqliteDb;
  return (dbPath: string) => new Ctor(dbPath);
}

/**
 * Wrap the `better-sqlite3` native module if installed (an optionalDependency).
 * Its `Database`/`Statement` API already matches {@link SqliteDb} closely.
 */
function tryBetterSqlite3(): OpenFn | null {
  let Database: unknown;
  try {
    Database = createRequire(import.meta.url)("better-sqlite3");
  } catch {
    return null;
  }
  if (typeof Database !== "function") return null;
  const Ctor = Database as new (p: string) => SqliteDb;
  return (dbPath: string) => new Ctor(dbPath);
}

function resolveOpen(): OpenFn | null {
  if (cachedOpen !== undefined) return cachedOpen;
  cachedOpen = tryNodeSqlite() ?? tryBetterSqlite3() ?? null;
  return cachedOpen;
}

/** Whether a SQLite driver is usable in this runtime (for doctor/guards). */
export function sqliteAvailable(): boolean {
  return resolveOpen() !== null;
}

/**
 * Open (creating if needed) a SQLite database and apply the busy timeout so
 * concurrent processes wait for the writer lock instead of failing instantly.
 *
 * Throws an actionable error if no driver is available — the caller must NOT
 * fall back to another backend, which would split a project's memory in two.
 */
export function openDatabase(dbPath: string, opts: { busyTimeoutMs: number }): SqliteDb {
  const open = resolveOpen();
  if (!open) {
    throw new Error(
      "SQLite backend requires Node >=22.5 (built-in node:sqlite) or the optional dependency better-sqlite3 (`npm i better-sqlite3`).",
    );
  }
  const db = open(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs))}`);
  return db;
}
