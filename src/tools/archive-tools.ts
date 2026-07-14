import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

import { scoreItem, tokenize, safeSnippet } from "../domain.js";
import { CONFIG } from "../config.js";
import { withStore } from "../storage.js";
import { nowIso, normalizeProjectRoot, findProjectRoot } from "../runtime.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ArchiveStore } from "../types.js";

import { projectRootInput, storeOptions } from "./shared.js";

async function loadArchive(projectRoot: string): Promise<{ archive: ArchiveStore; archivePath: string }> {
  const archivePath = path.join(projectRoot, CONFIG.autoCompact.archiveRelPath);
  try {
    const raw = await fs.readFile(archivePath, "utf8");
    const parsed = JSON.parse(raw) as ArchiveStore;
    if (parsed && Array.isArray(parsed.items)) {
      return { archive: parsed, archivePath };
    }
  } catch {
    // missing or corrupt
  }
  return {
    archive: {
      version: 1,
      projectRoot,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      items: [],
      revision: 0,
    },
    archivePath,
  };
}

export function registerArchiveTools(server: McpServer): void {
  server.registerTool(
    "memory_search_archive",
    {
      description: "Search archived memory items in .ai/memory-archive.json.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
        includeContent: z.boolean().default(false),
        projectRoot: projectRootInput,
      },
    },
    async ({ query, limit, includeContent, projectRoot }) => {
      const root = normalizeProjectRoot(projectRoot) || await findProjectRoot();
      const { archive } = await loadArchive(root);

      const queryTokens = tokenize(query);
      const matches = archive.items
        .map((it) => ({ item: it, score: scoreItem(it, queryTokens, []) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ item, score }) => ({
          id: item.id,
          type: item.type,
          title: item.title,
          tags: item.tags || [],
          archivedAt: item.archivedAt,
          archivedReason: item.archivedReason,
          score,
          snippet: safeSnippet(item.content),
          ...(includeContent ? { content: item.content } : {}),
        }));

      return {
        content: [{ type: "text", text: JSON.stringify({ count: matches.length, results: matches }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "memory_restore",
    {
      description: "Restore an archived item back to active memory.",
      inputSchema: {
        itemId: z.string().min(1),
        projectRoot: projectRootInput,
      },
    },
    async ({ itemId, projectRoot }) => {
      const root = normalizeProjectRoot(projectRoot) || await findProjectRoot();
      const { archive, archivePath } = await loadArchive(root);

      const idx = archive.items.findIndex((it) => it.id === itemId);
      if (idx === -1) {
        return { content: [{ type: "text", text: `Item not found in archive: ${itemId}` }] };
      }

      const [restored] = archive.items.splice(idx, 1);
      delete restored.archivedAt;
      delete restored.archivedReason;
      restored.updatedAt = nowIso();
      restored.lastUsedAt = nowIso();

      // Write archive back
      archive.updatedAt = nowIso();
      archive.revision = (archive.revision || 0) + 1;
      await fs.mkdir(path.dirname(archivePath), { recursive: true });
      const tmp = `${archivePath}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(archive, null, 2), "utf8");
      await fs.rename(tmp, archivePath);

      // Add to active store
      await withStore(async (st) => {
        st.items.push(restored);
        return true;
      }, storeOptions(projectRoot));

      return {
        content: [{ type: "text", text: `Restored item ${itemId} ("${restored.title.slice(0, 60)}") to active memory.` }],
      };
    },
  );
}
