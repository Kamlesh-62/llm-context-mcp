import { z } from "zod";

import {
  newId,
  normalizeTags,
  validateType,
  findSimilarItems,
} from "../domain.js";
import { autoCompactStore } from "../maintenance.js";
import { withStore } from "../storage.js";
import { nowIso } from "../runtime.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryItem } from "../types.js";

import { projectRootInput, storeOptions } from "./shared.js";

export function registerWriteTools(server: McpServer): void {
  // memory_save
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
        expiresAt: z.string().optional().describe("ISO 8601 expiry date. Item ignored after this date."),
        supersede: z.boolean().optional().describe("If true, auto-archive the most similar existing item"),
        projectRoot: projectRootInput,
      },
    },
    async ({ type, title, content, tags, pinned, source, expiresAt, supersede, projectRoot }) => {
      const createdAt = nowIso();
      let itemId = "";
      let warning = "";

      await withStore(async (st, ctx) => {
        const trimmedTitle = String(title).trim();
        const trimmedContent = String(content).trim();

        // Contradiction detection
        const similar = findSimilarItems(st.items, trimmedTitle, trimmedContent);
        if (similar.length > 0) {
          if (supersede) {
            const top = similar[0];
            top.item.archivedAt = createdAt;
            top.item.archivedReason = "superseded";
            st.items = st.items.filter((it) => it.id !== top.item.id);
            warning = ` Superseded ${top.item.id} ("${top.item.title.slice(0, 60)}").`;
          } else {
            const hints = similar.slice(0, 3).map(
              (s) => `  - ${s.item.id} (${(s.similarity * 100).toFixed(0)}%): "${s.item.title.slice(0, 60)}"`,
            );
            warning = `\nWarning: similar items found:\n${hints.join("\n")}\nUse supersede:true to auto-archive conflicts.`;
          }
        }

        const item: MemoryItem = {
          id: newId("mem"),
          type: validateType(type),
          title: trimmedTitle,
          content: trimmedContent,
          tags: normalizeTags(tags),
          pinned: Boolean(pinned),
          createdAt,
          updatedAt: createdAt,
          lastUsedAt: createdAt,
          source: source ? String(source).trim() : "direct",
          ...(expiresAt ? { expiresAt } : {}),
        };
        st.items.push(item);
        itemId = item.id;
        await autoCompactStore(st, ctx);
        return true;
      }, storeOptions(projectRoot));

      return {
        content: [{ type: "text", text: `Saved memory item ${itemId}.${warning}` }],
      };
    },
  );

  // memory_pin
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
      await withStore(async (st) => {
        const it = st.items.find((x) => x.id === itemId);
        if (!it) {
          msg = `Item not found: ${itemId}`;
          return false;
        }
        it.pinned = Boolean(pinned);
        it.updatedAt = nowIso();
        msg = `${pinned ? "Pinned" : "Unpinned"} ${itemId}`;
        return true;
      }, storeOptions(projectRoot));
      return { content: [{ type: "text", text: msg }] };
    },
  );

  // memory_update
  server.registerTool(
    "memory_update",
    {
      description: "Update fields of an existing memory item by ID.",
      inputSchema: {
        itemId: z.string().min(1),
        title: z.string().min(1).optional(),
        content: z.string().min(1).optional(),
        type: z
          .string()
          .optional()
          .describe("note|decision|fact|constraint|todo|architecture|glossary"),
        tags: z.array(z.string()).optional(),
        pinned: z.boolean().optional(),
        projectRoot: projectRootInput,
      },
    },
    async ({ itemId, title, content, type, tags, pinned, projectRoot }) => {
      let msg = "";
      await withStore(async (st) => {
        const it = st.items.find((x) => x.id === itemId);
        if (!it) {
          msg = `Item not found: ${itemId}`;
          return false;
        }
        if (type !== undefined) it.type = validateType(type);
        if (title !== undefined) it.title = title.trim();
        if (content !== undefined) it.content = content.trim();
        if (tags !== undefined) it.tags = normalizeTags(tags);
        if (pinned !== undefined) it.pinned = Boolean(pinned);
        it.updatedAt = nowIso();
        msg = `Updated item ${itemId}`;
        return true;
      }, storeOptions(projectRoot));
      return { content: [{ type: "text", text: msg }] };
    },
  );

  // memory_delete
  server.registerTool(
    "memory_delete",
    {
      description: "Permanently remove a memory item by ID.",
      inputSchema: {
        itemId: z.string().min(1),
        projectRoot: projectRootInput,
      },
    },
    async ({ itemId, projectRoot }) => {
      let msg = "";
      await withStore(async (st) => {
        const idx = st.items.findIndex((x) => x.id === itemId);
        if (idx === -1) {
          msg = `Item not found: ${itemId}`;
          return false;
        }
        st.items.splice(idx, 1);
        msg = `Deleted item ${itemId}`;
        return true;
      }, storeOptions(projectRoot));
      return { content: [{ type: "text", text: msg }] };
    },
  );
}
