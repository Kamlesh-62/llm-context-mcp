/**
 * One-time script to populate .ai/memory.json with project context.
 * Run: node dist/hooks/_bootstrap-context.js (after build)
 * Safe to re-run — withStore handles locking.
 */
import { withStore } from "../src/storage.js";
import { newId, normalizeTags, validateType } from "../src/domain.js";
import { nowIso } from "../src/runtime.js";

const items = [
  {
    type: "architecture",
    title: "Project overview: MCP stdio server for shared project memory",
    content:
      "This is an MCP (Model Context Protocol) stdio server that provides shared, project-scoped memory for Claude Code, Codex CLI, and Gemini CLI. All three agents read/write to the same .ai/memory.json file. Entry point: server.ts -> src/main.ts (compiled to dist). Dependencies: @modelcontextprotocol/sdk, zod. ES modules throughout.",
    tags: ["architecture", "overview", "mcp"],
    pin: true,
  },
  {
    type: "architecture",
    title: "Core storage pattern: withStore() for all writes",
    content:
      "src/storage.ts exports withStore(writeFn, opts). It acquires an exclusive file lock, loads the JSON store, calls writeFn(store, ctx), and if writeFn returns true, bumps revision and does an atomic write (tmp + rename). All writes MUST go through withStore. Never write .ai/memory.json directly.",
    tags: ["architecture", "storage", "critical"],
    pin: true,
  },
  {
    type: "fact",
    title: "Store data structure",
    content:
      "{ version: 1, project: { id, root, memoryFile, createdAt, updatedAt }, items: [], proposals: [], revision: number }. Items have: id, type, title, content, tags[], source, pinned, createdAt, updatedAt. Valid types: note, decision, fact, constraint, todo, architecture, glossary.",
    tags: ["data-model", "schema"],
    pin: false,
  },
  {
    type: "architecture",
    title: "Key source files and their roles",
    content:
      "server.ts (entry) -> src/main.ts (MCP bootstrap). src/tools.ts (tool registration and handlers). src/storage.ts (withStore, locking, atomic write). src/domain.ts (newId, normalizeTags, validateType, tokenize, scoreItem). src/runtime.ts (findProjectRoot, resolveMemoryFilePath, nowIso). src/config.ts (constants, ALLOWED_TYPES). src/logger.ts (stderr logger).",
    tags: ["architecture", "file-layout"],
    pin: true,
  },
  {
    type: "fact",
    title: "MCP tools provided by this server",
    content:
      "Read tools: memory_status, memory_search, memory_get_bundle, memory_list_proposals. Direct write: memory_save, memory_pin. Gated write: memory_propose, memory_approve_proposal. All write tools accept optional projectRoot for multi-project routing.",
    tags: ["tools", "api"],
    pin: false,
  },
  {
    type: "fact",
    title: "Project root resolution priority",
    content:
      "1. Tool input projectRoot (if provided). 2. MEMORY_PROJECT_ROOT env var. 3. Nearest ancestor with .git directory. 4. Current working directory. Memory file: MEMORY_FILE_PATH env var or <projectRoot>/.ai/memory.json.",
    tags: ["configuration", "resolution"],
    pin: false,
  },
  {
    type: "architecture",
    title: "Auto-save hook system in hooks/ directory",
    content:
      "hooks/auto-save.ts is a Claude Code Stop hook that auto-captures memory from session transcripts using heuristics (no LLM calls). hooks/extractors.ts has 5 extractors: version facts, commit messages, dependency installs, error resolutions, file changes. hooks/cursor.ts tracks processed lines. Config in .claude/settings.json. Items saved with source: auto-hook.",
    tags: ["hooks", "auto-save", "architecture"],
    pin: true,
  },
  {
    type: "constraint",
    title: "ES modules only, no CommonJS",
    content:
      "package.json has type: module. All files use import/export. Source is TypeScript and compiles to ESM JavaScript in dist/. Do not use require() or module.exports anywhere.",
    tags: ["constraint", "modules"],
    pin: false,
  },
  {
    type: "fact",
    title: "ID generation pattern",
    content:
      "newId(prefix) from src/domain.js generates IDs like mem_a1b2c3d4e5f6. Prefix + underscore + 12 hex chars from crypto.randomUUID(). Memory items use prefix mem, proposals use prefix prop.",
    tags: ["convention", "ids"],
    pin: false,
  },
  {
    type: "constraint",
    title: "No update or delete tools yet",
    content:
      "There is no memory_update or memory_delete tool. To update: save a corrected item with memory_save and tag supersedes:<old_id>. To delete all: rm .ai/memory.json. To delete one: manually edit the JSON.",
    tags: ["constraint", "limitation"],
    pin: false,
  },
];

const { store } = await withStore((store) => {
  const now = nowIso();
  for (const item of items) {
    store.items.push({
      id: newId("mem"),
      type: validateType(item.type),
      title: item.title,
      content: item.content,
      tags: normalizeTags(item.tags),
      source: "bootstrap",
      pinned: item.pin,
      createdAt: now,
      updatedAt: now,
    });
  }
  return true;
});

console.log(`Saved ${items.length} context items. Store revision: ${store.revision}`);
