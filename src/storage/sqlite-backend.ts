import fs from "node:fs";
import path from "node:path";

import { CONFIG } from "../config.js";
import { emptyStore } from "./backend.js";
import { migrateRawStore } from "./migrations.js";
import { openDatabase } from "./sqlite-driver.js";
import type { StorageBackend, StoreSession } from "./backend.js";
import type { SqliteDb } from "./sqlite-driver.js";
import type { MemoryItem, MemoryProposal, Store, StoreContext } from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  project TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
`;

function ensureSchema(db: SqliteDb): void {
  db.exec(SCHEMA);
}

/**
 * Reconstruct a full Store from the database. A database with no `meta` row is
 * a fresh store. The assembled object is run through `migrateRawStore` so the
 * exact same version-dispatch/validation as the JSON backend applies.
 */
function loadStore(db: SqliteDb, projectRoot: string, dbPath: string): Store {
  const meta = db.prepare("SELECT version, revision, project FROM meta WHERE id = 1").get();
  if (!meta) {
    return emptyStore(projectRoot, dbPath);
  }

  const items = db
    .prepare("SELECT data FROM items")
    .all()
    .map((row) => JSON.parse(String(row.data)) as MemoryItem);
  const proposals = db
    .prepare("SELECT data FROM proposals")
    .all()
    .map((row) => JSON.parse(String(row.data)) as MemoryProposal);

  const raw = {
    version: Number(meta.version),
    revision: Number(meta.revision),
    project: JSON.parse(String(meta.project)),
    items,
    proposals,
  };
  return migrateRawStore(raw);
}

/**
 * Persist the whole store inside the open transaction. Because the write
 * callback hands back the entire mutated Store with no per-row diff, we replace
 * items/proposals wholesale — correct and simple at this scale (hundreds of
 * items). Runs inside the caller's BEGIN IMMEDIATE, committed by the session.
 */
function writeStore(db: SqliteDb, store: Store): void {
  db.exec("DELETE FROM items");
  db.exec("DELETE FROM proposals");

  const insertItem = db.prepare("INSERT INTO items (id, data) VALUES (?, ?)");
  for (const item of store.items) {
    insertItem.run(item.id, JSON.stringify(item));
  }
  const insertProposal = db.prepare("INSERT INTO proposals (id, data) VALUES (?, ?)");
  for (const proposal of store.proposals) {
    insertProposal.run(proposal.id, JSON.stringify(proposal));
  }

  db.prepare(
    `INSERT INTO meta (id, version, revision, project) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version, revision = excluded.revision, project = excluded.project`,
  ).run(store.version, store.revision, JSON.stringify(store.project));
}

class SqliteSession implements StoreSession {
  store: Store;
  private readonly db: SqliteDb;
  private committed = false;
  private released = false;

  constructor(store: Store, db: SqliteDb) {
    this.store = store;
    this.db = db;
  }

  async commit(): Promise<void> {
    writeStore(this.db, this.store);
    this.db.exec("COMMIT");
    this.committed = true;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      if (!this.committed) {
        this.db.exec("ROLLBACK");
      }
    } finally {
      this.db.close();
    }
  }
}

/**
 * SQLite-backed store: one local `.sqlite` file per project. Opt-in via
 * `storage.backend = "sqlite"`. Concurrency is handled by the database itself —
 * `BEGIN IMMEDIATE` takes the writer lock for the read-modify-write window and
 * `busy_timeout` makes competing processes wait. No `.lock` file is used.
 */
export class SqliteBackend implements StorageBackend {
  async begin(ctx: StoreContext): Promise<StoreSession> {
    // The driver cannot create missing parent directories; mirror the JSON
    // backend's ensure-dir before opening the file.
    fs.mkdirSync(path.dirname(ctx.memoryFilePath), { recursive: true });
    const db = openDatabase(ctx.memoryFilePath, {
      busyTimeoutMs: CONFIG.storage.busyTimeoutMs,
    });
    try {
      ensureSchema(db);
      // Take the writer lock now so the read-modify-write cycle is serialized
      // against other processes, mirroring the JSON lockfile's guarantee.
      db.exec("BEGIN IMMEDIATE");
      const store = loadStore(db, ctx.projectRoot, ctx.memoryFilePath);
      return new SqliteSession(store, db);
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // no active transaction
      }
      db.close();
      throw err;
    }
  }
}
