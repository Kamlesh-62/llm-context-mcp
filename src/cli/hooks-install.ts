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

/** Codex's config directory, honoring the CODEX_HOME env var like Codex does. */
function codexHome(): string {
  const env = process.env.CODEX_HOME?.trim();
  return env ? env : path.join(homedir(), ".codex");
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
 * Install (or refresh) the Codex real-time PostToolUse hook so memory is
 * captured incrementally during a session. Writes `<projectRoot>/.codex/
 * hooks.json` (JSON merge, idempotent) and ensures `[features] hooks = true`
 * in `~/.codex/config.toml`.
 *
 * The feature flag is only appended when no `[features]` table exists — if one
 * is already present, we don't risk editing it and report `manual` so the
 * caller can tell the user to add the flag.
 */
export async function installCodexPostToolUseHook(projectRoot: string): Promise<{
  hooksPath: string;
  configPath: string;
  featureFlag: "added" | "present" | "manual";
}> {
  const hooksPath = path.join(projectRoot, ".codex", "hooks.json");
  const command = `node "${resolveHookScriptPath("auto-memory")}" posttooluse`;

  let hooksDoc: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(hooksPath, "utf8"));
    if (isRecord(parsed)) hooksDoc = parsed;
  } catch {
    // missing or unparseable — start fresh
  }

  const groups: unknown[] = Array.isArray(hooksDoc.PostToolUse)
    ? (hooksDoc.PostToolUse as unknown[])
    : [];
  const ourGroup = { hooks: [{ type: "command", command, timeout: 15 }] };
  const existingIndex = groups.findIndex(groupReferencesOurHook);
  if (existingIndex >= 0) groups[existingIndex] = ourGroup;
  else groups.push(ourGroup);
  hooksDoc.PostToolUse = groups;

  await mkdir(path.dirname(hooksPath), { recursive: true });
  await writeFile(hooksPath, `${JSON.stringify(hooksDoc, null, 2)}\n`);

  const featureFlag = await ensureCodexFeaturesFlag();
  return { hooksPath, configPath: path.join(codexHome(), "config.toml"), featureFlag };
}

/** Ensure `[features] hooks = true` in Codex's config.toml (conservatively). */
async function ensureCodexFeaturesFlag(): Promise<"added" | "present" | "manual"> {
  const configPath = path.join(codexHome(), "config.toml");
  let contents = "";
  try {
    contents = await readFile(configPath, "utf8");
  } catch {
    // no config yet
  }

  if (/^\s*hooks\s*=\s*true/m.test(contents)) return "present";
  if (/^\s*\[features\]/m.test(contents)) return "manual"; // don't edit an existing table

  const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  const block = `${prefix}\n[features]\nhooks = true\n`;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, contents + block);
  return "added";
}

/** Whether the project's Codex hooks.json registers our PostToolUse hook. */
export async function codexPostToolUseHookInstalled(projectRoot: string): Promise<boolean> {
  const hooksPath = path.join(projectRoot, ".codex", "hooks.json");
  try {
    const parsed = JSON.parse(await readFile(hooksPath, "utf8"));
    if (!isRecord(parsed)) return false;
    const groups = parsed.PostToolUse;
    return Array.isArray(groups) && groups.some(groupReferencesOurHook);
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
  const configPath = path.join(codexHome(), "config.toml");
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
