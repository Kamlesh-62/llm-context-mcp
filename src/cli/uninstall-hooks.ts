import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { findProjectRoot } from "../runtime.js";

/**
 * Permanently remove the auto-save hooks this tool installs, reversing what
 * `setup` wires up. Symmetric to `src/cli/hooks-install.ts`:
 *
 *   - Claude   `<project>/.claude/settings.json`  — Stop + PostToolUse groups
 *   - Codex    `~/.codex/config.toml`             — the `notify` bridge
 *   - Codex    `<project>/.codex/hooks.json`      — PostToolUse groups
 *
 * Only entries that point at our own hook scripts are touched; unrelated hooks
 * and config are left exactly as they were. For a temporary silence without
 * removing anything, set `MEMORY_AUTOSAVE=off` instead.
 */

const HOOK_MARKER = "auto-memory.js";
const NOTIFY_MARKER = "codex-notify.js";

type CliFilter = { claude: boolean; codex: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function groupReferences(group: unknown, marker: string): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some(
    (h) => isRecord(h) && typeof h.command === "string" && h.command.includes(marker),
  );
}

function codexHome(): string {
  const env = process.env.CODEX_HOME?.trim();
  return env ? env : path.join(homedir(), ".codex");
}

/** Drop our hook groups from a Claude/Codex `hooks` object's event array. */
function stripEvent(hooks: Record<string, unknown>, event: string): number {
  if (!Array.isArray(hooks[event])) return 0;
  const before = hooks[event] as unknown[];
  const after = before.filter((g) => !groupReferences(g, HOOK_MARKER));
  const removed = before.length - after.length;
  if (after.length === 0) delete hooks[event];
  else hooks[event] = after;
  return removed;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function uninstallClaude(projectRoot: string): Promise<string[]> {
  const out: string[] = [];
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  const settings = await readJson(settingsPath);
  if (!settings || !isRecord(settings.hooks)) {
    out.push("Claude:  no hooks found — nothing to remove.");
    return out;
  }
  const hooks = settings.hooks;
  const removed = stripEvent(hooks, "Stop") + stripEvent(hooks, "PostToolUse");
  if (removed === 0) {
    out.push("Claude:  no auto-memory hooks found — nothing to remove.");
    return out;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  out.push(`Claude:  removed ${removed} hook group(s) from ${settingsPath}`);
  return out;
}

async function uninstallCodex(projectRoot: string): Promise<string[]> {
  const out: string[] = [];

  // 1. project-local PostToolUse hooks.json
  const hooksPath = path.join(projectRoot, ".codex", "hooks.json");
  const hooksDoc = await readJson(hooksPath);
  if (hooksDoc && Array.isArray(hooksDoc.PostToolUse)) {
    const removed = stripEvent(hooksDoc, "PostToolUse");
    if (removed > 0) {
      await writeFile(hooksPath, `${JSON.stringify(hooksDoc, null, 2)}\n`);
      out.push(`Codex:   removed ${removed} PostToolUse hook(s) from ${hooksPath}`);
    }
  }

  // 2. the notify bridge in ~/.codex/config.toml
  const configPath = path.join(codexHome(), "config.toml");
  let contents = "";
  try {
    contents = await readFile(configPath, "utf8");
  } catch {
    // no config — nothing to strip
  }
  if (contents) {
    const lines = contents.split("\n");
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      const isNotify = /^\s*notify\s*=/.test(line) && line.includes(NOTIFY_MARKER);
      if (isNotify) {
        removed++;
        // also drop our own comment line directly above it, if present
        if (kept.length > 0 && kept[kept.length - 1].includes("Added by context-bridge-mcp")) {
          kept.pop();
        }
        continue;
      }
      kept.push(line);
    }
    if (removed > 0) {
      await writeFile(configPath, kept.join("\n"));
      out.push(`Codex:   removed the notify bridge from ${configPath}`);
    }
  }

  if (out.length === 0) out.push("Codex:   no auto-memory hooks found — nothing to remove.");
  return out;
}

function parseCliFilter(argv: string[]): CliFilter {
  const idx = argv.indexOf("--cli");
  if (idx === -1 || !argv[idx + 1]) return { claude: true, codex: true };
  const set = new Set(
    argv[idx + 1]
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return { claude: set.has("claude"), codex: set.has("codex") };
}

export async function runUninstallHooks(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "Usage: context-bridge-mcp uninstall-hooks [--cli claude,codex] [--project <dir>]",
        "",
        "Permanently removes the auto-save hooks installed by `setup`.",
        "Only hooks pointing at this tool's own scripts are removed.",
        "",
        "To silence auto-save temporarily instead, set MEMORY_AUTOSAVE=off.",
      ].join("\n"),
    );
    return 0;
  }

  const projIdx = argv.findIndex((a) => a === "--project" || a === "-p");
  const projectRoot =
    projIdx >= 0 && argv[projIdx + 1] ? argv[projIdx + 1] : await findProjectRoot();
  const filter = parseCliFilter(argv);

  console.log(`\nRemoving auto-save hooks`);
  console.log(`Project: ${projectRoot}\n`);

  const lines: string[] = [];
  if (filter.claude) lines.push(...(await uninstallClaude(projectRoot)));
  if (filter.codex) lines.push(...(await uninstallCodex(projectRoot)));
  for (const l of lines) console.log(l);

  console.log(
    "\nDone. MCP tools (memory_save, etc.) still work — only auto-capture is removed." +
      "\nRe-enable any time with `context-bridge-mcp setup`.",
  );
  return 0;
}
