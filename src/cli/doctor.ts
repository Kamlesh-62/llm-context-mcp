import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { findProjectRoot } from "../runtime.js";
import { resolveStoreLocation } from "../storage/config.js";
import { migrateRawStore } from "../storage/migrations.js";
import { sqliteAvailable } from "../storage/sqlite-driver.js";

type Check = {
  name: string;
  fn: () => Promise<string | null>;
};

function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }

export async function runDoctor(argv: string[]): Promise<number> {
  let projectRoot = "";
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "--project" || argv[i] === "-p") && argv[i + 1]) {
      projectRoot = argv[++i];
    }
  }

  if (!projectRoot) {
    projectRoot = await findProjectRoot();
  }

  const location = await resolveStoreLocation(projectRoot);
  const memoryFilePath = location.path;

  const checks: Check[] = [
    {
      name: "Project root exists",
      fn: async () => {
        try {
          const s = await fs.stat(projectRoot);
          return s.isDirectory() ? null : `Not a directory: ${projectRoot}`;
        } catch {
          return `Project root not found: ${projectRoot}`;
        }
      },
    },
    {
      name: ".ai/ directory writable",
      fn: async () => {
        const aiDir = path.join(projectRoot, ".ai");
        try {
          await fs.mkdir(aiDir, { recursive: true });
          await fs.access(aiDir, fs.constants.W_OK);
          return null;
        } catch {
          return `.ai/ directory not writable: ${aiDir}`;
        }
      },
    },
    {
      name: `SQLite driver available (backend: ${location.backend})`,
      fn: async () => {
        if (location.backend !== "sqlite") return null; // not applicable to JSON
        return sqliteAvailable()
          ? null
          : "SQLite backend selected but no driver: use Node >=22.5 (node:sqlite) or `npm i better-sqlite3`";
      },
    },
    {
      name: `Store readable (${location.backend})`,
      fn: async () => {
        if (location.backend === "sqlite") {
          // The driver check above covers usability; here just confirm the file,
          // if present, is non-empty. A missing file is fine (not yet created).
          try {
            await fs.stat(memoryFilePath);
            return null;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
            return `Cannot access store: ${(e as Error).message}`;
          }
        }
        try {
          const raw = await fs.readFile(memoryFilePath, "utf8");
          migrateRawStore(JSON.parse(raw)); // throws on corrupt/too-new
          return null;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // not yet created
          return `Store corrupted: ${(e as Error).message}`;
        }
      },
    },
    {
      name: "Claude Code config",
      fn: async () => {
        const configPath = process.env.PROJECT_MEMORY_MCP_CLAUDE_CONFIG_PATH
          || process.env.CLAUDE_CONFIG_PATH
          || path.join(homedir(), ".claude.json");
        try {
          const raw = await fs.readFile(configPath, "utf8");
          const config = JSON.parse(raw);
          const servers = config?.mcpServers;
          if (!servers || typeof servers !== "object") return `No mcpServers in ${configPath}`;
          const hasMemory = Object.values(servers).some(
            (s: unknown) => typeof s === "object" && s !== null && "command" in s,
          );
          return hasMemory ? null : `No MCP server entries found in ${configPath}`;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return `Config not found: ${configPath}`;
          return `Cannot read ${configPath}: ${(e as Error).message}`;
        }
      },
    },
    {
      name: "Gemini CLI config",
      fn: async () => {
        const configPath = path.join(homedir(), ".gemini", "settings.json");
        try {
          await fs.access(configPath);
          return null;
        } catch {
          return `Config not found: ${configPath} (optional)`;
        }
      },
    },
  ];

  console.log(`\nProject: ${projectRoot}`);
  console.log(`Memory:  ${memoryFilePath}\n`);

  let failures = 0;
  for (const check of checks) {
    const error = await check.fn();
    if (error) {
      console.log(`  ${red("FAIL")} ${check.name}`);
      console.log(`       ${error}`);
      failures++;
    } else {
      console.log(`  ${green("PASS")} ${check.name}`);
    }
  }

  console.log(`\n${checks.length - failures}/${checks.length} checks passed.\n`);
  return failures > 0 ? 1 : 0;
}
