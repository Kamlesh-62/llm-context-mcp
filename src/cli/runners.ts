import { fileURLToPath } from "node:url";

import type { ParsedArgs, Runner, RunnerKey, SavedRunner } from "./types.js";
import { errorMessage, isPlainObject } from "./helpers.js";

const SERVER_ENTRY_PATH = fileURLToPath(new URL("../../server.js", import.meta.url));

export const BUILTIN_RUNNERS = {
  npx: {
    label: "Use npx project-memory-mcp (installs on demand)",
    command: "npx",
    args: ["project-memory-mcp"],
  },
  global: {
    label: "Use globally installed project-memory-mcp binary",
    command: "project-memory-mcp",
    args: [],
  },
  node: {
    label: `Use node ${SERVER_ENTRY_PATH}`,
    command: process.execPath,
    args: [SERVER_ENTRY_PATH],
  },
};

export function cloneRunner(key: RunnerKey): Runner {
  const base = BUILTIN_RUNNERS[key as keyof typeof BUILTIN_RUNNERS];
  if (!base) throw new Error(`Unknown runner "${key}".`);
  return {
    command: base.command,
    args: [...base.args],
    label: base.label,
    key,
  };
}

export function createCustomRunner(command: string, args: string[]): Runner {
  return {
    command,
    args: [...args],
    label: "Custom command",
    key: "custom",
  };
}

export function parseArgsInput(raw?: string | null): string[] {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Arguments must be valid JSON or plain text.");
    }
    if (!Array.isArray(parsed)) throw new Error("JSON arguments must be an array.");
    return (parsed as unknown[]).map((value) => `${value}`);
  }

  const tokens = trimmed.match(/"([^"]*)"|'([^']*)'|[^\s]+/g) ?? [];
  return tokens.map((token) => {
    if (token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1);
    if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
    return token;
  });
}

export function buildRunnerFromArgs(args: ParsedArgs): Runner | null {
  if (args.runner) {
    const normalized = args.runner.toLowerCase();
    if (normalized === "custom") {
      if (!args.customCommand) throw new Error("Custom runner requires --command.");
      return createCustomRunner(args.customCommand, parseArgsInput(args.customArgs));
    }
    return cloneRunner(normalized as RunnerKey);
  }
  if (args.customCommand) {
    return createCustomRunner(args.customCommand, parseArgsInput(args.customArgs));
  }
  return null;
}

export function snapshotRunner(runner: Runner): SavedRunner {
  return {
    key: runner.key,
    command: runner.command,
    args: [...runner.args],
  };
}

export function normalizeSavedRunner(value: unknown): SavedRunner | undefined {
  if (!isPlainObject(value)) return undefined;
  const key =
    typeof value.key === "string" && isValidRunnerKey(value.key) ? (value.key as RunnerKey) : undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  const args =
    Array.isArray(value.args) && value.args.every((entry) => typeof entry === "string")
      ? (value.args as string[])
      : undefined;
  if (!key || !command || !args) return undefined;
  return { key, command, args };
}

export function restoreSavedRunner(saved?: SavedRunner): Runner | null {
  if (!saved || !isValidRunnerKey(saved.key)) return null;
  if (saved.key === "custom") return createCustomRunner(saved.command, [...saved.args]);
  return cloneRunner(saved.key);
}

export function isValidRunnerKey(value: string): value is RunnerKey {
  return value === "custom" || Object.prototype.hasOwnProperty.call(BUILTIN_RUNNERS, value);
}

export async function promptCustomRunner(
  rl: import("node:readline/promises").Interface,
  args: ParsedArgs,
  previous?: Runner | null,
): Promise<Runner> {
  let command = args.customCommand ?? previous?.command ?? null;
  while (!command) {
    const suffix = previous?.command ? ` [${previous.command}]` : "";
    const answer = (await rl.question(`Custom command to start the MCP server${suffix}: `)).trim();
    if (answer) { command = answer; break; }
    if (!answer && previous?.command) { command = previous.command; break; }
    console.log("  Command is required.");
  }

  let resolvedArgs: string[] | null = null;
  while (resolvedArgs === null) {
    const defaultArgs =
      previous?.args && previous.args.length ? ` [${previous.args.join(" ")}]` : "";
    const answer =
      args.customArgs ??
      (await rl.question(
        `Arguments (JSON array or space separated, leave blank for none)${defaultArgs}: `,
      ));
    args.customArgs = null;
    if (!answer.trim()) {
      resolvedArgs = previous?.args ? [...previous.args] : [];
      break;
    }
    try {
      resolvedArgs = parseArgsInput(answer);
    } catch (error) {
      console.error(`  ${errorMessage(error)}`);
      resolvedArgs = null;
    }
  }

  return createCustomRunner(command, resolvedArgs);
}

export async function resolveRunner(
  rl: import("node:readline/promises").Interface,
  args: ParsedArgs,
  savedRunner?: SavedRunner,
): Promise<Runner> {
  const preselected = buildRunnerFromArgs(args);
  if (preselected) return preselected;
  const restored = restoreSavedRunner(savedRunner);
  if (args.acceptDefaults) return restored ?? cloneRunner("npx");

  const choices: Array<{ index: string; key: RunnerKey; label: string }> = [
    { index: "1", key: "npx", label: BUILTIN_RUNNERS.npx.label },
    { index: "2", key: "global", label: BUILTIN_RUNNERS.global.label },
    { index: "3", key: "node", label: BUILTIN_RUNNERS.node.label },
    { index: "4", key: "custom", label: "Provide a custom command" },
  ];
  const defaultChoice =
    restored?.key === "global"
      ? "2"
      : restored?.key === "node"
        ? "3"
        : restored?.key === "custom"
          ? "4"
          : "1";

  while (true) {
    console.log("\nHow should we launch the MCP server?");
    choices.forEach((choice) => {
      console.log(`  ${choice.index}) ${choice.label}`);
    });

    const answer =
      (await rl.question(`Select an option [${defaultChoice}]: `)).trim() || defaultChoice;
    const choice = choices.find((entry) => entry.index === answer);
    if (!choice) {
      console.log("  Invalid selection. Try again.");
      continue;
    }

    if (choice.key === "custom") {
      return await promptCustomRunner(
        rl,
        args,
        restored?.key === "custom" ? restored : null,
      );
    }

    return cloneRunner(choice.key);
  }
}
