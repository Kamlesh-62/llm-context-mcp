#!/usr/bin/env node
/**
 * Auto-save hook for Claude Code.
 * Fires on the "Stop" event, reads new transcript lines, extracts facts
 * via heuristics, and persists them to the project memory store.
 *
 * Runs async & in the background — user sees nothing.
 * Never throws to the caller; exits silently on any error.
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
    const candidates = extractAll(delta);
    if (candidates.length === 0) return;

    // 6. Dedup, persist, and update cursor
    const { newHashes } = await saveExtractedItems({ projectDir, candidates, cursor });
    await saveCursor(cursorPath, sessionId, allLines.length - 1, newHashes);
  } finally {
    if (isGemini) {
      process.stdout.write("{}");
    }
  }
}

// ── entry ────────────────────────────────────────────────────────────────────

main().catch(() => process.exit(0));
