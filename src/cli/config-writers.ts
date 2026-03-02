import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import type { Runner } from "./types.js";
import { isPlainObject, loadJson, resolvePath, formatCommand } from "./helpers.js";

const CLAUDE_CONFIG_OVERRIDE =
  process.env.PROJECT_MEMORY_MCP_CLAUDE_CONFIG_PATH ?? process.env.CLAUDE_CONFIG_PATH ?? null;

export const CLAUDE_CONFIG_PATH = CLAUDE_CONFIG_OVERRIDE
  ? resolvePath(CLAUDE_CONFIG_OVERRIDE)
  : path.join(homedir(), ".claude.json");

export async function configureClaude({
  projectRoot,
  runner,
  serverId,
}: {
  projectRoot: string;
  runner: Runner;
  serverId: string;
}): Promise<void> {
  const { data, raw } = await loadJson(CLAUDE_CONFIG_PATH);
  const config = isPlainObject(data) ? data : {};
  if (!isPlainObject(config.mcpServers)) {
    config.mcpServers = {};
  }

  config.mcpServers[serverId] = {
    command: runner.command,
    args: runner.args,
    cwd: projectRoot,
  };

  await mkdir(path.dirname(CLAUDE_CONFIG_PATH), { recursive: true });
  if (raw !== null) {
    await writeFile(`${CLAUDE_CONFIG_PATH}.bak`, raw);
    console.log(`  Backup written to ${CLAUDE_CONFIG_PATH}.bak`);
  }

  await writeFile(CLAUDE_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`  Updated ${CLAUDE_CONFIG_PATH}`);
}

export async function checkExistingClaudeEntry(
  serverId: string,
): Promise<{ exists: boolean; command?: string; args?: string[] }> {
  const { data } = await loadJson(CLAUDE_CONFIG_PATH);
  if (!isPlainObject(data) || !isPlainObject(data.mcpServers)) {
    return { exists: false };
  }
  const entry = data.mcpServers[serverId];
  if (!isPlainObject(entry)) {
    return { exists: false };
  }
  const command = typeof entry.command === "string" ? entry.command : undefined;
  const args = Array.isArray(entry.args) ? entry.args.map(String) : undefined;
  return { exists: true, command, args };
}

export async function configureGemini({
  projectRoot,
  runner,
  serverId,
}: {
  projectRoot: string;
  runner: Runner;
  serverId: string;
}): Promise<void> {
  await runCommand("gemini", ["mcp", "remove", serverId], {
    cwd: projectRoot,
    ignoreExit: true,
  });
  const args = ["mcp", "add", serverId, runner.command, ...runner.args, "--trust"];
  await runCommand("gemini", args, { cwd: projectRoot });
}

export async function configureCodex({
  projectRoot,
  runner,
  serverId,
}: {
  projectRoot: string;
  runner: Runner;
  serverId: string;
}): Promise<void> {
  await runCommand("codex", ["mcp", "remove", serverId], {
    cwd: projectRoot,
    ignoreExit: true,
  });
  const args = ["mcp", "add", serverId, runner.command, ...runner.args];
  await runCommand("codex", args, { cwd: projectRoot });
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; ignoreExit?: boolean } = {},
): Promise<void> {
  const { cwd, ignoreExit = false } = options;
  console.log(`  $ ${formatCommand(command, args)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`Command "${command}" not found on PATH.`));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0 || (code !== 0 && ignoreExit)) {
        resolve();
      } else {
        reject(new Error(`${formatCommand(command, args)} exited with code ${code}`));
      }
    });
  });
}
