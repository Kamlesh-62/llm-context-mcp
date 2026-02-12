import { z } from "zod";

import {
  newId,
  normalizeTags,
  safeSnippet,
  scoreItem,
  tokenize,
  validateType,
} from "./domain.js";
import { autoCompactStore, compactStoreInPlace } from "./maintenance.js";
import { withStore } from "./storage.js";
import { nowIso } from "./runtime.js";

const projectRootInput = z
  .string()
  .min(1)
  .optional()
  .describe("Target project root path. Use this when server is shared across multiple projects.");

function storeOptions(projectRoot) {
  return projectRoot ? { projectRoot } : undefined;
}

const HELP_TEXT = `
Project Memory MCP quick help

Common prompts:
- Call memory_status and show the output. → confirms project + .ai path.
- Call memory_get_bundle with {"prompt":"<your task>"} → load context.
- When you finish work, Call memory_save with {"title":"...", "content":"...", "tags":["..."], "source":"claude"} → saves the new fact/decision immediately.
- Prefer approvals? Call memory_propose with {"items":[...]} then memory_approve_proposal.
- Need to find info later? Call memory_search with {"query":"...", "includeContent":true}.
- Keep the store lean: Call memory_compact with {"maxItems":250} (archives oldest items).

Every tool accepts optional projectRoot. More details: README.md or docs/LOCAL_SETUP.md.
`.trim();

