import { z } from "zod";

import { compactStoreInPlace } from "../maintenance.js";
import { withStore } from "../storage.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { projectRootInput, storeOptions } from "./shared.js";

export function registerCompactTools(server: McpServer): void {
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
          .describe(
            "Optional override archive file path (default .ai/memory-archive.json).",
          ),
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
      let result: { archived: number; archivePath?: string } = { archived: 0 };
      await withStore(async (st, ctx) => {
        result = await compactStoreInPlace(st, ctx, {
          maxItems,
          archivePath,
          summaryTitle,
          summaryTags,
          summaryMaxEntries,
          reason: "manual",
        });
        return result.archived > 0;
      }, storeOptions(projectRoot));

      const text =
        result.archived > 0
          ? `Archived ${result.archived} item(s) into ${result.archivePath}`
          : "No compaction needed (store below threshold).";

      return { content: [{ type: "text", text }] };
    },
  );
}
