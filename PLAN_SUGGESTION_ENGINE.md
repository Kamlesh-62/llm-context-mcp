# Plan: Memory Suggestion Engine

## Context

The MCP server has post-session extractors (`hooks/extractors.ts`) that detect patterns like version checks, dependency installs, error→fix cycles, and config changes from transcripts. But these only run at session end. The suggestion engine promotes these to a **live, mid-session pipeline** with scoring, threshold gating, MCP notifications, and a feedback loop that learns which patterns the developer cares about.

The MCP server can only observe its own tool calls — it doesn't see the agent's bash commands or file edits directly. The bridge is a `memory_observe` tool that agents call to push observations into the engine.

## Architecture

```
Agent activity → memory_observe(obs[]) → SuggestionEngine
                                              ├─ Rules (reuse extractor regexes)
                                              ├─ Scoring (base × recency × feedback)
                                              ├─ Threshold gate (score >= 3)
                                              │    ├─ score >= 5 + autoSave → withStore()
                                              │    └─ score >= 3 → MCP notification
                                              └─ Feedback (.ai/suggestion-feedback.json)
                                                   ├─ accept → multiplier += 0.15 (cap 2.0)
                                                   └─ reject → multiplier -= 0.2  (floor 0.3)
```

## Files Modified

| File | Change |
|------|--------|
| `src/suggestions.ts` | **NEW** — Engine class, rules, feedback persistence, types |
| `src/tools.ts` | Add 3 tools: `memory_observe`, `memory_suggest`, `memory_suggestion_feedback` + update HELP_TEXT |
| `src/prompts.ts` | **NEW** — Register MCP prompts (slash commands) for all tools |
| `src/main.ts` | Instantiate engine, pass to `registerTools`, call `registerPrompts` |
| `src/config.ts` | Add `SuggestionConfig` type + defaults |
| `hooks/extractors.ts` | Export 6 regex constants (add `export` keyword, no logic change) |
| `docs/FEATURE_STATUS.md` | Update §4.5 status table |

## Detailed Changes

### 1. Export regexes — `hooks/extractors.ts`

Add `export` to lines 19-24: `RE_VERSION`, `RE_VERSION_OUTPUT`, `RE_COMMIT`, `RE_NPM_INSTALL`, `RE_PIP_INSTALL`, `RE_CARGO_ADD`. No logic changes.

### 2. Suggestion config — `src/config.ts`

Add `SuggestionConfig` type and `suggestions` field to `Config`/`CONFIG`:

```typescript
export type SuggestionConfig = {
  notifyThreshold: number;     // 3
  autoSaveThreshold: number;   // 5
  autoSaveEnabled: boolean;    // false (opt-in)
  maxWindowSize: number;       // 50 observations
  feedbackIncrement: number;   // 0.15
  feedbackDecrement: number;   // 0.2
  feedbackMin: number;         // 0.3
  feedbackMax: number;         // 2.0
  feedbackRelPath: string;     // ".ai/suggestion-feedback.json"
};
```

### 3. Core engine — `src/suggestions.ts` (new file)

**Types:**
- `ObservationType` = `"bash_command" | "bash_output" | "file_edit" | "tool_call" | "text" | "error" | "resolution"`
- `Observation` = `{ type, content, toolName?, timestamp, metadata? }`
- `RuleCategory` = `"version-check" | "dependency-change" | "deploy-release" | "error-fix" | "config-change"`
- `Suggestion` = `{ id, type, title, content, tags[], confidence (0-1), priority (1-5), autoSave, source, triggeredBy, score, createdAt }`
- `CategoryFeedback` = `{ multiplier, accepts, rejects }`
- `FeedbackStore` = `{ categories: Record<RuleCategory, CategoryFeedback>, updatedAt }`

**5 rules** (import regexes from `hooks/extractors.ts`):

| Rule | Base Weight | Matches | Memory Type |
|------|-------------|---------|-------------|
| version-check | 2 | `RE_VERSION` on bash_command/bash_output | fact |
| dependency-change | 3 | `RE_NPM_INSTALL`, `RE_PIP_INSTALL`, `RE_CARGO_ADD` on bash_command | fact |
| deploy-release | 3 | `/docker push\|npm publish\|git tag\|deploy\|kubectl apply/i` on bash_command | note |
| error-fix | 4 | `error` observation followed by `resolution` observation (window context) | fact |
| config-change | 2 | `/\.(env\|config\|ya?ml\|toml\|ini\|json\|rc)$/i` on file_edit | fact |

