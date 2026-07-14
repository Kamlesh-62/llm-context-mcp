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
 * Install (or refresh) the project's Claude Code `Stop` hook so memory is
 * auto-captured at the end of a session. Writes to `<projectRoot>/.claude/
 * settings.json`, merging into any existing hooks and never clobbering unrelated
 * entries. Idempotent: a re-run updates our hook's path in place rather than
 * appending a duplicate.
 *
 * @returns the settings.json path written.
 */
export async function installClaudeStopHook(projectRoot: string): Promise<string> {
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
  const stopGroups: unknown[] = Array.isArray(hooks.Stop) ? hooks.Stop : [];

  const ourGroup: ClaudeHookGroup = {
    hooks: [
      {
        type: "command",
        command: `node "${resolveHookScriptPath("auto-memory")}" stop`,
        async: true,
        timeout: 15,
      },
    ],
  };

  // Replace an existing group that already points at our hook; otherwise append.
  const existingIndex = stopGroups.findIndex(groupReferencesOurHook);
  if (existingIndex >= 0) {
    stopGroups[existingIndex] = ourGroup;
  } else {
    stopGroups.push(ourGroup);
  }

  hooks.Stop = stopGroups;
  settings.hooks = hooks;

  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

/** Whether the project's Claude settings already register our Stop hook. */
export async function claudeStopHookInstalled(projectRoot: string): Promise<boolean> {
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.hooks)) return false;
    const stop = parsed.hooks.Stop;
    return Array.isArray(stop) && stop.some(groupReferencesOurHook);
  } catch {
    return false;
  }
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
