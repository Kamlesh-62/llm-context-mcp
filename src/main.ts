import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { findProjectRoot, resolveMemoryFilePath } from "./runtime.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";
import { SuggestionEngine } from "./suggestions.js";

export async function main() {
  const server = new McpServer({
    name: CONFIG.serverName,
    version: CONFIG.serverVersion,
  });

  const engine = new SuggestionEngine(CONFIG.suggestions);
  engine.setServer(server);

  registerTools(server, engine);
  registerPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const projectRoot = await findProjectRoot();
  const memoryFilePath = resolveMemoryFilePath(projectRoot);
  engine.setProjectRoot(projectRoot);

  log("running on stdio");
  log("projectRoot:", projectRoot);
  log("memoryFile:", memoryFilePath);
}
