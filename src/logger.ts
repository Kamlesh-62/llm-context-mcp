export function log(...args: unknown[]): void {
  // STDERR only (required for MCP stdio servers).
  console.error("[project-memory]", ...args);
}
