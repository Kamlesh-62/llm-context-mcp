import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SuggestionEngine } from "../suggestions/index.js";

import { registerReadTools } from "./read-tools.js";
import { registerWriteTools } from "./write-tools.js";
import { registerProposalTools } from "./proposal-tools.js";
import { registerCompactTools } from "./compact-tools.js";
import { registerSuggestionTools } from "./suggestion-tools.js";

export function registerTools(server: McpServer, engine?: SuggestionEngine): void {
  registerReadTools(server);
  registerWriteTools(server);
  registerProposalTools(server);
  registerCompactTools(server);
  registerSuggestionTools(server, engine);
}
