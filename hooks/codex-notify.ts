#!/usr/bin/env node
/**
 * Codex CLI notify hook.
 * Reads Codex notification payload from stdin, locates the transcript/history
 * file, and forwards a normalized payload to dist/hooks/auto-memory.js.
 *
 * Usage in ~/.codex/config.toml:
 * notify = ["node", "/path/to/project-memory-mcp-js/dist/hooks/codex-notify.js"]
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

function parseArgs(argv: string[]): { historyPath: string | null; projectDir: string | null } {
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

async function readStdin(): Promise<string> {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function pickFirst(...values: Array<string | undefined | null>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function defaultHistoryPath(): string {
  const home = process.env.CODEX_HOME || `${os.homedir()}/.codex`;
  return `${home}/history.jsonl`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const projectDir =
    args.projectDir ||
    pickFirst(
      payload?.cwd as string | undefined,
      payload?.workdir as string | undefined,
      payload?.workspace_root as string | undefined,
      payload?.workspaceRoot as string | undefined,
      payload?.repo_path as string | undefined,
      payload?.repoPath as string | undefined,
    ) ||
    process.cwd();

  const historyPath =
    args.historyPath ||
    pickFirst(
      payload?.transcript_path as string | undefined,
      payload?.transcriptPath as string | undefined,
      payload?.history_path as string | undefined,
      payload?.historyPath as string | undefined,
      payload?.history_file as string | undefined,
      payload?.historyFile as string | undefined,
      payload?.history as string | undefined,
    ) ||
    defaultHistoryPath();

  if (!historyPath || !(await exists(historyPath))) return;

  const sessionId =
    pickFirst(
      payload?.session_id as string | undefined,
      payload?.sessionId as string | undefined,
      payload?.thread_id as string | undefined,
      payload?.threadId as string | undefined,
    ) || "unknown";

  const autoSavePayload = {
    session_id: sessionId,
    transcript_path: historyPath,
    cwd: projectDir,
  };

  const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
  const autoSavePath = resolve(ROOT, "hooks", "auto-memory.js");

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
