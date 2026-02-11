/**
 * Project Memory MCP Server (JSON backend)
 * Modularized entrypoint.
 */

import { main } from "./src/main.js";
import { log } from "./src/logger.js";

main().catch((err) => {
  log("fatal error:", err);
  process.exit(1);
});
