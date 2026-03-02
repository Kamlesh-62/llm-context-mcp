import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.prompt(
    "memory_status",
    "Show project root and memory file status",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: "Call memory_status and show the output." },
        },
      ],
    }),
  );

  server.prompt(
    "memory_bundle",
    "Load a context bundle for a task",
    { task: z.string().describe("What are you working on?") },
    ({ task }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Call memory_get_bundle with {"prompt":"${task}"} and summarize the results.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "memory_save",
    "Save a memory item directly",
    {
      title: z.string().describe("Title of the memory item"),
      content: z.string().describe("Content to save"),
    },
    ({ title, content }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Call memory_save with {"title":"${title}","content":"${content}"}.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "memory_search",
    "Search project memory",
    { query: z.string().describe("Search query") },
    ({ query }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Call memory_search with {"query":"${query}","includeContent":true} and show results.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "memory_propose",
    "Propose a new memory item for approval",
    {
      title: z.string().describe("Title of the proposal"),
      content: z.string().describe("Content of the proposal"),
    },
    ({ title, content }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Call memory_propose with {"items":[{"title":"${title}","content":"${content}"}]}.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "memory_list_proposals",
    "List pending memory proposals",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: "Call memory_list_proposals and show pending proposals.",
          },
        },
      ],
    }),
  );

  server.prompt(
    "memory_compact",
    "Archive old memory items",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: "Call memory_compact to archive old items and show results.",
          },
        },
      ],
    }),
  );

  server.prompt(
    "memory_observe",
    "Push an observation for suggestion detection",
    {
      type: z.string().describe("Observation type: bash_command|bash_output|file_edit|tool_call|text|error|resolution"),
      content: z.string().describe("Observation content"),
    },
    ({ type, content }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Call memory_observe with {"type":"${type}","content":"${content}"} and report any suggestions.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "memory_suggest",
    "Show pending suggestions",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: "Call memory_suggest and show any pending suggestions.",
          },
        },
      ],
    }),
  );

  server.prompt(
    "memory_feedback",
    "Accept or reject a suggestion",
    {
      suggestionId: z.string().describe("Suggestion ID"),
      action: z.string().describe("accept or reject"),
    },
    ({ suggestionId, action }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Call memory_suggestion_feedback with {"suggestionId":"${suggestionId}","action":"${action}"}.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "memory_help",
    "Show quick-start guide",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: "Call memory_help and show the quick-start guide.",
          },
        },
      ],
    }),
  );
}
