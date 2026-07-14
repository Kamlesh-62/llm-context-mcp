import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { withStore } from "../storage.js";
import { runMigrate } from "../cli/migrate.js";
import { sqliteAvailable } from "../storage/sqlite-driver.js";

const hasSqlite = sqliteAvailable();
const describeSqlite = hasSqlite ? describe : describe.skip;

let tmpDir: string;
const ENV_KEYS = ["MEMORY_STORAGE_BACKEND", "MEMORY_DB_PATH", "MEMORY_FILE_PATH"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-migrate-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedJson(count: number) {
  process.env.MEMORY_STORAGE_BACKEND = "json";
  await withStore(async (store) => {
    for (let i = 0; i < count; i++) {
      store.items.push({
        id: `mem_${i}`,
        type: "fact",
        title: `Item ${i}`,
        content: `Content ${i}`,
        tags: ["seed"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }
    return true;
  }, { projectRoot: tmpDir });
  delete process.env.MEMORY_STORAGE_BACKEND;
}

async function readVia(backend: string): Promise<number> {
  process.env.MEMORY_STORAGE_BACKEND = backend;
  const { store } = await withStore(async () => false, { projectRoot: tmpDir });
  delete process.env.MEMORY_STORAGE_BACKEND;
  return store.items.length;
}

describeSqlite("runMigrate json <-> sqlite", () => {
  it("migrates json -> sqlite and leaves the source intact", async () => {
    await seedJson(3);
    const code = await runMigrate(["--to", "sqlite", "--project", tmpDir]);
    expect(code).toBe(0);
    expect(await readVia("sqlite")).toBe(3);
    expect(await readVia("json")).toBe(3); // source untouched
  });

  it("round-trips json -> sqlite -> json with equal item counts", async () => {
    await seedJson(5);
    expect(await runMigrate(["--to", "sqlite", "--project", tmpDir])).toBe(0);
    // clear json so the reverse migration has a clean target
    await fs.rm(path.join(tmpDir, ".ai", "memory.json"), { force: true });
    expect(await runMigrate(["--to", "json", "--from", "sqlite", "--project", tmpDir])).toBe(0);
    expect(await readVia("json")).toBe(5);
  });

  it("refuses to overwrite a non-empty target without --force", async () => {
    await seedJson(2);
    expect(await runMigrate(["--to", "sqlite", "--project", tmpDir])).toBe(0);
    // second run: target now has data, no --force -> abort
    expect(await runMigrate(["--to", "sqlite", "--project", tmpDir])).toBe(1);
    // with --force it succeeds
    expect(await runMigrate(["--to", "sqlite", "--project", tmpDir, "--force"])).toBe(0);
  });

  it("--dry-run writes nothing to the target", async () => {
    await seedJson(4);
    expect(await runMigrate(["--to", "sqlite", "--project", tmpDir, "--dry-run"])).toBe(0);
    // no sqlite data persisted
    expect(await readVia("sqlite")).toBe(0);
  });

  it("--set-default records storage.backend in memory-mcp.json", async () => {
    await seedJson(1);
    expect(
      await runMigrate(["--to", "sqlite", "--project", tmpDir, "--set-default"]),
    ).toBe(0);
    const cfg = JSON.parse(
      await fs.readFile(path.join(tmpDir, ".ai", "memory-mcp.json"), "utf8"),
    );
    expect(cfg.storage.backend).toBe("sqlite");
  });
});

describe("runMigrate argument handling", () => {
  it("errors when --to is missing", async () => {
    expect(await runMigrate(["--project", tmpDir])).toBe(1);
  });

  it("errors when source and target are the same", async () => {
    expect(await runMigrate(["--to", "json", "--from", "json", "--project", tmpDir])).toBe(1);
  });

  it("reports nothing to migrate for an empty source", async () => {
    // json -> sqlite with no json data
    expect(await runMigrate(["--to", "sqlite", "--from", "json", "--project", tmpDir])).toBe(0);
  });
});
