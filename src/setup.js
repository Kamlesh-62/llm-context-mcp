import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const SERVER_ID = "project-memory";
const CLI_LABELS = {
  claude: "Claude Code",
  gemini: "Gemini CLI",
  codex: "Codex CLI",
};
const CLAUDE_CONFIG_PATH = path.join(homedir(), ".claude.json");
const SERVER_ENTRY_PATH = fileURLToPath(new URL("../server.js", import.meta.url));

const BUILTIN_RUNNERS = {
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

export async function runSetup(argv = []) {
  let parsedArgs;
  try {
    parsedArgs = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
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
    let runner;
    try {
      runner = await resolveRunner(rl, parsedArgs);
    } catch (error) {
      console.error(error.message);
      return 1;
    }
    const selection = await resolveCliSelection(rl, parsedArgs);

    if (!selection.claude && !selection.gemini && !selection.codex) {
      console.log("No CLIs selected. Nothing to configure.");
      return 0;
    }

    console.log("\nConfiguration preview:");
    console.log(`  Project root: ${projectRoot}`);
    console.log(`  Server command: ${formatCommand(runner.command, runner.args)}`);
    console.log(`  Target CLIs: ${listSelectedClis(selection)}`);

    if (!parsedArgs.acceptDefaults) {
      const proceed = await askYesNo(rl, "Continue with these settings?", true, parsedArgs);
      if (!proceed) {
        console.log("Setup aborted.");
        return 1;
      }
    }

    const steps = [];
    if (selection.claude) {
      steps.push(
        await executeStep("Claude Code", () =>
          configureClaude({
            projectRoot,
            runner,
          }),
        ),
      );
    }
    if (selection.gemini) {
      steps.push(
        await executeStep("Gemini CLI", () =>
          configureGemini({
            projectRoot,
            runner,
          }),
        ),
      );
    }
    if (selection.codex) {
      steps.push(
        await executeStep("Codex CLI", () =>
          configureCodex({
            projectRoot,
            runner,
          }),
        ),
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
  } finally {
    rl.close();
  }
}

function parseArgs(argv) {
  const result = {
    projectRoot: null,
    acceptDefaults: false,
    runner: null,
    customCommand: null,
    customArgs: null,
    cliFilters: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--project":
      case "--cwd":
        result.projectRoot = requireValue(argv, ++i, token);
        break;
      case "--cli":
        result.cliFilters = parseCliList(requireValue(argv, ++i, token));
        break;
      case "--claude":
      case "--gemini":
      case "--codex": {
        const value = token.slice(2);
        result.cliFilters = mergeCliFilter(result.cliFilters, [value]);
        break;
      }
      case "--runner":
        result.runner = requireValue(argv, ++i, token);
        break;
      case "--command":
        result.customCommand = requireValue(argv, ++i, token);
        break;
      case "--args":
        result.customArgs = requireValue(argv, ++i, token);
        break;
      case "--yes":
      case "-y":
        result.acceptDefaults = true;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
      default:
        throw new Error(`Unknown setup option "${token}". Run with --help for usage.`);
    }
  }

  return result;
}

function requireValue(argv, index, flag) {
  if (index >= argv.length) {
    throw new Error(`Option ${flag} requires a value.`);
  }
  return argv[index];
}

function parseCliList(value) {
  return mergeCliFilter(null, value.split(","));
}

function mergeCliFilter(existing, values) {
  const normalized = new Set(existing ?? []);
  values.forEach((entry) => {
    const normalizedEntry = normalizeCli(entry);
    normalized.add(normalizedEntry);
  });
  return Array.from(normalized);
}

function normalizeCli(value) {
  const normalized = value.trim().toLowerCase();
  if (["claude", "claude-code"].includes(normalized)) {
    return "claude";
  }
  if (["gemini", "gemini-cli"].includes(normalized)) {
    return "gemini";
  }
  if (["codex", "codex-cli"].includes(normalized)) {
    return "codex";
  }
  throw new Error(`Unknown CLI "${value}". Expected one of: claude, gemini, codex.`);
}

function printHelp() {
  console.log(
    [
      "Usage: project-memory-mcp setup [options]",
      "",
      "Options:",
      "  --project <path>     Project directory to bind the MCP server to.",
      "  --cli <list>         Comma-separated subset of CLIs (claude,gemini,codex).",
      "  --runner <type>      npx | global | node | custom.",
      "  --command <value>    Custom command (required when --runner custom).",
      "  --args <string>      Custom command args (JSON array or space separated).",
      "  -y, --yes            Accept defaults without interactive prompts.",
      "  -h, --help           Show this help text.",
      "",
      "Examples:",
      "  project-memory-mcp setup",
      "  project-memory-mcp setup --cli claude,gemini --project ~/code/api",
      '  project-memory-mcp setup --runner custom --command "node" --args "[\\"/path/server.js\\"]"',
    ].join("\n"),
  );
}

async function resolveProjectRoot(rl, args) {
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
      console.error(`  ${error.message}`);
    }
  }
}

