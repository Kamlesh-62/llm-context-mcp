import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG } from "../config.js";
import { isExpired } from "../domain.js";
import { withStore } from "../storage.js";
import { normalizeProjectRoot, findProjectRoot, nowIso } from "../runtime.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ArchiveStore, MemoryItem } from "../types.js";

import { projectRootInput, storeOptions } from "./shared.js";

function formatMarkdown(items: MemoryItem[], title: string): string {
  const grouped = new Map<string, MemoryItem[]>();
  for (const item of items) {
    const t = item.type || "note";
    if (!grouped.has(t)) grouped.set(t, []);
    grouped.get(t)!.push(item);
  }

  let out = `# ${title}\n\nGenerated: ${nowIso()}\nItems: ${items.length}\n\n`;

  for (const [type, group] of grouped) {
    out += `## ${type.charAt(0).toUpperCase() + type.slice(1)}s\n\n`;
    for (const it of group.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      out += `### [${it.id}] ${it.title}\n`;
      out += `${it.content}\n`;
      if (it.tags?.length) out += `Tags: ${it.tags.join(", ")}\n`;
      out += `Created: ${it.createdAt}`;
      if (it.pinned) out += ` | Pinned`;
      if (it.expiresAt) out += ` | Expires: ${it.expiresAt}`;
      out += `\n\n`;
    }
  }

  return out;
}

export function registerExportTools(server: McpServer): void {
  server.registerTool(
    "memory_export",
    {
      description: "Export memory items as JSON or Markdown text.",
      inputSchema: {
        format: z.enum(["json", "markdown"]).default("markdown"),
        includeArchived: z.boolean().default(false).describe("Include archived items"),
        types: z.array(z.string()).optional().describe("Filter by item types"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        projectRoot: projectRootInput,
      },
    },
    async ({ format, includeArchived, types, tags, projectRoot }) => {
      const root = normalizeProjectRoot(projectRoot) || await findProjectRoot();

      const { store } = await withStore(async () => false, storeOptions(projectRoot));
      let items = store.items.filter((it) => !isExpired(it));

      if (includeArchived) {
        const archivePath = path.join(root, CONFIG.autoCompact.archiveRelPath);
        try {
          const raw = await fs.readFile(archivePath, "utf8");
          const archive = JSON.parse(raw) as ArchiveStore;
          if (archive && Array.isArray(archive.items)) {
            items = [...items, ...archive.items];
          }
        } catch {
          // no archive
        }
      }

      const typeSet = types?.length ? new Set(types.map((t) => t.toLowerCase())) : null;
      const tagSet = tags?.length ? new Set(tags.map((t) => t.toLowerCase())) : null;

      if (typeSet) items = items.filter((it) => typeSet.has(it.type));
      if (tagSet) items = items.filter((it) => it.tags?.some((t) => tagSet.has(t)));

      let text: string;
      if (format === "json") {
        text = JSON.stringify(items, null, 2);
      } else {
        text = formatMarkdown(items, "Project Memory Export");
      }

      return { content: [{ type: "text", text }] };
    },
  );
}
