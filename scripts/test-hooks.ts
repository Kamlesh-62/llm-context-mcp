#!/usr/bin/env node
/**
 * End-to-end sanity tests for Claude/Gemini/Codex hook chain.
 * Creates a small transcript, runs each hook entrypoint, and reports results.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const TMP_DIR = "/tmp";
const TRANSCRIPT = join(TMP_DIR, "pm-hook-test.jsonl");
const CURSOR = join(ROOT, ".ai", ".auto-save-cursor.json");
const MEMORY = join(ROOT, ".ai", "memory.json");

function now(): string {
  return new Date().toISOString();
}

async function ensureAiDir(): Promise<void> {
  await mkdir(join(ROOT, ".ai"), { recursive: true });
}

async function writeTranscript(): Promise<void> {
  const lines = [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", id: "1", input: { command: "node -v" } }],
      },
    },
    {
      type: "user",
      content: [{ type: "tool_result", tool_use_id: "1", content: "v20.11.0" }],
    },
    {
      type: "assistant",
      message: { role: "assistant", content: "Done." },
    },
  ];
  const raw = lines.map((l) => JSON.stringify(l)).join("\n");
  await writeFile(TRANSCRIPT, raw);
}

async function readMemory(): Promise<any> {
  const raw = await readFile(MEMORY, "utf8");
  return JSON.parse(raw);
}

async function readCursor(): Promise<any> {
  const raw = await readFile(CURSOR, "utf8");
  return JSON.parse(raw);
}

function runNode(
  scriptPath: string,
  input: string,
  env: Record<string, string> = {},
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.stdin.write(input);
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

async function runClaude(): Promise<{ code: number | null; stderr: string }> {
  const payload = JSON.stringify({
    session_id: `claude-test-${now()}`,
    transcript_path: TRANSCRIPT,
    cwd: ROOT,
  });
  return runNode(join(ROOT, "dist", "hooks", "auto-save.js"), payload, {
    CLAUDE_PROJECT_DIR: ROOT,
  });
}

async function runGemini(): Promise<{ code: number | null; stderr: string }> {
  const payload = JSON.stringify({
    session_id: `gemini-test-${now()}`,
    transcript_path: TRANSCRIPT,
    cwd: ROOT,
  });
  return runNode(join(ROOT, "dist", "hooks", "auto-save.js"), payload, {
    GEMINI_PROJECT_DIR: ROOT,
  });
}

async function runCodex(): Promise<{ code: number | null; stderr: string }> {
  const payload = JSON.stringify({
    session_id: `codex-test-${now()}`,
    cwd: ROOT,
    history_path: TRANSCRIPT,
  });
  return runNode(join(ROOT, "dist", "hooks", "codex-notify.js"), payload);
}

function printResult(name: string, ok: boolean, details = ""): void {
  const status = ok ? "PASS" : "FAIL";
  const line = `${status} ${name}${details ? ` - ${details}` : ""}`;
  process.stdout.write(line + "\n");
}

async function main(): Promise<void> {
  await ensureAiDir();
  await writeTranscript();

  const claude = await runClaude();
  const cursorAfterClaude = await readCursor();
  printResult(
    "Claude hook",
    claude.code === 0 &&
      cursorAfterClaude.sessionId?.startsWith("claude-test-") &&
      cursorAfterClaude.lastLineIndex === 2,
    claude.code !== 0 ? `exit ${claude.code}` : "cursor not updated",
  );

  const gemini = await runGemini();
  const cursorAfterGemini = await readCursor();
  printResult(
    "Gemini hook",
    gemini.code === 0 &&
      cursorAfterGemini.sessionId?.startsWith("gemini-test-") &&
      cursorAfterGemini.lastLineIndex === 2,
    gemini.code !== 0 ? `exit ${gemini.code}` : "cursor not updated",
  );

  const codex = await runCodex();
  const cursorAfterCodex = await readCursor();
  printResult(
    "Codex hook",
    codex.code === 0 &&
      cursorAfterCodex.sessionId?.startsWith("codex-test-") &&
      cursorAfterCodex.lastLineIndex === 2,
    codex.code !== 0 ? `exit ${codex.code}` : "cursor not updated",
  );

  if (claude.stderr) printResult("Claude stderr", false, claude.stderr.trim());
  if (gemini.stderr) printResult("Gemini stderr", false, gemini.stderr.trim());
  if (codex.stderr) printResult("Codex stderr", false, codex.stderr.trim());

  // Touch cursor to show it's created
  try {
    await readFile(CURSOR, "utf8");
    printResult("Cursor file", true, CURSOR);
  } catch {
    printResult("Cursor file", false, "missing");
  }

  try {
    const data = await readMemory();
    const found = data.items.some(
      (i) =>
        (i.tags ?? []).includes("auto-hook") &&
        typeof i.title === "string" &&
        i.title.toLowerCase().includes("node version"),
    );
    printResult("Auto-hook item", found, found ? "node version" : "missing");
  } catch {
    printResult("Auto-hook item", false, "memory read failed");
  }
}

main().catch((err) => {
  printResult("Test runner", false, err?.message || "unknown error");
  process.exit(1);
});
