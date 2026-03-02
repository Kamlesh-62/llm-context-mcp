import process from "node:process";

import type { CliSelection, CommonArgs } from "./types.js";
import { tryParseCommonToken, requireValue } from "./args.js";
import { restoreSavedRunner, cloneRunner } from "./runners.js";
import { configureClaude, configureGemini, configureCodex } from "./config-writers.js";
import {
  errorMessage,
  resolvePath,
  assertDirectory,
  listSelectedClis,
  formatCommand,
  executeStep,
  loadProjectDefaults,
} from "./helpers.js";

type ParsedSwitchArgs = CommonArgs;

function parseSwitchArgs(argv: string[]): ParsedSwitchArgs {
  const result: ParsedSwitchArgs = {
    projectRoot: null,
    cliFilters: null,
    acceptDefaults: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const newI = tryParseCommonToken(argv, i, result);
    if (newI !== null) {
      i = newI;
      continue;
    }
    throw new Error(`Unknown switch option "${argv[i]}". Run with --help for usage.`);
  }

  return result;
}

function printSwitchHelp(): void {
  console.log(
    [
      "Usage: project-memory-mcp switch [options]",
      "",
      "Re-applies saved server configuration to selected CLIs without interactive prompts.",
      "Reads configuration from .ai/memory-mcp.json (created by 'setup').",
      "",
      "Options:",
      "  --project <path>     Project directory (default: current directory).",
      "  --cli <list>         Comma-separated subset of CLIs (claude,gemini,codex).",
      "  -y, --yes            Accept defaults without interactive prompts.",
      "  -h, --help           Show this help text.",
      "",
      "Examples:",
      "  project-memory-mcp switch",
      "  project-memory-mcp switch --project ~/code/api --cli claude",
    ].join("\n"),
  );
}

export async function runSwitch(argv: string[] = []): Promise<number> {
  let parsedArgs: ParsedSwitchArgs;
  try {
    parsedArgs = parseSwitchArgs(argv);
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }

  if (parsedArgs.help) {
    printSwitchHelp();
    return 0;
  }

  const projectRoot = resolvePath(parsedArgs.projectRoot ?? process.cwd());
  try {
    await assertDirectory(projectRoot);
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }

  const defaults = await loadProjectDefaults(projectRoot);
  if (!defaults.serverId || !defaults.runner) {
    console.error(
      `No saved configuration found at ".ai/memory-mcp.json". Run \`project-memory-mcp setup\` first.`,
    );
    return 1;
  }

  const runner = restoreSavedRunner(defaults.runner) ?? cloneRunner("npx");
  const selection: CliSelection = parsedArgs.cliFilters?.length
    ? {
        claude: parsedArgs.cliFilters.includes("claude"),
        gemini: parsedArgs.cliFilters.includes("gemini"),
        codex: parsedArgs.cliFilters.includes("codex"),
      }
    : { claude: true, gemini: true, codex: true };

  if (!selection.claude && !selection.gemini && !selection.codex) {
    console.log("No CLIs selected. Nothing to configure.");
    return 0;
  }

  const serverId = defaults.serverId;
  console.log("\nApplying saved configuration:");
  console.log(`  Project root: ${projectRoot}`);
  console.log(`  Server ID: ${serverId}`);
  console.log(`  Server command: ${formatCommand(runner.command, runner.args)}`);
  console.log(`  Target CLIs: ${listSelectedClis(selection)}`);

  const steps = [];
  if (selection.claude) {
    steps.push(
      await executeStep("Claude Code", () => configureClaude({ projectRoot, runner, serverId })),
    );
  }
  if (selection.gemini) {
    steps.push(
      await executeStep("Gemini CLI", () => configureGemini({ projectRoot, runner, serverId })),
    );
  }
  if (selection.codex) {
    steps.push(
      await executeStep("Codex CLI", () => configureCodex({ projectRoot, runner, serverId })),
    );
  }

  const failures = steps.filter((step) => !step.ok);
  if (failures.length === 0) {
    console.log("\nAll selected CLIs are configured.");
    return 0;
  }

  console.log("\nFinished with errors:");
  failures.forEach((failure) => {
    console.log(`  - ${failure.label}: ${failure.error?.message ?? "Unknown error"}`);
  });
  return 1;
}
