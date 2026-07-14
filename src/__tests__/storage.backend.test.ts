import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { withStore } from "../storage.js";
import { sqliteAvailable } from "../storage/sqlite-driver.js";

function makeItem(id: string, title: string) {
  return {
    id,
    type: "fact" as const,
    title,
    content: `${title} content`,
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const BACKENDS = ["json", "sqlite"] as const;

describe.each(BACKENDS)("StorageBackend contract [%s]", (backend) => {
  const skip = backend === "sqlite" && !sqliteAvailable();
  const t = skip ? it.skip : it;

  let tmpDir: string;
  let savedBackend: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `mem-be-${backend}-`));
    savedBackend = process.env.MEMORY_STORAGE_BACKEND;
    process.env.MEMORY_STORAGE_BACKEND = backend;
  });

  afterEach(async () => {
    if (savedBackend === undefined) delete process.env.MEMORY_STORAGE_BACKEND;
    else process.env.MEMORY_STORAGE_BACKEND = savedBackend;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  t("creates an empty store when nothing exists", async () => {
    const { store } = await withStore(async () => false, { projectRoot: tmpDir });
    expect(store.items).toEqual([]);
    expect(store.proposals).toEqual([]);
    expect(store.revision).toBe(0);
  });

  t("persists writes and bumps revision, readable on re-open", async () => {
    await withStore(async (store) => {
      store.items.push(makeItem("mem_a", "Alpha"));
      return true;
    }, { projectRoot: tmpDir });

    const { store } = await withStore(async () => false, { projectRoot: tmpDir });
    expect(store.items).toHaveLength(1);
    expect(store.items[0].title).toBe("Alpha");
    expect(store.revision).toBe(1);
  });

  t("does not persist when the callback returns false", async () => {
    await withStore(async (store) => {
      store.items.push(makeItem("mem_ghost", "Ghost"));
      return false;
    }, { projectRoot: tmpDir });

    const { store } = await withStore(async () => false, { projectRoot: tmpDir });
    expect(store.items).toHaveLength(0);
    expect(store.revision).toBe(0);
  });

  t("increments revision on each write and preserves items across calls", async () => {
    await withStore(async (store) => {
      store.items.push(makeItem("mem_1", "First"));
      return true;
    }, { projectRoot: tmpDir });
    await withStore(async (store) => {
      store.items.push(makeItem("mem_2", "Second"));
      return true;
    }, { projectRoot: tmpDir });

    const { store } = await withStore(async () => false, { projectRoot: tmpDir });
    expect(store.items.map((i) => i.title).sort()).toEqual(["First", "Second"]);
    expect(store.revision).toBe(2);
  });

  t("supports item removal", async () => {
    await withStore(async (store) => {
      store.items.push(makeItem("mem_x", "X"), makeItem("mem_y", "Y"));
      return true;
    }, { projectRoot: tmpDir });
    await withStore(async (store) => {
      store.items = store.items.filter((i) => i.id !== "mem_x");
      return true;
    }, { projectRoot: tmpDir });

    const { store } = await withStore(async () => false, { projectRoot: tmpDir });
    expect(store.items).toHaveLength(1);
    expect(store.items[0].id).toBe("mem_y");
  });
});