export function registerTools(server) {
  server.registerTool(
    "memory_help",
    {
      description: "Show quick-start instructions and sample prompts for all memory tools.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: HELP_TEXT }],
    }),
  );

  server.registerTool(
    "memory_status",
    {
      description:
        "Show which project root and memory file this server call resolves to.",
      inputSchema: {
        projectRoot: projectRootInput,
      },
    },
    async ({ projectRoot }) => {
      const { store, projectRoot: resolvedProjectRoot, memoryFilePath } = await withStore(
        async () => false,
        storeOptions(projectRoot),
      );

      const status = {
        projectRoot: resolvedProjectRoot,
        memoryFilePath,
        revision: store.revision || 0,
        counts: {
          items: Array.isArray(store.items) ? store.items.length : 0,
          proposals: Array.isArray(store.proposals) ? store.proposals.length : 0,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    },
  );

  server.registerTool(
    "memory_search",
    {
      description:
        "Search project memory items by keyword and/or tags (approved items only).",
      inputSchema: {
        query: z.string().min(1).describe("Keyword query (case-insensitive)"),
        limit: z.number().int().min(1).max(50).default(10),
        types: z.array(z.string()).optional().describe("Filter by item types"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        includeContent: z.boolean().default(false).describe("Include full content"),
        projectRoot: projectRootInput,
      },
    },
    async ({ query, limit, types, tags, includeContent, projectRoot }) => {
      const queryTokens = tokenize(query);
      const tagTokens = normalizeTags(tags);

      const typeSet = types?.length
        ? new Set(types.map((t) => validateType(t)))
        : null;

      const { store } = await withStore(async () => false, storeOptions(projectRoot));

      const matches = store.items
        .filter((it) => (typeSet ? typeSet.has(validateType(it.type)) : true))
        .map((it) => ({
          item: it,
          score: scoreItem(it, queryTokens, tagTokens),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ item, score }) => ({
          id: item.id,
          type: item.type,
          title: item.title,
          tags: item.tags || [],
          pinned: Boolean(item.pinned),
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          score,
          snippet: safeSnippet(item.content),
          ...(includeContent ? { content: String(item.content || "") } : {}),
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: matches.length, results: matches }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "memory_get_bundle",
    {
      description:
        "Build a compact, ranked context bundle from project memory for the current task.",
      inputSchema: {
        prompt: z.string().min(1).describe("What are you working on right now?"),
        maxItems: z.number().int().min(1).max(50).default(12),
        maxChars: z.number().int().min(500).max(20000).default(6000),
        types: z.array(z.string()).optional().describe("Filter by item types"),
        includePinned: z.boolean().default(true),
        projectRoot: projectRootInput,
      },
    },
    async ({ prompt, maxItems, maxChars, types, includePinned, projectRoot }) => {
      const queryTokens = tokenize(prompt);
      const typeSet = types?.length
        ? new Set(types.map((t) => validateType(t)))
        : null;

      const { store } = await withStore(async () => false, storeOptions(projectRoot));

      const candidates = store.items.filter((it) =>
        typeSet ? typeSet.has(validateType(it.type)) : true,
      );

      const pinned = includePinned ? candidates.filter((x) => x.pinned) : [];
      const rest = candidates
        .filter((x) => !x.pinned)
        .map((it) => ({ item: it, score: scoreItem(it, queryTokens, []) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.item);

      const chosen = [...pinned, ...rest].slice(0, maxItems);

      let out = "# Project Memory Bundle\n\n";
      out += `Generated: ${nowIso()}\n`;
      out += `Items: ${chosen.length}\n\n`;

      for (const it of chosen) {
        const header = `- [${it.id}] (${it.type}${it.pinned ? ", pinned" : ""}) ${it.title || ""}`.trim();
        const body = safeSnippet(it.content, 800);
        const line = `${header}\n  ${body}\n`;
        if (out.length + line.length > maxChars) break;
        out += `${line}\n`;
      }

      if (!chosen.length) {
        out += "_No matching memory yet. Use `memory_propose` to add project decisions/constraints._\n";
      }

      return { content: [{ type: "text", text: out }] };
    },
  );

  server.registerTool(
    "memory_propose",
    {
      description:
        "Propose new project memory items (pending approval). Use this for new decisions/constraints/facts you want persisted for this project.",
      inputSchema: {
        items: z
          .array(
            z.object({
              type: z.string().optional().describe("note|decision|fact|constraint|todo|architecture|glossary"),
              title: z.string().min(1),
              content: z.string().min(1),
              tags: z.array(z.string()).optional(),
              pinned: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(25),
        reason: z.string().optional().describe("Why this should be saved"),
        projectRoot: projectRootInput,
      },
    },
    async ({ items, reason, projectRoot }) => {
      const createdAt = nowIso();
      const proposalIds = [];

      await withStore(
        async (st) => {
          for (const raw of items) {
            const proposal = {
              id: newId("prop"),
              type: validateType(raw.type),
              title: String(raw.title).trim(),
              content: String(raw.content).trim(),
              tags: normalizeTags(raw.tags),
              pinned: Boolean(raw.pinned),
              status: "pending",
              createdAt,
              updatedAt: createdAt,
              reason: reason ? String(reason).trim() : "",
            };
            st.proposals.push(proposal);
            proposalIds.push(proposal.id);
          }
          return true;
        },
        storeOptions(projectRoot),
      );

      const text =
        `Proposals created (${proposalIds.length}).\n` +
        "Next: review + approve with memory_list_proposals / memory_approve_proposal.\n" +
        `Proposal IDs: ${proposalIds.join(", ")}`;

      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "memory_save",
    {
      description:
        "Save a memory item directly (no approval step). Use this for finalized context after code changes.",
      inputSchema: {
        type: z
          .string()
          .optional()
          .describe("note|decision|fact|constraint|todo|architecture|glossary"),
        title: z.string().min(1),
        content: z.string().min(1),
        tags: z.array(z.string()).optional(),
        pinned: z.boolean().optional(),
        source: z.string().optional().describe("e.g. claude|codex|gemini"),
        projectRoot: projectRootInput,
      },
    },
    async ({ type, title, content, tags, pinned, source, projectRoot }) => {
      const createdAt = nowIso();
      let itemId = "";

      await withStore(
        async (st, ctx) => {
          const item = {
            id: newId("mem"),
            type: validateType(type),
            title: String(title).trim(),
            content: String(content).trim(),
            tags: normalizeTags(tags),
            pinned: Boolean(pinned),
            createdAt,
            updatedAt: createdAt,
            lastUsedAt: createdAt,
            source: source ? String(source).trim() : "direct",
          };
          st.items.push(item);
          itemId = item.id;
          await autoCompactStore(st, ctx);
          return true;
        },
        storeOptions(projectRoot),
      );

      return { content: [{ type: "text", text: `Saved memory item ${itemId}` }] };
    },
  );

  server.registerTool(
    "memory_list_proposals",
    {
      description: "List pending memory proposals for this project.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        status: z.enum(["pending", "approved", "rejected"]).default("pending"),
        includeContent: z.boolean().default(false),
        projectRoot: projectRootInput,
      },
    },
    async ({ limit, status, includeContent, projectRoot }) => {
      const { store } = await withStore(async () => false, storeOptions(projectRoot));
      const proposals = store.proposals
        .filter((p) => (status ? p.status === status : true))
        .slice(-limit)
        .map((p) => ({
          id: p.id,
          status: p.status,
          type: p.type,
          title: p.title,
          tags: p.tags || [],
          pinned: Boolean(p.pinned),
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          reason: p.reason || "",
          snippet: safeSnippet(p.content),
          ...(includeContent ? { content: String(p.content || "") } : {}),
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: proposals.length, proposals }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "memory_approve_proposal",
    {
      description:
        "Approve or reject a memory proposal. Approving persists it as a project memory item.",
      inputSchema: {
        proposalId: z.string().min(1),
        action: z.enum(["approve", "reject"]),
        edits: z
          .object({
            type: z.string().optional(),
            title: z.string().optional(),
            content: z.string().optional(),
            tags: z.array(z.string()).optional(),
            pinned: z.boolean().optional(),
          })
          .optional()
          .describe("Optional edits before approval/rejection"),
        projectRoot: projectRootInput,
      },
    },
    async ({ proposalId, action, edits, projectRoot }) => {
      const decidedAt = nowIso();

      let resultText = "";
      await withStore(
        async (st, ctx) => {
          const p = st.proposals.find((x) => x.id === proposalId);
          if (!p) {
            resultText = `Proposal not found: ${proposalId}`;
            return false;
          }

          if (p.status !== "pending") {
            resultText = `Proposal ${proposalId} is already ${p.status}`;
            return false;
          }

          if (edits) {
            if (edits.type) p.type = validateType(edits.type);
            if (typeof edits.title === "string") p.title = edits.title.trim();
            if (typeof edits.content === "string") p.content = edits.content.trim();
            if (edits.tags) p.tags = normalizeTags(edits.tags);
            if (typeof edits.pinned === "boolean") p.pinned = edits.pinned;
          }

          p.status = action === "approve" ? "approved" : "rejected";
          p.updatedAt = decidedAt;

          if (action === "approve") {
            const item = {
              id: newId("mem"),
              type: p.type,
              title: p.title,
              content: p.content,
              tags: p.tags || [],
              pinned: Boolean(p.pinned),
              createdAt: decidedAt,
              updatedAt: decidedAt,
              lastUsedAt: decidedAt,
              source: "proposal",
              proposalId: p.id,
            };
            st.items.push(item);
            await autoCompactStore(st, ctx);
            resultText = `Approved ${proposalId} -> saved as item ${item.id}`;
          } else {
            resultText = `Rejected ${proposalId}`;
          }

          return true;
        },
        storeOptions(projectRoot),
      );

      return { content: [{ type: "text", text: resultText }] };
    },
  );

  server.registerTool(
    "memory_pin",
    {
      description: "Pin or unpin an existing memory item.",
      inputSchema: {
        itemId: z.string().min(1),
        pinned: z.boolean(),
        projectRoot: projectRootInput,
      },
    },
    async ({ itemId, pinned, projectRoot }) => {
      let msg = "";
      await withStore(
        async (st) => {
          const it = st.items.find((x) => x.id === itemId);
          if (!it) {
            msg = `Item not found: ${itemId}`;
            return false;
          }
          it.pinned = Boolean(pinned);
          it.updatedAt = nowIso();
          msg = `${pinned ? "Pinned" : "Unpinned"} ${itemId}`;
          return true;
        },
        storeOptions(projectRoot),
      );
      return { content: [{ type: "text", text: msg }] };
    },
  );

  server.registerTool(
    "memory_compact",
    {
      description:
        "Archive older memory items into a separate file and add a summary entry to keep the main store small.",
      inputSchema: {
        maxItems: z
          .number()
          .int()
          .min(10)
          .max(2000)
          .optional()
          .describe("Maximum items to keep active after compaction."),
        archivePath: z
          .string()
          .optional()
          .describe("Optional override archive file path (default .ai/memory-archive.json)."),
        summaryTitle: z.string().optional(),
        summaryTags: z.array(z.string()).optional(),
        summaryMaxEntries: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("How many archived items to list in the summary body."),
        projectRoot: projectRootInput,
      },
    },
    async ({
      maxItems,
      archivePath,
      summaryTitle,
      summaryTags,
      summaryMaxEntries,
      projectRoot,
    }) => {
      let result = { archived: 0 };
      await withStore(
        async (st, ctx) => {
          result = await compactStoreInPlace(st, ctx, {
            maxItems,
            archivePath,
            summaryTitle,
            summaryTags,
            summaryMaxEntries,
            reason: "manual",
          });
          return result.archived > 0;
        },
        storeOptions(projectRoot),
      );

      const text =
        result.archived > 0
          ? `Archived ${result.archived} item(s) into ${result.archivePath}`
          : "No compaction needed (store below threshold).";

      return { content: [{ type: "text", text }] };
    },
  );
}
