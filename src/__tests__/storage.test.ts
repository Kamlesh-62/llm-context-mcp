import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { withStore } from "../storage.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("withStore", () => {
  it("creates an empty store when no file exists", async () => {
    const { store, projectRoot } = await withStore(
      async () => false,
      { projectRoot: tmpDir },
    );
    expect(store.version).toBe(1);
    expect(store.items).toEqual([]);
    expect(store.proposals).toEqual([]);
    expect(store.revision).toBe(0);
    expect(projectRoot).toBe(tmpDir);
  });

  it("writes store to disk when writeFn returns true", async () => {
    await withStore(
      async (store) => {
        store.items.push({
          id: "mem_test123",
          type: "fact",
          title: "Test item",
          content: "Test content",
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return true;
      },
      { projectRoot: tmpDir },
    );

    const filePath = path.join(tmpDir, ".ai", "memory.json");
    const raw = await fs.readFile(filePath, "utf8");
    const stored = JSON.parse(raw);
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0].title).toBe("Test item");
    expect(stored.revision).toBe(1);
  });

  it("does not write when writeFn returns false", async () => {
    await withStore(async () => false, { projectRoot: tmpDir });

    const filePath = path.join(tmpDir, ".ai", "memory.json");
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("increments revision on each write", async () => {
    for (let i = 0; i < 3; i++) {
      await withStore(async () => true, { projectRoot: tmpDir });
    }

    const filePath = path.join(tmpDir, ".ai", "memory.json");
    const raw = await fs.readFile(filePath, "utf8");
    const stored = JSON.parse(raw);
    expect(stored.revision).toBe(3);
  });

  it("preserves existing items across calls", async () => {
    await withStore(
      async (store) => {
        store.items.push({
          id: "mem_first",
          type: "fact",
          title: "First",
          content: "First item",
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return true;
      },
      { projectRoot: tmpDir },
    );

    await withStore(
      async (store) => {
        store.items.push({
          id: "mem_second",
          type: "note",
          title: "Second",
          content: "Second item",
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return true;
      },
      { projectRoot: tmpDir },
    );

    const filePath = path.join(tmpDir, ".ai", "memory.json");
    const raw = await fs.readFile(filePath, "utf8");
    const stored = JSON.parse(raw);
    expect(stored.items).toHaveLength(2);
    expect(stored.items[0].title).toBe("First");
    expect(stored.items[1].title).toBe("Second");
  });
});
