import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

type RunnerKey = keyof typeof BUILTIN_RUNNERS | "custom";

type Runner = {
  command: string;
  args: string[];
  label: string;
  key: RunnerKey;
};

type SavedRunner = {
  key: RunnerKey;
  command: string;
  args: string[];
};

type ProjectDefaults = {
  serverId?: string;
  runner?: SavedRunner;
};

type CliSelection = {
  claude: boolean;
  gemini: boolean;
  codex: boolean;
};

type CommonArgs = {
  projectRoot: string | null;
  cliFilters: string[] | null;
  acceptDefaults: boolean;
  help: boolean;
};

type ParsedArgs = CommonArgs & {
  serverId: string | null;
  runner: string | null;
  customCommand: string | null;
  customArgs: string | null;
};

type StepResult = {
  label: string;
  ok: boolean;
  error?: Error;
};

const SERVER_ID_PATTERN = /^[a-z0-9-]{3,32}$/;
const CLI_LABELS = {
  claude: "Claude Code",
  gemini: "Gemini CLI",
  codex: "Codex CLI",
};
const CLAUDE_CONFIG_OVERRIDE =
  process.env.PROJECT_MEMORY_MCP_CLAUDE_CONFIG_PATH ?? process.env.CLAUDE_CONFIG_PATH ?? null;
const CLAUDE_CONFIG_PATH = CLAUDE_CONFIG_OVERRIDE
  ? resolvePath(CLAUDE_CONFIG_OVERRIDE)
  : path.join(homedir(), ".claude.json");
