#!/usr/bin/env node
/**
 * Auto-save hook for Claude Code.
 * Fires on the "Stop" event, reads new transcript lines, extracts facts
 * via heuristics, and persists them to the project memory store.
 *
 * Runs async & in the background — user sees nothing.
 * Never throws to the caller; exits silently on any error.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCursor, saveCursor } from "./cursor.js";
import { extractAll } from "./extractors.js";

// Resolve src imports relative to this file's package
const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const { withStore } = await import(join(ROOT, "src", "storage.js"));
const { newId, normalizeTags, validateType } = await import(join(ROOT, "src", "domain.js"));
const { nowIso } = await import(join(ROOT, "src", "runtime.js"));

type ExtractedItem = {
  type: string;
  title: string;
  content: string;
  tags?: string[];
};

// ── helpers ──────────────────────────────────────────────────────────────────

function titleHash(title: string): string {
  return createHash("sha256").update(title).digest("hex").slice(0, 16);
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

async function readStdin(): Promise<string> {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readTranscriptLines(transcriptPath: string): Promise<any[]> {
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

function countAssistantMessages(lines: any[]): number {
  return lines.filter(
    (l) => l.type === "assistant" || l.message?.role === "assistant",
  ).length;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const isGemini = Boolean(process.env.GEMINI_PROJECT_DIR);
  try {
    // 1. Read hook payload from stdin
    const raw = await readStdin();
    const payload = JSON.parse(raw) as {
      session_id?: string;
      transcript_path?: string;
      cwd?: string;
    };

    const sessionId = payload.session_id ?? "unknown";
    const transcriptPath = payload.transcript_path;
    const cwd = payload.cwd ?? process.cwd();
    const projectDir =
      process.env.CLAUDE_PROJECT_DIR ||
      process.env.GEMINI_PROJECT_DIR ||
      process.env.CODEX_PROJECT_DIR ||
      cwd;

    if (!transcriptPath) return;

    // 2. Load cursor
    const cursorPath = join(projectDir, ".ai", ".auto-save-cursor.json");
    const cursor = await loadCursor(cursorPath, sessionId);

    // 3. Read transcript and slice to new lines
    const allLines = await readTranscriptLines(transcriptPath);
    const startIndex = cursor.lastLineIndex + 1;
    if (startIndex >= allLines.length) return; // nothing new

    const delta = allLines.slice(startIndex);

    // 4. Minimum threshold: need at least 2 new assistant messages
    if (countAssistantMessages(delta) < 2) return;

    // 5. Run extractors
    const candidates = extractAll(delta) as ExtractedItem[];
    if (candidates.length === 0) return;

    // 6. Deduplicate
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
      // Still update cursor position even if nothing new to save
      await saveCursor(cursorPath, sessionId, allLines.length - 1, newHashes);
      return;
    }

    // 7. Persist via withStore — also checks Jaccard similarity against existing items
    await withStore(
      (store) => {
        let saved = 0;
        for (const item of toSave) {
          // Jaccard dedup against existing store titles
          const isDup = store.items.some(
            (existing) => jaccardSimilarity(existing.title ?? "", item.title) > 0.8,
          );
          if (isDup) continue;

          store.items.push({
            id: newId("mem"),
            type: validateType(item.type),
            title: item.title.slice(0, 200),
            content: (item.content ?? "").slice(0, 500),
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

    // 8. Update cursor
    await saveCursor(cursorPath, sessionId, allLines.length - 1, newHashes);
  } finally {
    if (isGemini) {
      process.stdout.write("{}");
    }
  }
}

// ── entry ────────────────────────────────────────────────────────────────────

main().catch(() => process.exit(0));
