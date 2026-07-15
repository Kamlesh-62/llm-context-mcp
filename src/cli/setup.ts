import process from "node:process";
import readline from "node:readline/promises";

import type { CliSelection, ParsedArgs } from "./types.js";
import { parseArgs, printHelp } from "./args.js";
import { resolveRunner, snapshotRunner } from "./runners.js";
import { configureClaude, configureGemini, configureCodex, checkExistingClaudeEntry } from "./config-writers.js";
import { loadIdentity, saveIdentity, resolveAuthor } from "../identity.js";
import {
  installClaudeStopHook,
  installClaudePostToolUseHook,
  installCodexNotify,
  installCodexPostToolUseHook,
} from "./hooks-install.js";
import {
  errorMessage,
  resolvePath,
  assertDirectory,
  askYesNo,
  listSelectedClis,
  formatCommand,
  executeStep,
  validateServerId,
  suggestServerId,
  loadProjectDefaults,
  saveProjectDefaults,
} from "./helpers.js";

export async function runSetup(argv: string[] = []): Promise<number> {
  let parsedArgs;
  try {
    parsedArgs = parseArgs(argv);
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }

  if (parsedArgs.help) {
    printHelp();
    return 0;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const projectRoot = await resolveProjectRoot(rl, parsedArgs);
    const projectDefaults = await loadProjectDefaults(projectRoot);
    let serverId: string;
    try {
      serverId = await resolveServerId(rl, parsedArgs, projectRoot, projectDefaults);
    } catch (error) {
      console.error(errorMessage(error));
      return 1;
    }
    let runner;
    try {
      runner = await resolveRunner(rl, parsedArgs, projectDefaults.runner);
    } catch (error) {
      console.error(errorMessage(error));
      return 1;
    }
    const selection = await resolveCliSelection(rl, parsedArgs);

    if (!selection.claude && !selection.gemini && !selection.codex) {
      console.log("No CLIs selected. Nothing to configure.");
      return 0;
    }

    await resolveIdentity(rl, parsedArgs, projectRoot);
    const author = resolveAuthor(projectRoot);

    console.log("\nConfiguration preview:");
    console.log(`  Project root: ${projectRoot}`);
    console.log(`  Server ID: ${serverId}`);
    console.log(`  Server command: ${formatCommand(runner.command, runner.args)}`);
    console.log(`  Target CLIs: ${listSelectedClis(selection)}`);
    if (author) {
      console.log(`  Author: ${author.name}${author.team ? ` (${author.team})` : ""}`);
    }

    if (!parsedArgs.acceptDefaults) {
      const proceed = await askYesNo(rl, "Continue with these settings?", true, parsedArgs);
      if (!proceed) {
        console.log("Setup aborted.");
        return 1;
      }
    }

    await saveProjectDefaults(projectRoot, {
      ...projectDefaults,
      serverId,
      runner: snapshotRunner(runner),
    });

    const steps = [];
    if (selection.claude) {
      steps.push(
        await executeStep("Claude Code", () =>
          configureClaude({ projectRoot, runner, serverId }),
        ),
      );
    }
    if (selection.gemini) {
      steps.push(
        await executeStep("Gemini CLI", () =>
          configureGemini({ projectRoot, runner, serverId }),
        ),
      );
    }
    if (selection.codex) {
      steps.push(
        await executeStep("Codex CLI", () =>
          configureCodex({ projectRoot, runner, serverId }),
        ),
      );
    }

    // Auto-save hooks capture memory from session transcripts. Registering the
    // MCP server does NOT install these — they must be wired separately.
    const wantHooks =
      parsedArgs.acceptDefaults ||
      (await askYesNo(rl, "Install auto-save memory hooks? (Y/n): ", true, parsedArgs));
    if (wantHooks) {
      // Real-time capture runs after every tool call — crash-safe but more
      // frequent. Opt-in (defaults to No); applies to whichever CLIs support it.
      const wantRealtime =
        !parsedArgs.acceptDefaults &&
        (await askYesNo(
          rl,
          "Also capture in real-time (PostToolUse, more frequent)? (y/N): ",
          false,
          parsedArgs,
        ));

      if (selection.claude) {
        steps.push(
          await executeStep("Claude auto-save hook", async () => {
            const p = await installClaudeStopHook(projectRoot);
            console.log(`  Stop hook written to ${p}`);
          }),
        );
        if (wantRealtime) {
          steps.push(
            await executeStep("Claude real-time hook", async () => {
              const p = await installClaudePostToolUseHook(projectRoot);
              console.log(`  PostToolUse hook written to ${p}`);
            }),
          );
        }
      }
      if (selection.codex) {
        steps.push(
          await executeStep("Codex auto-save hook", async () => {
            const r = await installCodexNotify();
            if (r.status === "added") console.log(`  notify added to ${r.configPath}`);
            else console.log(`  ${r.configPath} already has a notify entry — leaving it. Recommended: ${r.recommended}`);
          }),
        );
        if (wantRealtime) {
          steps.push(
            await executeStep("Codex real-time hook", async () => {
              const r = await installCodexPostToolUseHook(projectRoot);
              console.log(`  PostToolUse hook written to ${r.hooksPath}`);
              if (r.featureFlag === "added") console.log(`  enabled [features] hooks = true in ${r.configPath}`);
              else if (r.featureFlag === "manual")
                console.log(`  ACTION: add \`[features]\\nhooks = true\` to ${r.configPath} (existing [features] table left untouched)`);
            }),
          );
        }
      }
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
  } finally {
    rl.close();
  }
}

async function resolveProjectRoot(
  rl: readline.Interface,
  args: ParsedArgs,
): Promise<string> {
  const defaultDir = resolvePath(args.projectRoot ?? process.cwd());

  if (args.projectRoot || args.acceptDefaults) {
    await assertDirectory(defaultDir);
    return defaultDir;
  }

  while (true) {
    const answer = (await rl.question(`Project directory [${defaultDir}]: `)).trim();
    const candidate = resolvePath(answer || defaultDir);
    try {
      await assertDirectory(candidate);
      return candidate;
    } catch (error) {
      console.error(`  ${errorMessage(error)}`);
    }
  }
}

async function resolveServerId(
  rl: readline.Interface,
  args: ParsedArgs,
  projectRoot: string,
  defaults: { serverId?: string },
): Promise<string> {
  if (args.serverId) return validateServerId(args.serverId);

  const fallback = defaults.serverId ?? suggestServerId(projectRoot);
  if (args.acceptDefaults) {
    if (fallback) return fallback;
    throw new Error(
      "Server ID is required when running non-interactively. Pass --server-id <name> or rerun without --yes.",
    );
  }

  while (true) {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`Server ID${suffix}: `)).trim();
    const candidate = answer || fallback;
    if (!candidate) {
      console.log("  Please enter a server ID (a-z0-9-, length 3-32).");
      continue;
    }
    try {
      const validated = validateServerId(candidate);
      const existing = await checkExistingClaudeEntry(validated);
      if (existing.exists) {
        console.log(
          `  Server ID "${validated}" is already registered in Claude Code (command: ${existing.command ?? "unknown"}).`,
        );
        const choice = (
          await rl.question(`  (1) Update existing entry  (2) Enter a different ID [1]: `)
        )
          .trim()
          .toLowerCase();
        if (choice === "2") continue;
      }
      return validated;
    } catch (error) {
      console.log(`  ${errorMessage(error)}`);
    }
  }
}