**`SuggestionEngine` class:**
- `constructor(config)` — merges with defaults from `CONFIG.suggestions`
- `setServer(server: McpServer)` — stores reference for notifications
- `setProjectRoot(projectRoot)` — resolves feedback file path
- `observe(obs, projectRoot?)` → `Suggestion[]` — adds to FIFO window (max 50), runs rules, scores, notifies via `server.server.sendLoggingMessage()`, returns suggestions above threshold
- `getPendingSuggestions()` → `Suggestion[]` — pull model for clients without notification support
- `acceptSuggestion(id)` / `rejectSuggestion(id)` — removes from pending, updates feedback multiplier
- Private: `loadFeedback()`, `updateFeedback(category, action)`, `saveFeedback()` — atomic read/write to `.ai/suggestion-feedback.json`
- Private: `buildSuggestion(rule, match, feedback)` — computes `score = baseWeight × recencyBoost × feedbackMultiplier`, normalizes confidence to 0-1, caps priority at 5
- Private: `evaluateErrorFix(obs)` — pairs `error`/`bash_output` with subsequent `resolution` observations
- Private: `notify(suggestion)` — `sendLoggingMessage({ level: "info", logger: "suggestion-engine", data: { type: "memory_suggestion", ...suggestion } })`

**Recency boost:** 1.5 if observation is within last 2 window entries, 1.2 if within last 5, 1.0 otherwise.

### 4. New tools — `src/tools.ts`

Change signature: `registerTools(server: McpServer, engine?: SuggestionEngine)`.

**`memory_observe`** — Agent pushes an observation:
- Input: `type` (ObservationType enum), `content` (string), `toolName?`, `metadata?`, `projectRoot?`
- Calls `engine.observe()`, auto-saves suggestions with `autoSave: true` via `withStore()` (tagged `auto-suggestion`)
- Returns JSON with `{ observationRecorded, suggestionsGenerated, suggestions[], autoSaved[] }`

**`memory_suggest`** — Pull pending suggestions:
- Input: `projectRoot?`
- Returns `engine.getPendingSuggestions()` as JSON

**`memory_suggestion_feedback`** — Accept or reject:
- Input: `suggestionId`, `action` (accept/reject), `edits?` (optional title/content/tags/type overrides), `projectRoot?`
- Accept: saves to memory via `withStore()` (tagged `suggestion-accepted`), triggers `autoCompactStore`
- Reject: just updates feedback multiplier
- Returns confirmation message

**HELP_TEXT additions:**
```
- Push context for suggestions: Call memory_observe with {"type":"bash_command","content":"npm install axios"}.
- Check pending suggestions: Call memory_suggest.
- Accept/reject: Call memory_suggestion_feedback with {"suggestionId":"...","action":"accept"}.
```

### 5. MCP Prompts (slash commands) — `src/prompts.ts` (new file)

MCP prompts appear as `/command` suggestions in Claude Code and other MCP clients. Each prompt returns a message that instructs the AI which tool to call and with what parameters.

**`registerPrompts(server: McpServer)`** — registers all prompts:

| Prompt Name | Args | Injected Message |
|---|---|---|
| `memory_status` | none | "Call memory_status and show the output." |
| `memory_bundle` | `task` (string, required) | "Call memory_get_bundle with {\"prompt\":\"<task>\"} and summarize the results." |
| `memory_save` | `title` (string), `content` (string) | "Call memory_save with {\"title\":\"...\",\"content\":\"...\"}." |
| `memory_search` | `query` (string, required) | "Call memory_search with {\"query\":\"<query>\",\"includeContent\":true} and show results." |
| `memory_propose` | `title` (string), `content` (string) | "Call memory_propose with {\"items\":[{\"title\":\"...\",\"content\":\"...\"}]}." |
| `memory_list_proposals` | none | "Call memory_list_proposals and show pending proposals." |
| `memory_compact` | none | "Call memory_compact to archive old items and show results." |
| `memory_observe` | `type` (enum), `content` (string) | "Call memory_observe with {\"type\":\"...\",\"content\":\"...\"} and report any suggestions." |
| `memory_suggest` | none | "Call memory_suggest and show any pending suggestions." |
| `memory_feedback` | `suggestionId` (string), `action` (accept/reject) | "Call memory_suggestion_feedback with {\"suggestionId\":\"...\",\"action\":\"...\"}." |
| `memory_help` | none | "Call memory_help and show the quick-start guide." |

