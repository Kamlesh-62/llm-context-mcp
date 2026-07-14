import crypto from "node:crypto";

import { nowIso } from "../runtime.js";
import { STORE_VERSION } from "./migrations.js";
import type { Store, StoreContext } from "../types.js";

export type BackendKind = "json" | "sqlite";

/** Where a project's memory lives and which backend serves it. */
export interface StoreLocation {
  backend: BackendKind;
  path: string;
}

/**
 * One exclusive read-modify-write session over a store.
 *
 * `store` is the live, mutable snapshot — callers mutate it in place (the same
 * contract `withStore`'s callback has always had). `commit` persists the whole
 * store atomically; `release` frees the lock/transaction and must always run in
 * a `finally`. A session that is released without a commit persists nothing.
 */
export interface StoreSession {
  store: Store;
  commit(): Promise<void>;
  release(): Promise<void>;
}

/**
 * A storage backend. `begin` acquires exclusive access AND loads the current
 * store, returning a session. Each backend owns its own locking model (JSON
 * uses a lockfile; SQLite uses a write transaction), so `withStore` stays a
 * thin orchestrator that only bumps `revision`/`updatedAt` and decides whether
 * to commit.
 */
export interface StorageBackend {
  begin(ctx: StoreContext): Promise<StoreSession>;
}

/**
 * The canonical first-load store. Shared by every backend so a project's
 * `project.id` (derived from its root) and initial `version`/`revision` are
 * identical no matter where the data is stored.
 */
export function emptyStore(projectRoot: string, memoryFilePath: string): Store {
  return {
    version: STORE_VERSION,
    project: {
      id: crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 12),
      root: projectRoot,
      memoryFile: memoryFilePath,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    items: [],
    proposals: [],
    revision: 0,
  };
}
