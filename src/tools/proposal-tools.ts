import { z } from "zod";

import {
  newId,
  normalizeTags,
  safeSnippet,
  validateType,
} from "../domain.js";
import { autoCompactStore } from "../maintenance.js";
import { withStore } from "../storage.js";
import { nowIso } from "../runtime.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryItem, MemoryProposal } from "../types.js";

import { projectRootInput, storeOptions } from "./shared.js";

export function registerProposalTools(server: McpServer): void {
  // memory_propose
  server.registerTool(
    "memory_propose",
    {
      description:
        "Propose new project memory items (pending approval). Use this for new decisions/constraints/facts you want persisted for this project.",
      inputSchema: {
        items: z
          .array(
            z.object({
              type: z
                .string()
                .optional()
                .describe(
                  "note|decision|fact|constraint|todo|architecture|glossary",
                ),
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
      const proposalIds: string[] = [];

      await withStore(async (st) => {
        for (const raw of items) {
          const proposal: MemoryProposal = {
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
      }, storeOptions(projectRoot));

      const text =
        `Proposals created (${proposalIds.length}).\n` +
        "Next: review + approve with memory_list_proposals / memory_approve_proposal.\n" +
        `Proposal IDs: ${proposalIds.join(", ")}`;

      return { content: [{ type: "text", text }] };
    },
  );

  // memory_list_proposals
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
      const { store } = await withStore(
        async () => false,
        storeOptions(projectRoot),
      );
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
            text: JSON.stringify(
              { count: proposals.length, proposals },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // memory_approve_proposal
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
      await withStore(async (st, ctx) => {
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
          if (typeof edits.content === "string")
            p.content = edits.content.trim();
          if (edits.tags) p.tags = normalizeTags(edits.tags);
          if (typeof edits.pinned === "boolean") p.pinned = edits.pinned;
        }

        p.status = action === "approve" ? "approved" : "rejected";
        p.updatedAt = decidedAt;

        if (action === "approve") {
          const item: MemoryItem = {
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
      }, storeOptions(projectRoot));

      return { content: [{ type: "text", text: resultText }] };
    },
  );
}
