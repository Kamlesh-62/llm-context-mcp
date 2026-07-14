import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveStoreLocation } from "../storage/config.js";

let tmpDir: string;
const ENV_KEYS = ["MEMORY_STORAGE_BACKEND", "MEMORY_DB_PATH", "MEMORY_FILE_PATH"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-cfg-"));
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

async function writeProjectConfig(obj: unknown) {
  const dir = path.join(tmpDir, ".ai");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "memory-mcp.json"), JSON.stringify(obj), "utf8");
}

describe("resolveStoreLocation", () => {
  it("defaults to json at .ai/memory.json", async () => {
    const loc = await resolveStoreLocation(tmpDir);
    expect(loc.backend).toBe("json");
    expect(loc.path).toBe(path.join(tmpDir, ".ai", "memory.json"));
  });

  it("reads storage.backend from .ai/memory-mcp.json", async () => {
    await writeProjectConfig({ storage: { backend: "sqlite" } });
    const loc = await resolveStoreLocation(tmpDir);
    expect(loc.backend).toBe("sqlite");
    expect(loc.path).toBe(path.join(tmpDir, ".ai", "memory.sqlite"));
  });

  it("env MEMORY_STORAGE_BACKEND overrides the config file", async () => {
    await writeProjectConfig({ storage: { backend: "sqlite" } });
    process.env.MEMORY_STORAGE_BACKEND = "json";
    const loc = await resolveStoreLocation(tmpDir);
    expect(loc.backend).toBe("json");
  });

  it("honors MEMORY_DB_PATH for the sqlite path (relative + absolute)", async () => {
    process.env.MEMORY_STORAGE_BACKEND = "sqlite";

    process.env.MEMORY_DB_PATH = "custom/mem.db";
    let loc = await resolveStoreLocation(tmpDir);
    expect(loc.path).toBe(path.join(tmpDir, "custom", "mem.db"));

    process.env.MEMORY_DB_PATH = path.join(tmpDir, "abs.db");
    loc = await resolveStoreLocation(tmpDir);
    expect(loc.path).toBe(path.join(tmpDir, "abs.db"));
  });

  it("throws on an unknown backend in the config file", async () => {
    await writeProjectConfig({ storage: { backend: "sqllite" } });
    await expect(resolveStoreLocation(tmpDir)).rejects.toThrow(/Invalid storage\.backend/);
  });

  it("throws on an unknown MEMORY_STORAGE_BACKEND", async () => {
    process.env.MEMORY_STORAGE_BACKEND = "postgres";
    await expect(resolveStoreLocation(tmpDir)).rejects.toThrow(/Invalid MEMORY_STORAGE_BACKEND/);
  });

  it("ignores an unrelated/corrupt config file and defaults to json", async () => {
    const dir = path.join(tmpDir, ".ai");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "memory-mcp.json"), "{ not json", "utf8");
    const loc = await resolveStoreLocation(tmpDir);
    expect(loc.backend).toBe("json");
  });
});
