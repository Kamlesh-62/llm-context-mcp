export function log(...args) {
  // STDERR only (required for MCP stdio servers).
  console.error("[project-memory]", ...args);
}
