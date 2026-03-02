import type { CommonArgs, ParsedArgs } from "./types.js";

export function requireValue(argv: string[], index: number, flag: string): string {
  if (index >= argv.length) {
    throw new Error(`Option ${flag} requires a value.`);
  }
  return argv[index];
}

export function tryParseCommonToken(argv: string[], i: number, result: CommonArgs): number | null {
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

export function parseCliList(value: string): string[] {
  return mergeCliFilter(null, value.split(","));
}

export function mergeCliFilter(existing: string[] | null, values: string[]): string[] {
  const normalized = new Set(existing ?? []);
  values.forEach((entry) => {
    normalized.add(normalizeCli(entry));
  });
  return Array.from(normalized);
}

function normalizeCli(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["claude", "claude-code"].includes(normalized)) return "claude";
  if (["gemini", "gemini-cli"].includes(normalized)) return "gemini";
  if (["codex", "codex-cli"].includes(normalized)) return "codex";
  throw new Error(`Unknown CLI "${value}". Expected one of: claude, gemini, codex.`);
}

export function parseArgs(argv: string[]): ParsedArgs {
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
    const newI = tryParseCommonToken(argv, i, result);
    if (newI !== null) {
      i = newI;
      continue;
    }
    const token = argv[i];
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

export function printHelp(): void {
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