function resolvePath(input) {
  const expanded = expandHome(input);
  return path.resolve(expanded);
}

function expandHome(value) {
  if (!value) {
    return value;
  }
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

async function assertDirectory(candidate) {
  const stats = await stat(candidate).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`Directory "${candidate}" does not exist.`);
    }
    throw error;
  });

  if (!stats.isDirectory()) {
    throw new Error(`Path "${candidate}" is not a directory.`);
  }
}

async function resolveRunner(rl, args) {
  const preselected = buildRunnerFromArgs(args);
  if (preselected) {
    return preselected;
  }
  if (args.acceptDefaults) {
    return cloneRunner("npx");
  }

  const choices = [
    { index: "1", key: "npx", label: BUILTIN_RUNNERS.npx.label },
    { index: "2", key: "global", label: BUILTIN_RUNNERS.global.label },
    { index: "3", key: "node", label: BUILTIN_RUNNERS.node.label },
    { index: "4", key: "custom", label: "Provide a custom command" },
  ];

  while (true) {
    console.log("\nHow should we launch the MCP server?");
    choices.forEach((choice) => {
      console.log(`  ${choice.index}) ${choice.label}`);
    });

    const answer = (await rl.question("Select an option [1]: ")).trim() || "1";
    const choice = choices.find((entry) => entry.index === answer);
    if (!choice) {
      console.log("  Invalid selection. Try again.");
      continue;
    }

    if (choice.key === "custom") {
      return await promptCustomRunner(rl, args);
    }

    return cloneRunner(choice.key);
  }
}

function buildRunnerFromArgs(args) {
  if (args.runner) {
    const normalized = args.runner.toLowerCase();
    if (normalized === "custom") {
      if (!args.customCommand) {
        throw new Error("Custom runner requires --command.");
      }
      const parsedArgs = parseArgsInput(args.customArgs);
      return {
        command: args.customCommand,
        args: parsedArgs,
        label: "Custom command",
      };
    }
    return cloneRunner(normalized);
  }

  if (args.customCommand) {
    return {
      command: args.customCommand,
      args: parseArgsInput(args.customArgs),
      label: "Custom command",
    };
  }

  return null;
}

function cloneRunner(key) {
  const base = BUILTIN_RUNNERS[key];
  if (!base) {
    throw new Error(`Unknown runner "${key}".`);
  }
  return {
    command: base.command,
    args: [...base.args],
    label: base.label,
  };
}

async function promptCustomRunner(rl, args) {
  let command = args.customCommand;
  while (!command) {
    const answer = (await rl.question("Custom command to start the MCP server: ")).trim();
    if (answer) {
      command = answer;
    } else {
      console.log("  Command is required.");
    }
  }

  let resolvedArgs = null;
  while (resolvedArgs === null) {
    const answer =
      args.customArgs ??
      (await rl.question(
        "Arguments (JSON array or space separated, leave blank for none): ",
      ));
    args.customArgs = null;
    if (!answer.trim()) {
      resolvedArgs = [];
      break;
    }
    try {
      resolvedArgs = parseArgsInput(answer);
    } catch (error) {
      console.error(`  ${error.message}`);
      resolvedArgs = null;
    }
  }

  return {
    command,
    args: resolvedArgs,
    label: "Custom command",
  };
}

