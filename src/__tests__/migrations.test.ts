import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  STORE_VERSION,
  StoreFormatError,
  migrateRawStore,
} from "../storage/migrations.js";
import { withStore } from "../storage.js";

function validRawStore() {
  return {
    version: STORE_VERSION,
    project: {
      id: "abc123",
      root: "/tmp/x",
      memoryFile: "/tmp/x/.ai/memory.json",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    items: [],
    proposals: [],
    revision: 0,
  };
}

describe("migrateRawStore", () => {
  it("accepts a valid current-version store", () => {
    const raw = validRawStore();
    const store = migrateRawStore(raw);
    expect(store.version).toBe(STORE_VERSION);
    expect(store.items).toEqual([]);
    expect(store.proposals).toEqual([]);
  });

  it("throws when the value is not an object", () => {
    expect(() => migrateRawStore("nope")).toThrow(StoreFormatError);
    expect(() => migrateRawStore(null)).toThrow(StoreFormatError);
    expect(() => migrateRawStore([1, 2, 3])).toThrow(StoreFormatError);
  });

  it("throws when version is missing or not an integer", () => {
    expect(() => migrateRawStore({ items: [], proposals: [] })).toThrow(StoreFormatError);
    expect(() => migrateRawStore({ version: "1", items: [], proposals: [] })).toThrow(
      StoreFormatError,
    );
    expect(() => migrateRawStore({ version: 1.5, items: [], proposals: [] })).toThrow(
      StoreFormatError,
    );
  });

  it("throws when version is newer than supported", () => {
    const raw = { ...validRawStore(), version: STORE_VERSION + 1 };
    expect(() => migrateRawStore(raw)).toThrow(/newer than supported/);
  });

  it("throws when items/proposals arrays are missing", () => {
    expect(() => migrateRawStore({ version: STORE_VERSION, project: {} })).toThrow(
      /items\/proposals/,
    );
  });
});

describe("loadStore data-loss guard (via withStore)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-mig-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("initializes an empty store when the file is absent", async () => {
    const { store } = await withStore(async () => false, { projectRoot: tmpDir });
    expect(store.items).toEqual([]);
    expect(store.revision).toBe(0);
  });

  it("throws and does NOT overwrite when the store file is corrupt", async () => {
    const filePath = path.join(tmpDir, ".ai", "memory.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const garbage = "{ this is not valid json";
    await fs.writeFile(filePath, garbage, "utf8");

    // A write attempt must fail rather than silently reset the store.
    await expect(
      withStore(async (store) => {
        store.items.push({
          id: "mem_x",
          type: "note",
          title: "x",
          content: "x",
          tags: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        return true;
      }, { projectRoot: tmpDir }),
    ).rejects.toThrow(StoreFormatError);

    // Original bytes are still on disk — nothing was clobbered.
    const after = await fs.readFile(filePath, "utf8");
    expect(after).toBe(garbage);
  });

  it("throws when the store file version is newer than supported", async () => {
    const filePath = path.join(tmpDir, ".ai", "memory.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const future = { ...validRawStore(), version: STORE_VERSION + 1 };
    await fs.writeFile(filePath, JSON.stringify(future), "utf8");

    await expect(withStore(async () => false, { projectRoot: tmpDir })).rejects.toThrow(
      StoreFormatError,
    );
  });

  it("loads an existing valid store", async () => {
    await withStore(async (store) => {
      store.items.push({
        id: "mem_keep",
        type: "fact",
        title: "Keep",
        content: "Keep me",
        tags: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      return true;
    }, { projectRoot: tmpDir });

    const { store } = await withStore(async () => false, { projectRoot: tmpDir });
    expect(store.items).toHaveLength(1);
    expect(store.items[0].title).toBe("Keep");
  });
});
