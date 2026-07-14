import { z } from "zod";

import {
  safeSnippet,
  scoreItem,
  tokenize,
  normalizeTags,
  validateType,
  isExpired,
} from "../domain.js";
import { CONFIG } from "../config.js";
import { withStore } from "../storage.js";
import { nowIso } from "../runtime.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { projectRootInput, storeOptions, HELP_TEXT } from "./shared.js";

export function registerReadTools(server: McpServer): void {
  // memory_help
  server.registerTool(
    "memory_help",
    {
      description:
        "Show quick-start instructions and sample prompts for all memory tools.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: HELP_TEXT }],
    }),
  );

  // memory_status
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
      const {
        store,
        projectRoot: resolvedProjectRoot,
        memoryFilePath,
      } = await withStore(async () => false, storeOptions(projectRoot));

      const status = {
        projectRoot: resolvedProjectRoot,
        memoryFilePath,
        revision: store.revision || 0,
        counts: {
          items: Array.isArray(store.items) ? store.items.length : 0,
          proposals: Array.isArray(store.proposals)
            ? store.proposals.length
            : 0,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    },
  );

  // memory_search
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
        includeContent: z
          .boolean()
          .default(false)
          .describe("Include full content"),
        staleOnly: z.boolean().default(false).describe("Only return items unused for staleDays (default 90)"),
        projectRoot: projectRootInput,
      },
    },
    async ({ query, limit, types, tags, includeContent, staleOnly, projectRoot }) => {
      const queryTokens = tokenize(query);
      const tagTokens = normalizeTags(tags);

      const typeSet = types?.length
        ? new Set(types.map((t) => validateType(t)))
        : null;

      const now = nowIso();
      const staleThreshold = Date.now() - ((CONFIG.staleDays ?? 90) * 86400000);
      let matches: Array<{ item: typeof store.items[0]; score: number }> = [];
      let store: Awaited<ReturnType<typeof withStore>>["store"];

      await withStore(
        async (st) => {
          store = st;
          let items = st.items.filter((it) => !isExpired(it));

          if (typeSet) {
            items = items.filter((it) => typeSet.has(validateType(it.type)));
          }

          if (staleOnly) {
            items = items.filter((it) => {
              const lastUsed = Date.parse(it.lastUsedAt || it.updatedAt || it.createdAt || "");
              return Number.isFinite(lastUsed) && lastUsed < staleThreshold && !it.pinned;
            });
          }

          matches = items
            .map((it) => ({
              item: it,
              score: scoreItem(it, queryTokens, tagTokens),
            }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

          // Update lastUsedAt on matched items
          const matchedIds = new Set(matches.map((m) => m.item.id));
          let updated = false;
          for (const item of st.items) {
            if (matchedIds.has(item.id)) {
              item.lastUsedAt = now;
              updated = true;
            }
          }
          return updated;
        },
        storeOptions(projectRoot),
      );

      const output = matches.map(({ item, score }) => ({
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
            text: JSON.stringify(
              { count: output.length, results: output },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // memory_get_bundle
  server.registerTool(
    "memory_get_bundle",
    {
      description:
        "Build a compact, ranked context bundle from project memory for the current task.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("What are you working on right now?"),
        maxItems: z.number().int().min(1).max(50).default(12),
        maxChars: z.number().int().min(500).max(20000).default(6000),
        types: z.array(z.string()).optional().describe("Filter by item types"),
        includePinned: z.boolean().default(true),
        projectRoot: projectRootInput,
      },
    },
    async ({
      prompt,
      maxItems,
      maxChars,
      types,
      includePinned,
      projectRoot,
    }) => {
      const queryTokens = tokenize(prompt);
      const typeSet = types?.length
        ? new Set(types.map((t) => validateType(t)))
        : null;
      const now = nowIso();

      let chosen: typeof store.items = [];
      let store: Awaited<ReturnType<typeof withStore>>["store"];

      await withStore(
        async (st) => {
          store = st;
          const active = st.items.filter((it) => !isExpired(it));
          const candidates = typeSet
            ? active.filter((it) => typeSet.has(validateType(it.type)))
            : active;

          const pinned = includePinned ? candidates.filter((x) => x.pinned) : [];
          const rest = candidates
            .filter((x) => !x.pinned)
            .map((it) => ({ item: it, score: scoreItem(it, queryTokens, []) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((x) => x.item);

          chosen = [...pinned, ...rest].slice(0, maxItems);

          // Update lastUsedAt on bundled items
          const chosenIds = new Set(chosen.map((it) => it.id));
          let updated = false;
          for (const item of st.items) {
            if (chosenIds.has(item.id)) {
              item.lastUsedAt = now;
              updated = true;
            }
          }
          return updated;
        },
        storeOptions(projectRoot),
      );

      let out = "# Project Memory Bundle\n\n";
      out += `Generated: ${now}\n`;
      out += `Items: ${chosen.length}\n\n`;

      for (const it of chosen) {
        const header =
          `- [${it.id}] (${it.type}${it.pinned ? ", pinned" : ""}) ${it.title || ""}`.trim();
        const body = safeSnippet(it.content, 800);
        const line = `${header}\n  ${body}\n`;
        if (out.length + line.length > maxChars) break;
        out += `${line}\n`;
      }

      if (!chosen.length) {
        out +=
          "_No matching memory yet. Use `memory_propose` to add project decisions/constraints._\n";
      }

      return { content: [{ type: "text", text: out }] };
    },
  );
}