function parseArgsInput(raw) {
  if (!raw || !raw.trim()) {
    return [];
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Arguments must be valid JSON or plain text.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("JSON arguments must be an array.");
    }
    return parsed.map((value) => `${value}`);
  }

  const tokens = trimmed.match(/"([^"]*)"|'([^']*)'|[^\s]+/g) ?? [];
  return tokens.map((token) => {
    if (token.startsWith('"') && token.endsWith('"')) {
      return token.slice(1, -1);
    }
    if (token.startsWith("'") && token.endsWith("'")) {
      return token.slice(1, -1);
    }
    return token;
  });
}

async function resolveCliSelection(rl, args) {
  if (args.cliFilters?.length) {
    const set = new Set(args.cliFilters);
    return {
      claude: set.has("claude"),
      gemini: set.has("gemini"),
      codex: set.has("codex"),
    };
  }

  if (args.acceptDefaults) {
    return {
      claude: true,
      gemini: true,
      codex: true,
    };
  }

  while (true) {
    const claude = await askYesNo(rl, "Configure Claude Code? (Y/n): ", true, args);
    const gemini = await askYesNo(rl, "Configure Gemini CLI? (Y/n): ", true, args);
    const codex = await askYesNo(rl, "Configure Codex CLI? (Y/n): ", true, args);

    if (claude || gemini || codex) {
      return { claude, gemini, codex };
    }
    console.log("Select at least one CLI (Ctrl+C to exit).");
  }
}

async function askYesNo(rl, prompt, defaultValue, args) {
  if (args.acceptDefaults) {
    return defaultValue;
  }
  const suffix = defaultValue ? " (Y/n): " : " (y/N): ";
  const answer = (await rl.question(`${prompt.replace(/[: ]+$/, "")}${suffix}`))
    .trim()
    .toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  if (["y", "yes"].includes(answer)) {
    return true;
  }
  if (["n", "no"].includes(answer)) {
    return false;
  }
  console.log("  Please answer y or n.");
  return askYesNo(rl, prompt, defaultValue, args);
}

function listSelectedClis(selection) {
  const names = [];
  if (selection.claude) {
    names.push(CLI_LABELS.claude);
  }
  if (selection.gemini) {
    names.push(CLI_LABELS.gemini);
  }
  if (selection.codex) {
    names.push(CLI_LABELS.codex);
  }
  return names.join(", ");
}

async function executeStep(label, task) {
  console.log(`\n${label}`);
  try {
    await task();
    console.log(`  ✔ ${label} configured`);
    return { label, ok: true };
  } catch (error) {
    console.error(`  ✖ ${label} failed: ${error.message}`);
    return { label, ok: false, error };
  }
}

async function configureClaude({ projectRoot, runner }) {
  const { data, raw } = await loadJson(CLAUDE_CONFIG_PATH);
  const config = isPlainObject(data) ? data : {};
  if (!isPlainObject(config.mcpServers)) {
    config.mcpServers = {};
  }

  config.mcpServers[SERVER_ID] = {
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

async function loadJson(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return { data: JSON.parse(raw), raw };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { data: {}, raw: null };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

async function configureGemini({ projectRoot, runner }) {
  await runCommand("gemini", ["mcp", "remove", SERVER_ID], {
    cwd: projectRoot,
    ignoreExit: true,
  });
  const args = ["mcp", "add", SERVER_ID, runner.command, ...runner.args, "--trust"];
  await runCommand("gemini", args, { cwd: projectRoot });
}

async function configureCodex({ projectRoot, runner }) {
  await runCommand("codex", ["mcp", "remove", SERVER_ID], {
    cwd: projectRoot,
    ignoreExit: true,
  });
  const args = ["mcp", "add", SERVER_ID, runner.command, ...runner.args];
  await runCommand("codex", args, { cwd: projectRoot });
}

async function runCommand(command, args, options = {}) {
  const { cwd, ignoreExit = false } = options;
  console.log(`  $ ${formatCommand(command, args)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
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

function formatCommand(command, args = []) {
  const parts = [command, ...(args ?? [])]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => part.toString());
  return parts
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
