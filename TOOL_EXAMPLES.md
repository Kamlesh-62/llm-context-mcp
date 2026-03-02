# Tool Examples

Copy-paste these prompts into Claude Code, Codex CLI, or Gemini CLI.

---

## memory_status

Check your setup is working.

```
Call memory_status and show the output.
```

---

## memory_help

Get quick-start tips and sample prompts.

```
Call memory_help.
```

---

## memory_save

Save a memory item directly.

```
Call memory_save with:
  title: "API uses JWT auth"
  type: "decision"
  content: "All endpoints require Bearer token in Authorization header. Tokens expire in 24h."
  tags: ["auth", "api"]
```

```
Call memory_save with:
  title: "node version: v20.11.0"
  type: "fact"
  content: "Production and local dev both run Node 20 LTS."
  tags: ["environment", "node"]
  pinned: true
```

Valid types: `note`, `decision`, `fact`, `constraint`, `todo`, `architecture`, `glossary`

---

## memory_get_bundle

Load ranked context before starting a task.

```
Call memory_get_bundle with prompt "fixing login API bugs"
```

```
Call memory_get_bundle with prompt "setting up CI pipeline" and maxItems 20
```

```
Call memory_get_bundle with prompt "database schema" and types ["architecture", "decision"]
```

---

## memory_search

Search saved items by keyword or tags.

```
Call memory_search with query "redis"
```

```
Call memory_search with query "auth" and tags ["api"] and includeContent true
```

```
Call memory_search with query "version" and types ["fact"] and limit 5
```

---

## memory_propose

Save with an approval step (useful for batch captures or when you want review).

```
Call memory_propose with:
  items: [
    { "title": "Use Tailwind for styling", "type": "decision", "content": "Team agreed on Tailwind CSS v4 over styled-components." },
    { "title": "Deploy target is Vercel", "type": "constraint", "content": "All services deploy to Vercel. No Docker in prod." }
  ]
  reason: "decisions from sprint planning"
```

---

## memory_list_proposals

List pending proposals.

```
Call memory_list_proposals
```

```
Call memory_list_proposals with status "approved" and includeContent true
```

---

## memory_approve_proposal

Approve or reject a proposal.

```
Call memory_approve_proposal with proposalId "prop_abc123" and action "approve"
```

Approve with edits:

```
Call memory_approve_proposal with:
  proposalId: "prop_abc123"
  action: "approve"
  edits: { "title": "Better title", "tags": ["updated"] }
```

Reject:

```
Call memory_approve_proposal with proposalId "prop_abc123" and action "reject"
```

---

## memory_pin

Pin important items so they always appear in bundles.

```
Call memory_pin with itemId "mem_abc123" and pinned true
```

Unpin:

```
Call memory_pin with itemId "mem_abc123" and pinned false
```

---

## memory_update

Update fields of an existing item.

```
Call memory_update with itemId "mem_abc123" and title "corrected title"
```

```
Call memory_update with:
  itemId: "mem_abc123"
  content: "Updated: now using PostgreSQL 16 instead of 15"
  tags: ["database", "environment"]
```

---

## memory_delete

Permanently remove an item.

```
Call memory_delete with itemId "mem_abc123"
```

Delete all memory for a project:

```bash
rm -f <projectRoot>/.ai/memory.json
```

---

## memory_compact

Archive old items to keep the store lean.

```
Call memory_compact
```

With custom threshold:

```
Call memory_compact with maxItems 250
```

---

## memory_observe

Push an observation for the suggestion engine to analyze.

```
Call memory_observe with type "bash_command" and content "npm install axios"
```

```
Call memory_observe with type "bash_output" and content "node v20.11.0"
```

```
Call memory_observe with type "file_edit" and content "Modified src/auth/middleware.ts"
```

```
Call memory_observe with type "error" and content "TypeError: Cannot read property 'id' of undefined at auth.ts:42"
```

```
Call memory_observe with type "resolution" and content "Fixed by adding null check before accessing user.id"
```

Observation types: `bash_command`, `bash_output`, `file_edit`, `error`, `resolution`

---

## memory_suggest

See pending suggestions from the engine.

```
Call memory_suggest
```

---

## memory_suggestion_feedback

Accept a suggestion (saves it to memory):

```
Call memory_suggestion_feedback with suggestionId "sug_abc123" and action "accept"
```

Reject a suggestion (lowers that category's score):

```
Call memory_suggestion_feedback with suggestionId "sug_abc123" and action "reject"
```
