#!/usr/bin/env node
/**
 * Project Memory MCP Server (JSON backend) + setup utilities.
 */

import process from "node:process";
import { createRequire } from "node:module";
import { main } from "./src/main.js";
import { log } from "./src/logger.js";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json") as {
  version: string;
};
const VERSION_FLAGS = new Set(["--version", "-v", "version", "-V"]);

async function run(): Promise<void> {
  const [, , rawCommand] = process.argv;
  const command = rawCommand?.toLowerCase();

  if (command && VERSION_FLAGS.has(command)) {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (!command || command === "serve") {
    await main();
    return;
  }

  if (command === "setup" || command === "configure") {
    const { runSetup } = await import("./src/setup.js");
    const exitCode = await runSetup(process.argv.slice(3));
    if (typeof exitCode === "number" && exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }

  if (command === "switch") {
    const { runSwitch } = await import("./src/setup.js");
    const exitCode = await runSwitch(process.argv.slice(3));
    if (typeof exitCode === "number" && exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  log(`unknown command "${rawCommand}".`);
  printUsage();
  process.exitCode = 1;
}

function printUsage(): void {
  console.log(`
Usage:
  project-memory-mcp               Start the MCP server (default)
  project-memory-mcp serve         Explicitly start the MCP server
  project-memory-mcp setup [...]   Run the interactive CLI configuration wizard
  project-memory-mcp switch [...]  Re-apply saved config to CLIs (no prompts)
  project-memory-mcp help          Show this message
`.trim());
}

run().catch((err) => {
  log("fatal error:", err);
  process.exit(1);
});
