import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { compactStoreInPlace } from "../maintenance.js";
import type { Store, StoreContext } from "../types.js";

let tmpDir: string;

function makeStore(itemCount: number): Store {
  const now = new Date().toISOString();
  return {
    version: 1,
    project: {
      id: "test_project",
      root: "/tmp/test",
      memoryFile: "/tmp/test/.ai/memory.json",
      createdAt: now,
      updatedAt: now,
    },
    items: Array.from({ length: itemCount }, (_, i) => ({
      id: `mem_${String(i).padStart(6, "0")}`,
      type: "fact" as const,
      title: `Item ${i}`,
      content: `Content for item ${i}`,
      tags: ["test"],
      createdAt: new Date(Date.now() - (itemCount - i) * 60000).toISOString(),
      updatedAt: new Date(Date.now() - (itemCount - i) * 60000).toISOString(),
    })),
    proposals: [],
    revision: 1,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compact-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("compactStoreInPlace", () => {
  it("does nothing when items are under maxItems", async () => {
    const store = makeStore(5);
    const ctx: StoreContext = { projectRoot: tmpDir, memoryFilePath: path.join(tmpDir, ".ai/memory.json") };

    const result = await compactStoreInPlace(store, ctx, { maxItems: 10 });
    expect(result.archived).toBe(0);
    expect(store.items).toHaveLength(5);
  });

  it("archives oldest items when over maxItems", async () => {
    const store = makeStore(20);
    const ctx: StoreContext = { projectRoot: tmpDir, memoryFilePath: path.join(tmpDir, ".ai/memory.json") };

    const result = await compactStoreInPlace(store, ctx, { maxItems: 10 });
    expect(result.archived).toBe(11); // 20 - (10-1 for summary) = 11
    // 9 survivors + 1 summary = 10
    expect(store.items).toHaveLength(10);
  });

  it("creates an archive file", async () => {
    const store = makeStore(20);
    const ctx: StoreContext = { projectRoot: tmpDir, memoryFilePath: path.join(tmpDir, ".ai/memory.json") };

    const result = await compactStoreInPlace(store, ctx, { maxItems: 10 });
    expect(result.archivePath).toBeTruthy();

    const raw = await fs.readFile(result.archivePath!, "utf8");
    const archive = JSON.parse(raw);
    expect(archive.items.length).toBe(11);
    expect(archive.items[0].archivedAt).toBeTruthy();
    expect(archive.items[0].archivedReason).toBe("manual");
  });

  it("adds a summary item to the store", async () => {
    const store = makeStore(20);
    const ctx: StoreContext = { projectRoot: tmpDir, memoryFilePath: path.join(tmpDir, ".ai/memory.json") };

    await compactStoreInPlace(store, ctx, {
      maxItems: 10,
      summaryTitle: "Test archive",
    });

    const summary = store.items.find((it) => it.title === "Test archive");
    expect(summary).toBeTruthy();
    expect(summary!.type).toBe("note");
    expect(summary!.tags).toContain("archive");
  });

  it("returns 0 when maxItems is 0", async () => {
    const store = makeStore(5);
    const ctx: StoreContext = { projectRoot: tmpDir, memoryFilePath: path.join(tmpDir, ".ai/memory.json") };

    const result = await compactStoreInPlace(store, ctx, { maxItems: 0 });
    expect(result.archived).toBe(0);
  });
});
