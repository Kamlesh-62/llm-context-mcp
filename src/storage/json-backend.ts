import fs from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

import { CONFIG } from "../config.js";
import { nowIso } from "../runtime.js";
import { emptyStore } from "./backend.js";
import { StoreFormatError, migrateRawStore } from "./migrations.js";
import type { StorageBackend, StoreSession } from "./backend.js";
import type { Store, StoreContext } from "../types.js";

async function ensureDirForFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function tryAcquireLock(lockPath: string): Promise<FileHandle | null> {
  try {
    // 'wx' => create exclusively, fails if exists
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n${nowIso()}\n`);
    return handle;
  } catch {
    return null;
  }
}

async function acquireLock(lockPath: string): Promise<FileHandle> {
  const started = Date.now();
  let delay = CONFIG.lockRetryDelayMs;

  while (Date.now() - started < CONFIG.lockTimeoutMs) {
    const handle = await tryAcquireLock(lockPath);
    if (handle) return handle;

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(
      CONFIG.maxLockRetryDelayMs,
      Math.floor(delay * CONFIG.lockRetryBackoff),
    );
  }

  throw new Error(`Lock timeout acquiring ${lockPath}`);
}

async function releaseLock(lockPath: string, handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // ignore
  }
  try {
    await fs.unlink(lockPath);
  } catch {
    // ignore
  }
}

async function loadStore(memoryFilePath: string, projectRoot: string): Promise<Store> {
  let raw: string;
  try {
    raw = await fs.readFile(memoryFilePath, "utf8");
  } catch (err) {
    // Only a genuinely absent file is a fresh start. Any other read failure
    // (permissions, IO) must propagate — silently resetting would let the
    // next write overwrite recoverable data.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyStore(projectRoot, memoryFilePath);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoreFormatError(`Store file is not valid JSON: ${memoryFilePath}`);
  }

  // Validate + upgrade to the current format. Throws StoreFormatError for a
  // corrupt or too-new file rather than discarding it.
  return migrateRawStore(parsed);
}

async function atomicWriteJson(filePath: string, obj: Store): Promise<void> {
  await ensureDirForFile(filePath);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

class JsonSession implements StoreSession {
  store: Store;
  private readonly memoryFilePath: string;
  private readonly lockPath: string;
  private readonly lockHandle: FileHandle;

  constructor(store: Store, memoryFilePath: string, lockPath: string, lockHandle: FileHandle) {
    this.store = store;
    this.memoryFilePath = memoryFilePath;
    this.lockPath = lockPath;
    this.lockHandle = lockHandle;
  }

  async commit(): Promise<void> {
    await atomicWriteJson(this.memoryFilePath, this.store);
  }

  async release(): Promise<void> {
    await releaseLock(this.lockPath, this.lockHandle);
  }
}

/**
 * The default backend: one JSON file per project, guarded by a sibling `.lock`
 * file and written atomically (temp file + rename). Zero-config, offline,
 * git-diffable — the historical behavior, now behind the StorageBackend seam.
 */
export class JsonBackend implements StorageBackend {
  async begin(ctx: StoreContext): Promise<StoreSession> {
    const memoryFilePath = ctx.memoryFilePath;
    const lockPath = `${memoryFilePath}.lock`;

    await ensureDirForFile(memoryFilePath);
    const lockHandle = await acquireLock(lockPath);
    try {
      const store = await loadStore(memoryFilePath, ctx.projectRoot);
      return new JsonSession(store, memoryFilePath, lockPath, lockHandle);
    } catch (err) {
      // Load failed (e.g. corrupt store) — release the lock we just took so it
      // does not leak, then surface the error to the caller.
      await releaseLock(lockPath, lockHandle);
      throw err;
    }
  }
}