/**
 * Prompt for the author identity (name + team) used to attribute memory items,
 * and persist it to the global identity file. Skipped in non-interactive runs.
 * Existing values are shown as defaults so a re-run is a quick confirm.
 */
async function resolveIdentity(
  rl: readline.Interface,
  args: ParsedArgs,
  projectRoot: string,
): Promise<void> {
  if (args.acceptDefaults) return; // non-interactive: keep whatever is set / env / git

  const current = loadIdentity();
  const gitName = resolveAuthor(projectRoot)?.name;
  const nameDefault = current.name ?? gitName;

  console.log(
    "\nWho are you? Used to attribute memory items when a team shares a store.",
  );
  const nameSuffix = nameDefault ? ` [${nameDefault}]` : "";
  const nameAnswer = (await rl.question(`  Your name${nameSuffix}: `)).trim();
  const name = nameAnswer || nameDefault || "";

  const teamSuffix = current.team ? ` [${current.team}]` : "";
  const teamAnswer = (await rl.question(`  Your team (optional)${teamSuffix}: `)).trim();
  const team = teamAnswer || current.team || "";

  if (name || team) {
    saveIdentity({ name, team });
  }
}

async function resolveCliSelection(
  rl: readline.Interface,
  args: ParsedArgs,
): Promise<CliSelection> {
  if (args.cliFilters?.length) {
    const set = new Set(args.cliFilters);
    return {
      claude: set.has("claude"),
      gemini: set.has("gemini"),
      codex: set.has("codex"),
    };
  }

  if (args.acceptDefaults) {
    return { claude: true, gemini: true, codex: true };
  }

  while (true) {
    const claude = await askYesNo(rl, "Configure Claude Code? (Y/n): ", true, args);
    const gemini = await askYesNo(rl, "Configure Gemini CLI? (Y/n): ", true, args);
    const codex = await askYesNo(rl, "Configure Codex CLI? (Y/n): ", true, args);

    if (claude || gemini || codex) return { claude, gemini, codex };
    console.log("Select at least one CLI (Ctrl+C to exit).");
  }
}
