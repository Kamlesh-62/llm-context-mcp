import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to a compiled hook script. Resolved relative to THIS module so
 * it points at the real installed file — `node_modules/<pkg>/dist/hooks/...`
 * for an npm install, or the local `dist/hooks/...` for a repo/global install.
 * This is why the hook command must not use `$CLAUDE_PROJECT_DIR`, which only
 * works when the package lives inside the project.
 */
export function resolveHookScriptPath(scriptName: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/src/cli -> dist/hooks
  return path.resolve(here, "..", "..", "hooks", `${scriptName}.js`);
}

const HOOK_MARKER = "auto-memory.js";

type ClaudeHookCommand = { type: "command"; command: string; async?: boolean; timeout?: number };
type ClaudeHookGroup = { hooks: ClaudeHookCommand[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function groupReferencesOurHook(group: unknown): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some(
    (h) => isRecord(h) && typeof h.command === "string" && h.command.includes(HOOK_MARKER),
  );
}

/**
 * Install (or refresh) a Claude Code hook for `event` that runs our auto-memory
 * script in `mode`. Writes to `<projectRoot>/.claude/settings.json`, merging
 * into any existing hooks and never clobbering unrelated entries. Idempotent:
 * a re-run updates our hook's path in place rather than appending a duplicate.
 *
 * @returns the settings.json path written.
 */
export async function installClaudeHook(
  projectRoot: string,
  event: "Stop" | "PostToolUse",
  mode: "stop" | "posttooluse",
): Promise<string> {
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");

  let settings: Record<string, unknown> = {};
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (isRecord(parsed)) settings = parsed;
  } catch {
    // missing or unparseable — start from an empty settings object
  }

  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const groups: unknown[] = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];

  const ourGroup: ClaudeHookGroup = {
    hooks: [
      {
        type: "command",
        command: `node "${resolveHookScriptPath("auto-memory")}" ${mode}`,
        async: true,
        timeout: 15,
      },
    ],
  };

  // Replace an existing group that already points at our hook; otherwise append.
  const existingIndex = groups.findIndex(groupReferencesOurHook);
  if (existingIndex >= 0) {
    groups[existingIndex] = ourGroup;
  } else {
    groups.push(ourGroup);
  }

  hooks[event] = groups;
  settings.hooks = hooks;

  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

/** Install the session-end (Stop) auto-save hook. */
export function installClaudeStopHook(projectRoot: string): Promise<string> {
  return installClaudeHook(projectRoot, "Stop", "stop");
}

/** Install the real-time (PostToolUse) incremental-capture hook. */
export function installClaudePostToolUseHook(projectRoot: string): Promise<string> {
  return installClaudeHook(projectRoot, "PostToolUse", "posttooluse");
}

/** Whether the project's Claude settings already register our hook for `event`. */
export async function claudeHookInstalled(
  projectRoot: string,
  event: "Stop" | "PostToolUse" = "Stop",
): Promise<boolean> {
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.hooks)) return false;
    const groups = parsed.hooks[event];
    return Array.isArray(groups) && groups.some(groupReferencesOurHook);
  } catch {
    return false;
  }
}

/** Back-compat alias — whether the Stop hook is installed. */
export function claudeStopHookInstalled(projectRoot: string): Promise<boolean> {
  return claudeHookInstalled(projectRoot, "Stop");
}

/**
 * Ensure Codex's `notify` program points at our capture bridge in
 * `~/.codex/config.toml`. Appends the key only when absent — an existing
 * `notify` is left alone (we won't silently rewrite a user's config) and the
 * recommended value is returned for the caller to surface.
 *
 * @returns what happened, plus the recommended value.
 */
export async function installCodexNotify(): Promise<{
  status: "added" | "exists";
  configPath: string;
  recommended: string;
}> {
  const configPath = path.join(homedir(), ".codex", "config.toml");
  const notifyScript = resolveHookScriptPath("codex-notify");
  const recommended = `notify = ["node", ${JSON.stringify(notifyScript)}]`;

  let contents = "";
  try {
    contents = await readFile(configPath, "utf8");
  } catch {
    // file does not exist yet — will be created
  }

  if (/^\s*notify\s*=/m.test(contents)) {
    return { status: "exists", configPath, recommended };
  }

  const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  const block = `${prefix}\n# Added by project-memory-mcp: auto-capture memory from Codex sessions\n${recommended}\n`;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, contents + block);
  return { status: "added", configPath, recommended };
}
