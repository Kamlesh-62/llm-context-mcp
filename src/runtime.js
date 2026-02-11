import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG } from "./config.js";

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string") return "";
  const trimmed = projectRoot.trim();
  return trimmed ? path.resolve(trimmed) : "";
}

/**
 * Find a "project root" to keep memory project-scoped.
 * Priority:
 *  1) MEMORY_PROJECT_ROOT env var
 *  2) nearest ancestor containing ".git" directory
 *  3) current working directory
 */
export async function findProjectRoot() {
  const explicit = process.env.MEMORY_PROJECT_ROOT;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());

  let dir = process.cwd();
  while (true) {
    try {
      const gitPath = path.join(dir, ".git");
      const stat = await fs.stat(gitPath);
      // .git can be a directory or a file (worktrees/submodules).
      if (stat.isDirectory() || stat.isFile()) return dir;
    } catch {
      // keep walking up
    }

    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export function resolveMemoryFilePath(projectRoot) {
  const envPath = process.env.MEMORY_FILE_PATH;
  if (envPath && envPath.trim()) {
    // If relative, resolve relative to projectRoot (so configs can stay portable).
    return path.isAbsolute(envPath.trim())
      ? envPath.trim()
      : path.join(projectRoot, envPath.trim());
  }
  return path.join(projectRoot, CONFIG.defaultRelMemoryPath);
}
