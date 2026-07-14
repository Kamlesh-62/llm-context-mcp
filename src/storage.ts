import { findProjectRoot, normalizeProjectRoot, nowIso } from "./runtime.js";
import { resolveStoreLocation } from "./storage/config.js";
import { JsonBackend } from "./storage/json-backend.js";
import { SqliteBackend } from "./storage/sqlite-backend.js";
import type { BackendKind, StorageBackend } from "./storage/backend.js";
import type { Store, StoreContext, StoreWriteResult } from "./types.js";

const jsonBackend = new JsonBackend();
const sqliteBackend = new SqliteBackend();

/**
 * Resolve a backend implementation by kind. Only JSON exists today; the SQLite
 * backend and config-driven selection arrive in later phases. Selecting an
 * unbuilt backend fails loudly rather than silently falling back to JSON, which
 * would fragment a project's memory across two stores.
 */
function getBackend(kind: BackendKind): StorageBackend {
  switch (kind) {
    case "json":
      return jsonBackend;
    case "sqlite":
      return sqliteBackend;
    default:
      throw new Error(`Storage backend "${kind}" is not available in this build`);
  }
}

/**
 * The single entry point for all reads and writes. Acquires an exclusive
 * session from the resolved backend, hands the live store to `writeFn`, and —
 * only if the callback reports a mutation — bumps `revision`/`updatedAt` and
 * commits. The session is always released. Signature and return shape are
 * unchanged from the original file-based implementation, so every caller and
 * hook keeps working without modification.
 */
export async function withStore(
  writeFn: (store: Store, ctx: StoreContext) => boolean | Promise<boolean>,
  options: { projectRoot?: string } = {},
): Promise<StoreWriteResult> {
  const projectRoot =
    normalizeProjectRoot(options.projectRoot) || (await findProjectRoot());
  const location = await resolveStoreLocation(projectRoot);
  const memoryFilePath = location.path;
  const ctx: StoreContext = { projectRoot, memoryFilePath };

  const backend = getBackend(location.backend);
  const session = await backend.begin(ctx);
  try {
    const updated = await writeFn(session.store, ctx);
    if (updated) {
      session.store.project.updatedAt = nowIso();
      session.store.revision = (session.store.revision || 0) + 1;
      await session.commit();
    }
    return { store: session.store, projectRoot, memoryFilePath };
  } finally {
    await session.release();
  }
}
