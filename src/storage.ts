import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG } from "./config.js";
import {
  findProjectRoot,
  normalizeProjectRoot,
  nowIso,
  resolveMemoryFilePath,
} from "./runtime.js";
import type { Store, StoreContext, StoreWriteResult } from "./types.js";
import type { FileHandle } from "node:fs/promises";

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

function emptyStore(projectRoot: string, memoryFilePath: string): Store {
  return {
    version: 1,
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

async function loadStore(memoryFilePath: string, projectRoot: string): Promise<Store> {
  try {
    const raw = await fs.readFile(memoryFilePath, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid JSON");
    if (parsed.version !== 1 || !Array.isArray(parsed.items) || !Array.isArray(parsed.proposals)) {
      throw new Error("Unsupported store format");
    }
    return parsed;
  } catch {
    // file missing or unreadable => initialize
    return emptyStore(projectRoot, memoryFilePath);
  }
}

async function atomicWriteJson(filePath: string, obj: Store): Promise<void> {
  await ensureDirForFile(filePath);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

export async function withStore(
  writeFn: (store: Store, ctx: StoreContext) => boolean | Promise<boolean>,
  options: { projectRoot?: string } = {},
): Promise<StoreWriteResult> {
  const projectRoot =
    normalizeProjectRoot(options.projectRoot) || (await findProjectRoot());
  const memoryFilePath = resolveMemoryFilePath(projectRoot);
  const lockPath = `${memoryFilePath}.lock`;

  await ensureDirForFile(memoryFilePath);

  const lockHandle = await acquireLock(lockPath);
  try {
    const store = await loadStore(memoryFilePath, projectRoot);
    const updated = await writeFn(store, { projectRoot, memoryFilePath });
    if (updated) {
      store.project.updatedAt = nowIso();
      store.revision = (store.revision || 0) + 1;
      await atomicWriteJson(memoryFilePath, store);
    }
    return { store, projectRoot, memoryFilePath };
  } finally {
    await releaseLock(lockPath, lockHandle);
  }
}
