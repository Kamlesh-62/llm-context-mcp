import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { LIMITS } from "../src/config.js";

const DEFAULTS = { sessionId: null, lastLineIndex: -1, itemHashes: [], updatedAt: null };

export async function loadCursor(
  cursorPath: string,
  sessionId: string,
): Promise<{ lastLineIndex: number; itemHashes: string[] }> {
  try {
    const raw = await readFile(cursorPath, "utf8");
    const data = JSON.parse(raw) as {
      sessionId?: string;
      lastLineIndex?: number;
      itemHashes?: string[];
    };

    // Reset line index when session changes, but keep hashes for cross-session dedup
    if (data.sessionId !== sessionId) {
      return { lastLineIndex: -1, itemHashes: data.itemHashes ?? [] };
    }
    return {
      lastLineIndex: data.lastLineIndex ?? -1,
      itemHashes: data.itemHashes ?? [],
    };
  } catch {
    return { lastLineIndex: DEFAULTS.lastLineIndex, itemHashes: [] };
  }
}

export async function saveCursor(
  cursorPath: string,
  sessionId: string,
  lastLineIndex: number,
  itemHashes: string[],
): Promise<void> {
  const trimmed = itemHashes.slice(-LIMITS.maxCursorHashes);
  const data = {
    sessionId,
    lastLineIndex,
    itemHashes: trimmed,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(cursorPath), { recursive: true });
  await writeFile(cursorPath, JSON.stringify(data, null, 2));
}