const SERVER_ENTRY_PATH = fileURLToPath(new URL("../server.js", import.meta.url));
const PROJECT_CONFIG_FILENAME = "memory-mcp.json";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    let runner: Runner;
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

    console.log("\nConfiguration preview:");
    console.log(`  Project root: ${projectRoot}`);
    console.log(`  Server ID: ${serverId}`);
    console.log(`  Server command: ${formatCommand(runner.command, runner.args)}`);
    console.log(`  Target CLIs: ${listSelectedClis(selection)}`);

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

    const steps: StepResult[] = [];
    if (selection.claude) {
      steps.push(
        await executeStep("Claude Code", () =>
          configureClaude({
            projectRoot,
            runner,
            serverId,
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
            serverId,
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
            serverId,
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

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    projectRoot: null,
    serverId: null,
    acceptDefaults: false,
    runner: null,
    customCommand: null,
    customArgs: null,
    cliFilters: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const newI = tryParseCommonToken(argv, i, result);
    if (newI !== null) {
      i = newI;
      continue;
    }
    switch (token) {
      case "--server-id":
        result.serverId = requireValue(argv, ++i, token);
        break;
      case "--runner-profile":
      case "--runner":
        result.runner = requireValue(argv, ++i, token);
        break;
      case "--command":
        result.customCommand = requireValue(argv, ++i, token);
        break;
      case "--args":
        result.customArgs = requireValue(argv, ++i, token);
        break;
      default:
        throw new Error(`Unknown setup option "${token}". Run with --help for usage.`);
    }
  }

  return result;
}

function requireValue(argv: string[], index: number, flag: string): string {
  if (index >= argv.length) {
    throw new Error(`Option ${flag} requires a value.`);
  }
  return argv[index];
}

/** Handles the 5 tokens shared by both parseArgs and parseSwitchArgs.
 *  Returns the updated index if the token was consumed, null if unrecognised. */
function tryParseCommonToken(argv: string[], i: number, result: CommonArgs): number | null {
  const token = argv[i];
  switch (token) {
    case "--project":
    case "--cwd":
      result.projectRoot = requireValue(argv, ++i, token);
      return i;
    case "--cli":
      result.cliFilters = parseCliList(requireValue(argv, ++i, token));
      return i;
    case "--claude":
    case "--gemini":
    case "--codex": {
      result.cliFilters = mergeCliFilter(result.cliFilters, [token.slice(2)]);
      return i;
    }
    case "--yes":
    case "-y":
      result.acceptDefaults = true;
      return i;
    case "--help":
    case "-h":
      result.help = true;
      return i;
    default:
      return null;
  }
}

function parseCliList(value: string): string[] {
  return mergeCliFilter(null, value.split(","));
}

function mergeCliFilter(existing: string[] | null, values: string[]): string[] {
  const normalized = new Set(existing ?? []);
  values.forEach((entry) => {
    const normalizedEntry = normalizeCli(entry);
    normalized.add(normalizedEntry);
  });
  return Array.from(normalized);
}

function normalizeCli(value: string): string {
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

function printHelp(): void {
  console.log(
    [
      "Usage: project-memory-mcp setup [options]",
      "",
      "Options:",
      "  --project <path>     Project directory to bind the MCP server to.",
      "  --server-id <name>   Friendly server ID (a-z0-9-, 3-32 chars).",
      "  --cli <list>         Comma-separated subset of CLIs (claude,gemini,codex).",
      "  --runner <type>      npx | global | node | custom (alias: --runner-profile).",
      "  --command <value>    Custom command (required when --runner custom).",
      "  --args <string>      Custom command args (JSON array or space separated).",
      "  -y, --yes            Accept defaults without interactive prompts.",
      "  -h, --help           Show this help text.",
      "",
      "Examples:",
      "  project-memory-mcp setup",
      "  project-memory-mcp setup --cli claude,gemini --project ~/code/api",
      '  project-memory-mcp setup --runner custom --command "node" --args "[\\"/path/dist/server.js\\"]"',
    ].join("\n"),
  );
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

async function loadProjectDefaults(projectRoot: string): Promise<ProjectDefaults> {
  const filePath = getProjectConfigPath(projectRoot);
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!isPlainObject(data)) {
      return {};
    }
    const defaults: ProjectDefaults = {};
    if (typeof data.serverId === "string" && SERVER_ID_PATTERN.test(data.serverId)) {
      defaults.serverId = data.serverId;
    }
    if (data.runner) {
      const runner = normalizeSavedRunner(data.runner);
      if (runner) {
        defaults.runner = runner;
      }
    }
    return defaults;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

async function saveProjectDefaults(
  projectRoot: string,
  defaults: ProjectDefaults,
): Promise<void> {
  const filePath = getProjectConfigPath(projectRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(defaults, null, 2)}\n`);
}

function getProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".ai", PROJECT_CONFIG_FILENAME);
}

async function resolveServerId(
  rl: readline.Interface,
  args: ParsedArgs,
  projectRoot: string,
  defaults: ProjectDefaults,
): Promise<string> {
  if (args.serverId) {
    return validateServerId(args.serverId);
  }

  const fallback = defaults.serverId ?? suggestServerId(projectRoot);
  if (args.acceptDefaults) {
    if (fallback) {
      return fallback;
    }
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
        if (choice === "2") {
          continue;
        }
      }
      return validated;
    } catch (error) {
      console.log(`  ${errorMessage(error)}`);
    }
  }
}

function resolvePath(input: string): string {
  const expanded = expandHome(input);
  return path.resolve(expanded);
}

function expandHome(value: string): string {
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

async function assertDirectory(candidate: string): Promise<void> {
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

async function resolveRunner(
  rl: readline.Interface,
  args: ParsedArgs,
  savedRunner?: SavedRunner,
): Promise<Runner> {
  const preselected = buildRunnerFromArgs(args);
  if (preselected) {
    return preselected;
  }
  const restored = restoreSavedRunner(savedRunner);
  if (args.acceptDefaults) {
    return restored ?? cloneRunner("npx");
  }

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

function buildRunnerFromArgs(args: ParsedArgs): Runner | null {
  if (args.runner) {
    const normalized = args.runner.toLowerCase();
    if (normalized === "custom") {
      if (!args.customCommand) {
        throw new Error("Custom runner requires --command.");
      }
      return createCustomRunner(args.customCommand, parseArgsInput(args.customArgs));
    }
    return cloneRunner(normalized as RunnerKey);
  }

  if (args.customCommand) {
    return createCustomRunner(args.customCommand, parseArgsInput(args.customArgs));
  }

  return null;
}

function cloneRunner(key: RunnerKey): Runner {
  const base = BUILTIN_RUNNERS[key as keyof typeof BUILTIN_RUNNERS];
  if (!base) {
    throw new Error(`Unknown runner "${key}".`);
  }
  return {
    command: base.command,
    args: [...base.args],
    label: base.label,
    key,
  };
}

async function promptCustomRunner(
  rl: readline.Interface,
  args: ParsedArgs,
  previous?: Runner | null,
): Promise<Runner> {
  let command = args.customCommand ?? previous?.command ?? null;
  while (!command) {
    const suffix = previous?.command ? ` [${previous.command}]` : "";
    const answer = (await rl.question(`Custom command to start the MCP server${suffix}: `)).trim();
    if (answer) {
      command = answer;
      break;
    }
    if (!answer && previous?.command) {
      command = previous.command;
      break;
    }
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

function createCustomRunner(command: string, args: string[]): Runner {
  return {
    command,
    args: [...args],
    label: "Custom command",
    key: "custom",
  };
}

function parseArgsInput(raw?: string | null): string[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Arguments must be valid JSON or plain text.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("JSON arguments must be an array.");
    }
    return (parsed as unknown[]).map((value) => `${value}`);
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

async function askYesNo(
  rl: readline.Interface,
  prompt: string,
  defaultValue: boolean,
  args: ParsedArgs,
): Promise<boolean> {
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

function listSelectedClis(selection: CliSelection): string {
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

async function executeStep(label: string, task: () => Promise<void>): Promise<StepResult> {
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

async function configureClaude({
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

async function checkExistingClaudeEntry(
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

async function loadJson(filePath: string): Promise<{ data: unknown; raw: string | null }> {
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

async function configureGemini({
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

async function configureCodex({
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

async function runCommand(
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

function formatCommand(command: string, args: Array<string | undefined> = []): string {
  const parts = [command, ...(args ?? [])]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => part.toString());
  return parts
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ");
}

function snapshotRunner(runner: Runner): SavedRunner {
  return {
    key: runner.key,
    command: runner.command,
    args: [...runner.args],
  };
}

function normalizeSavedRunner(value: unknown): SavedRunner | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const key =
    typeof value.key === "string" && isValidRunnerKey(value.key) ? (value.key as RunnerKey) : undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  const args =
    Array.isArray(value.args) && value.args.every((entry) => typeof entry === "string")
      ? (value.args as string[])
      : undefined;
  if (!key || !command || !args) {
    return undefined;
  }
  return { key, command, args };
}

function restoreSavedRunner(saved?: SavedRunner): Runner | null {
  if (!saved || !isValidRunnerKey(saved.key)) {
    return null;
  }
  if (saved.key === "custom") {
    return createCustomRunner(saved.command, [...saved.args]);
  }
  return cloneRunner(saved.key);
}

function isValidRunnerKey(value: string): value is RunnerKey {
  return value === "custom" || Object.prototype.hasOwnProperty.call(BUILTIN_RUNNERS, value);
}

function validateServerId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SERVER_ID_PATTERN.test(normalized)) {
    throw new Error("Server ID must be 3-32 chars using lowercase letters, numbers, or hyphens.");
  }
  return normalized;
}

function suggestServerId(projectRoot: string): string | null {
  const fallback = path.basename(projectRoot).toLowerCase();
  const normalized = fallback.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const truncated = normalized.slice(0, 32);
  if (SERVER_ID_PATTERN.test(truncated)) {
    return truncated;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

  const steps: StepResult[] = [];
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
