export const CONFIG = {
  serverName: "project-memory",
  serverVersion: "0.1.0",
  defaultRelMemoryPath: ".ai/memory.json",
  lockTimeoutMs: 2500,
  lockRetryDelayMs: 50,
  lockRetryBackoff: 1.25,
  maxLockRetryDelayMs: 250,
  maxContentSnippetChars: 280,
  autoCompact: {
    enabled: true,
    maxItems: 400,
    archiveRelPath: ".ai/memory-archive.json",
    summaryTitle: "Archived context (auto)",
    summaryTag: "archive",
    summaryMaxEntries: 20,
    growthThreshold: 50,
  },
};

export const ALLOWED_TYPES = new Set([
  "note",
  "decision",
  "fact",
  "constraint",
  "todo",
  "architecture",
  "glossary",
]);
