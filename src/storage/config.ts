import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG } from "../config.js";
import { resolveMemoryFilePath } from "../runtime.js";
import type { BackendKind, StoreLocation } from "./backend.js";

const PROJECT_CONFIG_FILENAME = "memory-mcp.json";
const KNOWN_BACKENDS: readonly BackendKind[] = ["json", "sqlite"];

function isBackendKind(value: unknown): value is BackendKind {
  return typeof value === "string" && (KNOWN_BACKENDS as readonly string[]).includes(value);
}

/**
 * Read the persisted `storage.backend` selection from `.ai/memory-mcp.json`,
 * if present. This file is shared with the suggestion-config tool; we only
 * read the `storage` subtree and ignore everything else. A missing or unreadable
 * file yields `undefined` (fall through to the default), but a present file that
 * names an unknown backend throws — silently ignoring a typo like "sqllite"
 * would send the user to the JSON store while they believe they chose SQLite.
 */
async function readConfiguredBackend(projectRoot: string): Promise<BackendKind | undefined> {
  const configPath = path.join(projectRoot, ".ai", PROJECT_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const storage = (parsed as Record<string, unknown>).storage;
  if (typeof storage !== "object" || storage === null) return undefined;
  const backend = (storage as Record<string, unknown>).backend;
  if (backend === undefined) return undefined;

  if (!isBackendKind(backend)) {
    throw new Error(
      `Invalid storage.backend "${String(backend)}" in ${configPath}. Expected one of: ${KNOWN_BACKENDS.join(", ")}.`,
    );
  }
  return backend;
}

function resolveSqlitePath(projectRoot: string): string {
  const envPath = process.env.MEMORY_DB_PATH;
  if (envPath && envPath.trim()) {
    const trimmed = envPath.trim();
    return path.isAbsolute(trimmed) ? trimmed : path.join(projectRoot, trimmed);
  }
  return path.join(projectRoot, CONFIG.storage.sqliteRelPath);
}

/**
 * Decide which backend serves a project and where its data lives.
 *
 * Precedence (highest first):
 *  1. `MEMORY_STORAGE_BACKEND` env — for CI/tests and one-off overrides.
 *  2. `.ai/memory-mcp.json` → `storage.backend`.
 *  3. `CONFIG.storage.backend` default ("json").
 *
 * Path resolution is backend-specific: JSON honors `MEMORY_FILE_PATH`
 * (default `.ai/memory.json`); SQLite honors the distinct `MEMORY_DB_PATH`
 * (default `.ai/memory.sqlite`).
 */
export async function resolveStoreLocation(projectRoot: string): Promise<StoreLocation> {
  const envBackend = process.env.MEMORY_STORAGE_BACKEND?.trim();
  let backend: BackendKind;
  if (envBackend) {
    if (!isBackendKind(envBackend)) {
      throw new Error(
        `Invalid MEMORY_STORAGE_BACKEND "${envBackend}". Expected one of: ${KNOWN_BACKENDS.join(", ")}.`,
      );
    }
    backend = envBackend;
  } else {
    backend = (await readConfiguredBackend(projectRoot)) ?? CONFIG.storage.backend;
  }

  const storePath =
    backend === "sqlite" ? resolveSqlitePath(projectRoot) : resolveMemoryFilePath(projectRoot);

  return { backend, path: storePath };
}
