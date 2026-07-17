#!/usr/bin/env node
/**
 * Auto-memory hook. Captures transcript takeaways into project memory using
 * heuristic extractors.
 *
 * Modes (argv[2]):
 *   stop        — session end: sweep the remaining transcript delta.
 *   posttooluse — real-time: capture incrementally after each tool call, so a
 *                 crashed/abandoned session still leaves its memory behind.
 * Both share one cursor + hash dedup, so running both never double-saves.
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

// ── capture handler ──────────────────────────────────────────────────────────

async function capture(
  payload: Record<string, unknown>,
  opts: { minAssistantMessages: number },
): Promise<void> {
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
  if (countAssistantMessages(delta) < opts.minAssistantMessages) {
    // Not enough new signal yet. Do NOT advance the cursor for real-time
    // (posttooluse) passes, so the delta keeps accumulating until a later pass
    // (or Stop) crosses the threshold; only Stop-scale passes advance on skip.
    if (opts.minAssistantMessages >= 2) {
      await saveCursor(cursorPath, sessionId, allLines.length - 1, cursor.itemHashes);
    }
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

/**
 * Whether auto-capture is switched off via the `MEMORY_AUTOSAVE` env var.
 * Accepts `off`/`0`/`false`/`no`/`disabled` (case-insensitive). This is the
 * temporary kill-switch: the hook stays installed but early-exits, so a user
 * can silence auto-save for a shell/session without editing any config. For a
 * permanent removal, use `context-bridge-mcp uninstall-hooks`.
 */
function autosaveDisabled(): boolean {
  const v = process.env.MEMORY_AUTOSAVE?.trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "no" || v === "disabled";
}

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? "stop").toLowerCase();
  const raw = await readStdin();
  const payload = parsePayload(raw);
  const isGemini = Boolean(process.env.GEMINI_PROJECT_DIR);

  if (autosaveDisabled()) {
    // Kill-switch on — capture nothing, but still emit Gemini's expected reply.
    if (isGemini) process.stdout.write("{}");
    return;
  }

  // Real-time passes fire often and need a lower bar; Stop is the final sweep.
  const minAssistantMessages = mode === "posttooluse" ? 1 : 2;
  await capture(payload, { minAssistantMessages });

  if (isGemini) {
    process.stdout.write("{}");
  }
}

main().catch(() => process.exit(0));
