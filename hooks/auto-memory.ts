#!/usr/bin/env node
/**
 * Auto-memory hook (Stop / SessionEnd only):
 * Captures transcript takeaways into project memory using heuristic extractors.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCursor, saveCursor } from "./cursor.js";
import { extractAll } from "./extractors.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const { withStore } = await import(join(ROOT, "src", "storage.js"));
const { nowIso } = await import(join(ROOT, "src", "runtime.js"));
const {
  newId,
  normalizeTags,
  validateType,
} = await import(join(ROOT, "src", "domain.js"));

type ExtractedItem = {
  type: string;
  title: string;
  content: string;
  tags?: string[];
};

// ── utility helpers ───────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parsePayload(raw: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function projectDirFromPayload(payload: Record<string, unknown>): string {
  const cwd = (payload.cwd as string | undefined) ?? process.cwd();
  return (
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.GEMINI_PROJECT_DIR ||
    process.env.CODEX_PROJECT_DIR ||
    cwd
  );
}

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

async function readTranscriptLines(transcriptPath: string): Promise<any[]> {
  const raw = await readFile(transcriptPath, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) return [];

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
  return lines.filter((l) => l.type === "assistant" || l.message?.role === "assistant").length;
}

// ── stop handler ─────────────────────────────────────────────────────────────

async function handleStop(payload: Record<string, unknown>): Promise<void> {
  const sessionId = (payload.session_id as string | undefined) ?? "unknown";
  const transcriptPath = payload.transcript_path as string | undefined;
  if (!transcriptPath) return;

  const projectDir = projectDirFromPayload(payload);
  const cursorPath = join(projectDir, ".ai", ".auto-save-cursor.json");
  const cursor = await loadCursor(cursorPath, sessionId);

  const allLines = await readTranscriptLines(transcriptPath);
  const startIndex = cursor.lastLineIndex + 1;
  if (startIndex >= allLines.length) return;

  const delta = allLines.slice(startIndex);
  if (countAssistantMessages(delta) < 2) {
    await saveCursor(cursorPath, sessionId, allLines.length - 1, cursor.itemHashes);
    return;
  }

  const candidates = extractAll(delta) as ExtractedItem[];
  if (!candidates.length) {
    await saveCursor(cursorPath, sessionId, allLines.length - 1, cursor.itemHashes);
    return;
  }

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

  if (!toSave.length) {
    await saveCursor(cursorPath, sessionId, allLines.length - 1, newHashes);
    return;
  }

  await withStore(
    (store) => {
      let saved = 0;
      for (const item of toSave) {
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
      return saved > 0;
    },
    { projectRoot: projectDir },
  );

  await saveCursor(cursorPath, sessionId, allLines.length - 1, newHashes);
}

// ── entry ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const raw = await readStdin();
  const payload = parsePayload(raw);
  const isGemini = Boolean(process.env.GEMINI_PROJECT_DIR);

  await handleStop(payload);

  if (isGemini) {
    process.stdout.write("{}");
  }
}

main().catch(() => process.exit(0));