Each prompt callback returns `{ messages: [{ role: "user", content: [{ type: "text", text: "..." }] }] }`.

### 6. Wire engine — `src/main.ts`

- Import `SuggestionEngine` from `./suggestions.js`
- Import `registerPrompts` from `./prompts.js`
- Create instance: `const engine = new SuggestionEngine(CONFIG.suggestions)`
- Call `engine.setServer(server)` before `registerTools`
- Pass to: `registerTools(server, engine)`
- Call `registerPrompts(server)` after `registerTools`
- After `findProjectRoot()`: call `engine.setProjectRoot(projectRoot)`

### 6. Update docs — `docs/FEATURE_STATUS.md`

Update §4.5 table:

| Component | Status |
|---|---|
| Mid-session notification delivery | Implemented (`memory_observe` → `sendLoggingMessage`) |
| Scoring + threshold gating | Implemented (base × recency × feedback, threshold 3/5) |
| Feedback loop + weight tuning | Implemented (`.ai/suggestion-feedback.json`) |
| Suggestion payload with confidence/priority | Implemented |

## Key Design Decisions

- **Auto-save OFF by default** — even when enabled, only score >= 5 auto-saves. Avoids polluting memory without opt-in.
- **Notifications are best-effort** — wrapped in try/catch; failures logged to stderr. Suggestions still accumulate for pull-based retrieval.
- **Feedback is simple atomic write** — not using `withStore()` (that's for `memory.json`). Atomic write via tmp+rename. Small race window acceptable.
- **Engine is stateless across server restarts** — observation window resets each session. Only feedback multipliers persist.

## Reused Utilities

- `withStore()` from `src/storage.ts` — for auto-save and accept flows
- `newId("sug")` from `src/domain.ts` — suggestion IDs
- `validateType()`, `normalizeTags()` from `src/domain.ts` — input validation
- `nowIso()` from `src/runtime.ts` — timestamps
- `autoCompactStore()` from `src/maintenance.ts` — on accepted suggestions
- `storeOptions()`, `projectRootInput` from `src/tools.ts` — shared helpers
- `RE_VERSION`, `RE_NPM_INSTALL`, `RE_PIP_INSTALL`, `RE_CARGO_ADD` from `hooks/extractors.ts` — regex patterns

## Verification

1. `npm run build` — TypeScript compiles cleanly
2. Start server, call `memory_observe` with a bash_command observation like `{"type":"bash_command","content":"npm install axios"}` — should return a suggestion with `triggeredBy: "dependency-change"`
3. Call `memory_suggest` — should list pending suggestions
4. Call `memory_suggestion_feedback` with `action: "accept"` — should save to `.ai/memory.json` and update `.ai/suggestion-feedback.json`
5. Call `memory_suggestion_feedback` with `action: "reject"` on another suggestion — verify multiplier decreased in feedback file
6. Verify notifications appear in MCP client logs (if client supports `notifications/message`)

---

## Micro-Task Checklist

### A. Export regexes — `hooks/extractors.ts`
- [x] A1. Add `export` to `RE_VERSION` (line 19)
- [x] A2. Add `export` to `RE_VERSION_OUTPUT` (line 20)
- [x] A3. Add `export` to `RE_COMMIT` (line 21)
- [x] A4. Add `export` to `RE_NPM_INSTALL` (line 22)
- [x] A5. Add `export` to `RE_PIP_INSTALL` (line 23)
- [x] A6. Add `export` to `RE_CARGO_ADD` (line 24)

### B. Suggestion config — `src/config.ts`
- [x] B1. Add `SuggestionConfig` type definition (9 fields)
- [x] B2. Add `suggestions` field to `Config` type
- [x] B3. Add `suggestions` default values object to `CONFIG`

### C. Core engine types — `src/suggestions.ts`
- [x] C1. Create file with imports (zod, domain, runtime, config, extractors, storage, maintenance, McpServer)
- [x] C2. Define `ObservationType` type (7 variants)
- [x] C3. Define `Observation` interface (`type`, `content`, `toolName?`, `timestamp`, `metadata?`)
- [x] C4. Define `RuleCategory` type (5 variants)
- [x] C5. Define `Suggestion` interface (12 fields: `id`, `type`, `title`, `content`, `tags`, `confidence`, `priority`, `autoSave`, `source`, `triggeredBy`, `score`, `createdAt`)
- [x] C6. Define `CategoryFeedback` interface (`multiplier`, `accepts`, `rejects`)
- [x] C7. Define `FeedbackStore` interface (`categories`, `updatedAt`)

### D. Core engine rules — `src/suggestions.ts`
- [x] D1. Define `SuggestionRule` internal type (`category`, `baseWeight`, `memoryType`, `match` function)
- [x] D2. Define `RE_DEPLOY` regex (`/docker push|npm publish|git tag|deploy|kubectl apply/i`)
- [x] D3. Define `RE_CONFIG_FILE` regex (`/\.(env|config|ya?ml|toml|ini|json|rc)$/i`)
- [x] D4. Implement `version-check` rule (base weight 2, matches `RE_VERSION` on `bash_command`/`bash_output`, memory type `fact`)
- [x] D5. Implement `dependency-change` rule (base weight 3, matches `RE_NPM_INSTALL`/`RE_PIP_INSTALL`/`RE_CARGO_ADD` on `bash_command`)
- [x] D6. Implement `deploy-release` rule (base weight 3, matches `RE_DEPLOY` on `bash_command`, memory type `note`)
- [x] D7. Implement `error-fix` rule stub (base weight 4, delegates to `evaluateErrorFix`, memory type `fact`)
- [x] D8. Implement `config-change` rule (base weight 2, matches `RE_CONFIG_FILE` on `file_edit`, memory type `fact`)

### E. SuggestionEngine class — constructor & setters
- [x] E1. Define class with private fields: `config`, `server`, `projectRoot`, `feedbackPath`, `window` (Observation[]), `pending` (Suggestion[]), `feedbackCache`
- [x] E2. Implement `constructor(config?)` — merge with `CONFIG.suggestions` defaults
- [x] E3. Implement `setServer(server: McpServer)` — store reference
- [x] E4. Implement `setProjectRoot(projectRoot: string)` — resolve feedback file path from config

### F. SuggestionEngine — feedback persistence
- [x] F1. Implement private `defaultFeedback()` — returns `FeedbackStore` with all categories at multiplier 1.0
- [x] F2. Implement private `loadFeedback()` — reads `.ai/suggestion-feedback.json`, returns parsed or default, caches in memory
- [x] F3. Implement private `saveFeedback(feedback: FeedbackStore)` — atomic write via tmp+rename to `.ai/suggestion-feedback.json`
- [x] F4. Implement private `updateFeedback(category, action: "accept"|"reject")` — loads, adjusts multiplier (±0.15/0.2, clamped to 0.3–2.0), increments counter, saves

### G. SuggestionEngine — scoring & suggestion building
- [x] G1. Implement private `recencyBoost(obsIndex, windowLength)` — 1.5 if within last 2, 1.2 if within last 5, 1.0 otherwise
- [x] G2. Implement private `buildSuggestion(rule, matchContent, obs, obsIndex)` — compute `score = baseWeight × recencyBoost × feedbackMultiplier`, normalize confidence to 0–1 (score/10 capped at 1), priority = ceil(score) capped at 5, set `autoSave` flag if score >= autoSaveThreshold && autoSaveEnabled
- [x] G3. Implement private `evaluateErrorFix(obs)` — scan window for `error`/`bash_output` error patterns followed by `resolution`, return match content or null

### H. SuggestionEngine — notification
- [x] H1. Implement private `notify(suggestion)` — call `server.server.sendLoggingMessage({ level: "info", logger: "suggestion-engine", data: { type: "memory_suggestion", ...suggestion } })` wrapped in try/catch

### I. SuggestionEngine — public API
- [x] I1. Implement `observe(obs: Observation, projectRoot?: string)` → `Suggestion[]` — push to FIFO window (trim to maxWindowSize), run all rules, collect suggestions above notifyThreshold, add to pending, call notify for each, return results
- [x] I2. Implement `getPendingSuggestions()` → `Suggestion[]` — return copy of pending array
- [x] I3. Implement `acceptSuggestion(id: string)` — find & remove from pending, call `updateFeedback(category, "accept")`, return the suggestion
- [x] I4. Implement `rejectSuggestion(id: string)` — find & remove from pending, call `updateFeedback(category, "reject")`, return the suggestion

### J. Tool: `memory_observe` — `src/tools.ts`
- [x] J1. Change `registerTools` signature to accept `engine?: SuggestionEngine`
- [x] J2. Add import for `SuggestionEngine` type
- [x] J3. Define zod input schema: `type` (enum of ObservationType), `content` (string), `toolName?`, `metadata?`, `projectRoot?`
- [x] J4. Implement handler: guard if no engine, call `engine.observe()`, collect results
- [x] J5. Auto-save logic: for suggestions with `autoSave: true`, call `withStore()` to persist (source `"auto-suggestion"`, tags include `"auto-suggestion"`)
- [x] J6. Return JSON response: `{ observationRecorded, suggestionsGenerated, suggestions[], autoSaved[] }`

### K. Tool: `memory_suggest` — `src/tools.ts`
- [x] K1. Define zod input schema: `projectRoot?`
- [x] K2. Implement handler: guard if no engine, call `engine.getPendingSuggestions()`
- [x] K3. Return JSON response with count and suggestions array

### L. Tool: `memory_suggestion_feedback` — `src/tools.ts`
- [x] L1. Define zod input schema: `suggestionId` (string), `action` (accept/reject enum), `edits?` (optional object with title/content/tags/type), `projectRoot?`
- [x] L2. Implement accept path: get suggestion from engine, save to memory via `withStore()` (source `"suggestion-accepted"`), trigger `autoCompactStore`
- [x] L3. Implement reject path: call `engine.rejectSuggestion(id)`, return confirmation
- [x] L4. Return confirmation message with action taken

### M. Update HELP_TEXT — `src/tools.ts`
- [x] M1. Add `memory_observe` usage line
- [x] M2. Add `memory_suggest` usage line
- [x] M3. Add `memory_suggestion_feedback` usage line

### N. MCP Prompts — `src/prompts.ts`
- [x] N1. Create file with imports (`McpServer`, `z` from zod)
- [x] N2. Define `registerPrompts(server: McpServer)` function
- [x] N3. Register `memory_status` prompt (no args) — "Call memory_status and show the output."
- [x] N4. Register `memory_bundle` prompt (arg: `task` string) — "Call memory_get_bundle with {\"prompt\":\"<task>\"}..."
- [x] N5. Register `memory_save` prompt (args: `title`, `content`) — "Call memory_save with..."
- [x] N6. Register `memory_search` prompt (arg: `query`) — "Call memory_search with {\"query\":\"<query>\",\"includeContent\":true}..."
- [x] N7. Register `memory_propose` prompt (args: `title`, `content`) — "Call memory_propose with..."
- [x] N8. Register `memory_list_proposals` prompt (no args) — "Call memory_list_proposals..."
- [x] N9. Register `memory_compact` prompt (no args) — "Call memory_compact..."
- [x] N10. Register `memory_observe` prompt (args: `type`, `content`) — "Call memory_observe with..."
- [x] N11. Register `memory_suggest` prompt (no args) — "Call memory_suggest..."
- [x] N12. Register `memory_feedback` prompt (args: `suggestionId`, `action`) — "Call memory_suggestion_feedback with..."
- [x] N13. Register `memory_help` prompt (no args) — "Call memory_help..."

### O. Wire engine — `src/main.ts`
- [x] O1. Add import for `SuggestionEngine` from `./suggestions.js`
- [x] O2. Add import for `registerPrompts` from `./prompts.js`
- [x] O3. Instantiate: `const engine = new SuggestionEngine(CONFIG.suggestions)`
- [x] O4. Call `engine.setServer(server)` after server creation
- [x] O5. Change `registerTools(server)` → `registerTools(server, engine)`
- [x] O6. Call `registerPrompts(server)` after `registerTools`
- [x] O7. Call `engine.setProjectRoot(projectRoot)` after `findProjectRoot()`

### P. Update docs — `docs/FEATURE_STATUS.md`
- [x] P1. Update §4.5 "Mid-session notification delivery" → Implemented
- [x] P2. Update §4.5 "Scoring + threshold gating" → Implemented
- [x] P3. Update §4.5 "Feedback loop + weight tuning" → Implemented
- [x] P4. Update §4.5 "Suggestion payload with confidence/priority" → Implemented
- [x] P5. Add MCP Prompts row → Implemented (11 slash commands)

### Q. Build & verify
- [x] Q1. Run `npm run build` — fix any TypeScript errors
- [x] Q2. Verify no regressions in existing tool registrations
- [x] Q3. Verify all imports resolve correctly
- [x] Q4. Verify prompts are listed by MCP client
