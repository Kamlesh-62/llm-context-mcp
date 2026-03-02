import { z } from "zod";

import {
  newId,
  normalizeTags,
  validateType,
} from "../domain.js";
import { autoCompactStore } from "../maintenance.js";
import { withStore } from "../storage.js";
import { nowIso } from "../runtime.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryItem } from "../types.js";
import type { SuggestionEngine, ObservationType } from "../suggestions/index.js";

import { projectRootInput, storeOptions } from "./shared.js";

export function registerSuggestionTools(server: McpServer, engine?: SuggestionEngine): void {
  // memory_observe
  server.registerTool(
    "memory_observe",
    {
      description:
        "Push an observation into the suggestion engine for pattern detection.",
      inputSchema: {
        type: z.enum([
          "bash_command",
          "bash_output",
          "file_edit",
          "tool_call",
          "text",
          "error",
          "resolution",
        ]),
        content: z.string().min(1),
        toolName: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        projectRoot: projectRootInput,
      },
    },
    async ({ type, content, toolName, metadata, projectRoot }) => {
      if (!engine) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                observationRecorded: false,
                error: "Suggestion engine not available",
              }),
            },
          ],
        };
      }

      const obs = {
        type: type as ObservationType,
        content: String(content),
        toolName,
        timestamp: nowIso(),
        metadata,
      };

      const suggestions = await engine.observe(obs, projectRoot);

      const autoSaved: string[] = [];
      for (const sug of suggestions) {
        if (sug.autoSave) {
          const createdAt = nowIso();
          await withStore(async (st, ctx) => {
            const item: MemoryItem = {
              id: newId("mem"),
              type: validateType(sug.type),
              title: sug.title,
              content: sug.content,
              tags: normalizeTags([...sug.tags, "auto-suggestion"]),
              pinned: false,
              createdAt,
              updatedAt: createdAt,
              lastUsedAt: createdAt,
              source: "auto-suggestion",
            };
            st.items.push(item);
            autoSaved.push(item.id);
            await autoCompactStore(st, ctx);
            return true;
          }, storeOptions(projectRoot));
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              observationRecorded: true,
              suggestionsGenerated: suggestions.length,
              suggestions,
              autoSaved,
            }, null, 2),
          },
        ],
      };
    },
  );

  // memory_suggest
  server.registerTool(
    "memory_suggest",
    {
      description: "Pull pending suggestions from the suggestion engine.",
      inputSchema: {
        projectRoot: projectRootInput,
      },
    },
    async () => {
      if (!engine) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: 0, suggestions: [], error: "Suggestion engine not available" }),
            },
          ],
        };
      }

      const suggestions = engine.getPendingSuggestions();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { count: suggestions.length, suggestions },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // memory_suggestion_feedback
  server.registerTool(
    "memory_suggestion_feedback",
    {
      description:
        "Accept or reject a suggestion. Accepting saves it as a memory item.",
      inputSchema: {
        suggestionId: z.string().min(1),
        action: z.enum(["accept", "reject"]),
        edits: z
          .object({
            title: z.string().optional(),
            content: z.string().optional(),
            tags: z.array(z.string()).optional(),
            type: z
              .string()
              .optional()
              .describe(
                "note|decision|fact|constraint|todo|architecture|glossary",
              ),
          })
          .optional()
          .describe("Optional edits before accepting"),
        projectRoot: projectRootInput,
      },
    },
    async ({ suggestionId, action, edits, projectRoot }) => {
      if (!engine) {
        return {
          content: [
            { type: "text", text: "Suggestion engine not available" },
          ],
        };
      }

      if (action === "accept") {
        const suggestion = await engine.acceptSuggestion(suggestionId);
        if (!suggestion) {
          return {
            content: [
              { type: "text", text: `Suggestion not found: ${suggestionId}` },
            ],
          };
        }

        const title = edits?.title ?? suggestion.title;
        const content = edits?.content ?? suggestion.content;
        const tags = edits?.tags
          ? normalizeTags([...edits.tags, "suggestion-accepted"])
          : normalizeTags([...suggestion.tags, "suggestion-accepted"]);
        const type = edits?.type
          ? validateType(edits.type)
          : suggestion.type;

        const createdAt = nowIso();
        let itemId = "";
        await withStore(async (st, ctx) => {
          const item: MemoryItem = {
            id: newId("mem"),
            type,
            title: String(title).trim(),
            content: String(content).trim(),
            tags,
            pinned: false,
            createdAt,
            updatedAt: createdAt,
            lastUsedAt: createdAt,
            source: "suggestion-accepted",
          };
          st.items.push(item);
          itemId = item.id;
          await autoCompactStore(st, ctx);
          return true;
        }, storeOptions(projectRoot));

        return {
          content: [
            {
              type: "text",
              text: `Accepted suggestion ${suggestionId} → saved as item ${itemId}`,
            },
          ],
        };
      } else {
        const suggestion = await engine.rejectSuggestion(suggestionId);
        if (!suggestion) {
          return {
            content: [
              { type: "text", text: `Suggestion not found: ${suggestionId}` },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Rejected suggestion ${suggestionId} (feedback updated for ${suggestion.triggeredBy})`,
            },
          ],
        };
      }
    },
  );
}
