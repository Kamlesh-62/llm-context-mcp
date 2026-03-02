import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { CliSelection, ParsedArgs, ProjectDefaults, SavedRunner, StepResult } from "./types.js";

export const SERVER_ID_PATTERN = /^[a-z0-9-]{3,32}$/;
export const CLI_LABELS = {
  claude: "Claude Code",
  gemini: "Gemini CLI",
  codex: "Codex CLI",
};
const PROJECT_CONFIG_FILENAME = "memory-mcp.json";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolvePath(input: string): string {
  const expanded = expandHome(input);
  return path.resolve(expanded);
}

export function expandHome(value: string): string {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export async function assertDirectory(candidate: string): Promise<void> {
  const stats = await stat(candidate).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Directory "${candidate}" does not exist.`);
    }
    throw error;
  });

  if (!stats.isDirectory()) {
    throw new Error(`Path "${candidate}" is not a directory.`);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function loadJson(filePath: string): Promise<{ data: unknown; raw: string | null }> {
  try {
    const raw = await readFile(filePath, "utf8");
    return { data: JSON.parse(raw), raw };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { data: {}, raw: null };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export function validateServerId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SERVER_ID_PATTERN.test(normalized)) {
    throw new Error("Server ID must be 3-32 chars using lowercase letters, numbers, or hyphens.");
  }
  return normalized;
}

export function suggestServerId(projectRoot: string): string | null {
  const fallback = path.basename(projectRoot).toLowerCase();
  const normalized = fallback.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const truncated = normalized.slice(0, 32);
  if (SERVER_ID_PATTERN.test(truncated)) return truncated;
  return null;
}

function getProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".ai", PROJECT_CONFIG_FILENAME);
}

export async function loadProjectDefaults(projectRoot: string): Promise<ProjectDefaults> {
  const filePath = getProjectConfigPath(projectRoot);
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!isPlainObject(data)) return {};
    const defaults: ProjectDefaults = {};
    if (typeof data.serverId === "string" && SERVER_ID_PATTERN.test(data.serverId)) {
      defaults.serverId = data.serverId;
    }
    if (data.runner) {
      const { normalizeSavedRunner } = await import("./runners.js");
      const runner = normalizeSavedRunner(data.runner);
      if (runner) defaults.runner = runner;
    }
    return defaults;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export async function saveProjectDefaults(
  projectRoot: string,
  defaults: ProjectDefaults,
): Promise<void> {
  const filePath = getProjectConfigPath(projectRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(defaults, null, 2)}\n`);
}

export async function askYesNo(
  rl: import("node:readline/promises").Interface,
  prompt: string,
  defaultValue: boolean,
  args: ParsedArgs,
): Promise<boolean> {
  if (args.acceptDefaults) return defaultValue;
  const suffix = defaultValue ? " (Y/n): " : " (y/N): ";
  const answer = (await rl.question(`${prompt.replace(/[: ]+$/, "")}${suffix}`))
    .trim()
    .toLowerCase();
  if (!answer) return defaultValue;
  if (["y", "yes"].includes(answer)) return true;
  if (["n", "no"].includes(answer)) return false;
  console.log("  Please answer y or n.");
  return askYesNo(rl, prompt, defaultValue, args);
}

export function listSelectedClis(selection: CliSelection): string {
  const names = [];
  if (selection.claude) names.push(CLI_LABELS.claude);
  if (selection.gemini) names.push(CLI_LABELS.gemini);
  if (selection.codex) names.push(CLI_LABELS.codex);
  return names.join(", ");
}

export async function executeStep(label: string, task: () => Promise<void>): Promise<StepResult> {
  console.log(`\n${label}`);
  try {
    await task();
    console.log(`  ✔ ${label} configured`);
    return { label, ok: true };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`  ✖ ${label} failed: ${err.message}`);
    return { label, ok: false, error: err };
  }
}

export function formatCommand(command: string, args: Array<string | undefined> = []): string {
  const parts = [command, ...(args ?? [])]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => part.toString());
  return parts
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ");
}
