/**
 * Shared utilities for Claude/Gemini/Codex hook files.
 * Owns the ROOT constant, dynamic src imports, and the common
 * dedup+persist pipeline so each hook file stays DRY.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LIMITS } from "../src/config.js";
import type { MemoryType } from "../src/types.js";

// Resolve the dist/ root so dynamic imports point to compiled src modules.
const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
export const { withStore }                          = await import(join(ROOT, "src", "storage.js"));
export const { newId, normalizeTags, validateType } = await import(join(ROOT, "src", "domain.js"));
export const { nowIso }                             = await import(join(ROOT, "src", "runtime.js"));

export type ExtractedItem = {
  type: MemoryType;
  title: string;
  content: string;
  tags?: string[];
};

// ── helpers ──────────────────────────────────────────────────────────────────

export function titleHash(title: string): string {
  return createHash("sha256").update(title).digest("hex").slice(0, 16);
}

export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function readTranscriptLines(transcriptPath: string): Promise<unknown[]> {
  const raw = await readFile(transcriptPath, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Prefer JSON (array/object) when possible, fallback to JSONL
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
    if (parsed && Array.isArray(parsed.messages)) return parsed.messages.filter(Boolean);
    if (parsed && Array.isArray(parsed.items)) return parsed.items.filter(Boolean);
    return [parsed].filter(Boolean);
  } catch {
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}

export function countAssistantMessages(lines: unknown[]): number {
  return (lines as Record<string, any>[]).filter(
    (l) => l.type === "assistant" || l.message?.role === "assistant",
  ).length;
}

// ── shared dedup + persist pipeline ──────────────────────────────────────────

/**
 * Hash-dedup candidates, then persist novel items via withStore (Jaccard dedup).
 * Returns the updated full hash list and the count of items saved.
 * Callers are responsible for writing the cursor file.
 */
export async function saveExtractedItems(params: {
  projectDir: string;
  candidates: ExtractedItem[];
  cursor: { itemHashes: string[] };
}): Promise<{ newHashes: string[]; saved: number }> {
  const { projectDir, candidates, cursor } = params;

  const existingHashes = new Set(cursor.itemHashes);
  const newHashes = [...cursor.itemHashes];
  const toSave: ExtractedItem[] = [];

  for (const item of candidates) {
    const hash = titleHash(item.title);
    if (existingHashes.has(hash)) continue;
    existingHashes.add(hash);
    newHashes.push(hash);
    toSave.push(item);
  }

  if (toSave.length === 0) {
    return { newHashes, saved: 0 };
  }

  let saved = 0;
  await withStore(
    (store: any) => {
      for (const item of toSave) {
        // Jaccard dedup against existing store titles
        const isDup = store.items.some(
          (existing: any) => jaccardSimilarity(existing.title ?? "", item.title) > 0.8,
        );
        if (isDup) continue;

        store.items.push({
          id: newId("mem"),
          type: validateType(item.type),
          title: item.title.slice(0, LIMITS.maxTitleChars),
          content: (item.content ?? "").slice(0, LIMITS.maxContentChars),
          tags: normalizeTags([...(item.tags ?? []), "auto-hook"]),
          source: "auto-hook",
          pinned: false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        saved++;
      }
      return saved > 0; // signal withStore to write
    },
    { projectRoot: projectDir },
  );

  return { newHashes, saved };
}
