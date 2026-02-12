#!/usr/bin/env node
/**
 * Codex CLI notify hook.
 * Reads Codex notification payload from stdin, locates the transcript/history
 * file, and forwards a normalized payload to hooks/auto-memory.mjs.
 *
 * Usage in ~/.codex/config.toml:
 * notify = ["node", "/path/to/project-memory-mcp-js/hooks/codex-notify.mjs"]
 *
 * Optional args:
 *   --history <path>      Explicit history/transcript file path
 *   --project-dir <path>  Explicit project directory
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

function parseArgs(argv) {
  const args = { historyPath: null, projectDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--history" && argv[i + 1]) {
      args.historyPath = argv[++i];
    } else if (a === "--project-dir" && argv[i + 1]) {
      args.projectDir = argv[++i];
    }
  }
  return args;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function pickFirst(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function defaultHistoryPath() {
  const home = process.env.CODEX_HOME || `${os.homedir()}/.codex`;
  return `${home}/history.jsonl`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const projectDir =
    args.projectDir ||
    pickFirst(
      payload?.cwd,
      payload?.workdir,
      payload?.workspace_root,
      payload?.workspaceRoot,
      payload?.repo_path,
      payload?.repoPath,
    ) ||
    process.cwd();

  const historyPath =
    args.historyPath ||
    pickFirst(
      payload?.transcript_path,
      payload?.transcriptPath,
      payload?.history_path,
      payload?.historyPath,
      payload?.history_file,
      payload?.historyFile,
      payload?.history,
    ) ||
    defaultHistoryPath();

  if (!historyPath || !(await exists(historyPath))) return;

  const sessionId =
    pickFirst(payload?.session_id, payload?.sessionId, payload?.thread_id, payload?.threadId) ||
    "unknown";

  const autoSavePayload = {
    session_id: sessionId,
    transcript_path: historyPath,
    cwd: projectDir,
  };

  const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
  const autoSavePath = resolve(ROOT, "hooks", "auto-memory.mjs");

  const child = spawn(
    "node",
    [autoSavePath, "stop"],
    {
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        ...process.env,
        CODEX_PROJECT_DIR: projectDir,
      },
    },
  );

  child.stdin.write(JSON.stringify(autoSavePayload));
  child.stdin.end();
}

main().catch(() => process.exit(0));
