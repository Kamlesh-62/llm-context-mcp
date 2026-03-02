import { z } from "zod";

export const projectRootInput = z
  .string()
  .min(1)
  .optional()
  .describe("Target project root path. Use this when server is shared across multiple projects.");

export function storeOptions(projectRoot?: string) {
  return projectRoot ? { projectRoot } : undefined;
}

export const HELP_TEXT = `
Project Memory MCP quick help

Common prompts:
- Call memory_status and show the output. → confirms project + .ai path.
- Call memory_get_bundle with {"prompt":"<your task>"} → load context.
- When you finish work, Call memory_save with {"title":"...", "content":"...", "tags":["..."], "source":"claude"} → saves the new fact/decision immediately.
- Prefer approvals? Call memory_propose with {"items":[...]} then memory_approve_proposal.
- Need to find info later? Call memory_search with {"query":"...", "includeContent":true}.
- Keep the store lean: Call memory_compact with {"maxItems":250} (archives oldest items).
- Call memory_update with {"itemId":"...", "title":"...", ...} → update existing item fields.
- Call memory_delete with {"itemId":"..."} → permanently remove an item.
- Push context for suggestions: Call memory_observe with {"type":"bash_command","content":"npm install axios"}.
- Check pending suggestions: Call memory_suggest.
- Accept/reject: Call memory_suggestion_feedback with {"suggestionId":"...","action":"accept"}.

Every tool accepts optional projectRoot. More details: README.md or docs/LOCAL_SETUP.md.
`.trim();
