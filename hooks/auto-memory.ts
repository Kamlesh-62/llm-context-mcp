#!/usr/bin/env node
/**
 * Auto-memory hook (Stop / SessionEnd only):
 * Captures transcript takeaways into project memory using heuristic extractors.
 */

import { join } from "node:path";

import { loadCursor, saveCursor } from "./cursor.js";
import { extractAll } from "./extractors.js";
import {
  countAssistantMessages,
  readStdin,
  readTranscriptLines,
  saveExtractedItems,
} from "./shared.js";

// ── utility helpers ───────────────────────────────────────────────────────────

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

  const candidates = extractAll(delta);
  if (!candidates.length) {
    await saveCursor(cursorPath, sessionId, allLines.length - 1, cursor.itemHashes);
    return;
  }

  const { newHashes } = await saveExtractedItems({ projectDir, candidates, cursor });
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
