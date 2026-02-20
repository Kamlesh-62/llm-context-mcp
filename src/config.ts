import type { MemoryType } from "./types.js";

export const LIMITS = {
  maxTags:         20,   // normalizeTags in domain.ts
  maxTitleChars:  200,   // item push in hooks/shared.ts
  maxContentChars: 500,  // item push in hooks/shared.ts
  maxCursorHashes: 200,  // cursor.ts trim
  maxSnippetChars: 280,  // safeSnippet in domain.ts
} as const;

export type AutoCompactConfig = {
  enabled: boolean;
  maxItems: number;
  archiveRelPath: string;
  summaryTitle: string;
  summaryTag: string;
  summaryMaxEntries: number;
  growthThreshold: number;
};

export type Config = {
  serverName: string;
  serverVersion: string;
  defaultRelMemoryPath: string;
  lockTimeoutMs: number;
  lockRetryDelayMs: number;
  lockRetryBackoff: number;
  maxLockRetryDelayMs: number;
  maxContentSnippetChars: number;
  autoCompact: AutoCompactConfig;
};

export const CONFIG: Config = {
  serverName: "project-memory",
  serverVersion: "0.1.0",
  defaultRelMemoryPath: ".ai/memory.json",
  lockTimeoutMs: 2500,
  lockRetryDelayMs: 50,
  lockRetryBackoff: 1.25,
  maxLockRetryDelayMs: 250,
  maxContentSnippetChars: LIMITS.maxSnippetChars,
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

export const ALLOWED_TYPES = new Set<MemoryType>([
  "note",
  "decision",
  "fact",
  "constraint",
  "todo",
  "architecture",
  "glossary",
]);
