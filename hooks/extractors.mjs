/**
 * Heuristic extractors that pull structured facts from Claude Code transcript lines.
 * Each extractor receives an array of parsed JSONL objects (the delta) and returns
 * candidate memory items: { type, title, content, tags }.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

const RE_VERSION = /\b(node|npm|python|pip|ruby|go|java|rustc|cargo|bun|deno|pnpm|yarn)\s+(-v|--version|version)\b/i;
const RE_VERSION_OUTPUT = /v?\d+\.\d+\.\d+/;
const RE_COMMIT = /git\s+commit\s.*?-m\s+["'](.+?)["']/;
const RE_NPM_INSTALL = /\b(npm|yarn|pnpm|bun)\s+(install|add|i)\s+(\S+)/;
const RE_PIP_INSTALL = /\b(pip|pip3)\s+install\s+(\S+)/;
const RE_CARGO_ADD = /\bcargo\s+add\s+(\S+)/;

/**
 * Extract the role and content from a transcript JSONL line.
 * Claude Code transcript lines wrap messages in various ways:
 *   - Top-level: { type: "assistant", message: { role, content } }
 *   - Progress:  { type: "progress", data: { message: { type, message: { role, content } } } }
 *   - Simple:    { role, content }  (fallback)
 */
function normalizeRole(role) {
  if (!role) return role;
  if (role === "model") return "assistant";
  return role;
}

function normalizeContent(content, parts) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return content;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (typeof p?.text === "string") return p.text;
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return null;
}

function unwrap(line) {
  // Direct message lines (type: "assistant" | "user")
  if (line.message?.role) {
    const content = normalizeContent(line.message.content, line.message.parts);
    if (content !== null) {
      return { role: normalizeRole(line.message.role), content };
    }
  }
  // Lines with type but no message wrapper (type: "assistant" | "user" with direct content)
  if ((line.type === "assistant" || line.type === "user") && line.content !== undefined) {
    const content = normalizeContent(line.content, line.parts);
    if (content !== null) {
      return { role: normalizeRole(line.type), content };
    }
  }
  // Progress lines (subagent tool calls/results)
  if (line.type === "progress" && line.data?.message?.message) {
    const inner = line.data.message.message;
    if (inner.role && inner.content) {
      const content = normalizeContent(inner.content, inner.parts);
      if (content !== null) {
        return { role: normalizeRole(inner.role), content };
      }
    }
  }
  // Fallback: already unwrapped
  if (line.role) {
    const content = normalizeContent(line.content, line.parts);
    if (content !== null) {
      return { role: normalizeRole(line.role), content };
    }
  }
  return null;
}

function bashToolCalls(lines) {
  const results = [];
  for (const line of lines) {
    const msg = unwrap(line);
    if (!msg || msg.role !== "assistant") continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block.type !== "tool_use" || block.name !== "Bash") continue;
      results.push({ id: block.id, command: block.input?.command ?? "" });
    }
  }
  return results;
}

function toolResults(lines) {
  const results = [];
  for (const line of lines) {
    const msg = unwrap(line);
    if (!msg || msg.role !== "user") continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block.type === "tool_result") {
        results.push({ toolUseId: block.tool_use_id, text: block.content ?? "" });
      }
    }
  }
  return results;
}

function resultForId(resultMap, id) {
  return resultMap.get(id) ?? "";
}

// ── Extractor 1: Bash tool facts ─────────────────────────────────────────────

export function extractFromBashTools(lines) {
  const items = [];
  const calls = bashToolCalls(lines);
  const resMap = new Map();
  for (const r of toolResults(lines)) {
    resMap.set(r.toolUseId, r.text);
  }

  for (const call of calls) {
    const cmd = call.command;
    const output = resultForId(resMap, call.id);

    // Version detection
    if (RE_VERSION.test(cmd)) {
      const match = (typeof output === "string" ? output : "").match(RE_VERSION_OUTPUT);
      if (match) {
        const tool = cmd.match(RE_VERSION)?.[1] ?? "unknown";
        items.push({
          type: "fact",
          title: `${tool} version: ${match[0]}`,
          content: `Detected via \`${cmd.trim()}\``,
          tags: ["version", "environment"],
        });
      }
    }

    // Commit messages
    const commitMatch = cmd.match(RE_COMMIT);
    if (commitMatch) {
      items.push({
        type: "note",
        title: `Commit: ${commitMatch[1].slice(0, 120)}`,
        content: `Full command: ${cmd.trim().slice(0, 300)}`,
        tags: ["commit"],
      });
    }

    // npm / yarn / pnpm / bun install
    const npmMatch = cmd.match(RE_NPM_INSTALL);
    if (npmMatch) {
      const pkg = npmMatch[3].replace(/^['"]|['"]$/g, "");
      if (pkg && !pkg.startsWith("-")) {
        items.push({
          type: "fact",
          title: `Added dependency: ${pkg}`,
          content: `Installed via \`${cmd.trim().slice(0, 200)}\``,
          tags: ["dependency"],
        });
      }
    }

    // pip install
    const pipMatch = cmd.match(RE_PIP_INSTALL);
    if (pipMatch) {
      const pkg = pipMatch[2].replace(/^['"]|['"]$/g, "");
      if (pkg && !pkg.startsWith("-")) {
        items.push({
          type: "fact",
          title: `Added dependency: ${pkg}`,
          content: `Installed via \`${cmd.trim().slice(0, 200)}\``,
          tags: ["dependency"],
        });
      }
    }

    // cargo add
    const cargoMatch = cmd.match(RE_CARGO_ADD);
    if (cargoMatch) {
      items.push({
        type: "fact",
        title: `Added dependency: ${cargoMatch[1]}`,
        content: `Installed via \`${cmd.trim().slice(0, 200)}\``,
        tags: ["dependency"],
      });
    }
  }

  return items;
}

// ── Extractor 2: Error resolutions ───────────────────────────────────────────

export function extractErrorResolutions(lines) {
  const items = [];
  const calls = bashToolCalls(lines);
  const resMap = new Map();
  for (const r of toolResults(lines)) {
    resMap.set(r.toolUseId, r.text);
  }

  // Track errors then look for subsequent success on similar commands
  const errors = [];
  for (const call of calls) {
    const output = resultForId(resMap, call.id);
    const outStr = typeof output === "string" ? output : JSON.stringify(output ?? "");

    // Heuristic: non-zero exit or common error strings
    const isError = /exit code [1-9]|error:|ERR!|FAIL|fatal:/i.test(outStr);
    const isSuccess = !isError && outStr.length > 0;

    if (isError) {
      const summary = outStr.slice(0, 150).split("\n")[0];
      errors.push({ command: call.command, summary });
    } else if (isSuccess && errors.length > 0) {
      // Check if this success relates to a prior error (same base command)
      const baseCmd = call.command.split(/\s+/)[0];
      const related = errors.find((e) => e.command.split(/\s+/)[0] === baseCmd);
      if (related) {
        items.push({
          type: "fact",
          title: `Resolved: ${related.summary.slice(0, 100)}`,
          content: `Error in \`${related.command.slice(0, 120)}\` was resolved by \`${call.command.slice(0, 120)}\``,
          tags: ["error-resolution"],
        });
        // Remove the matched error
        const idx = errors.indexOf(related);
        errors.splice(idx, 1);
      }
    }
  }

  return items;
}

// ── Extractor 3: File change summary ─────────────────────────────────────────

export function extractFileChanges(lines) {
  const files = new Set();

  for (const line of lines) {
    const msg = unwrap(line);
    if (!msg || msg.role !== "assistant") continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "Write" || block.name === "Edit") {
        const fp = block.input?.file_path ?? block.input?.path ?? "";
        if (fp) files.add(fp);
      }
    }
  }

  if (files.size === 0) return [];

  const fileList = [...files].sort();
  return [
    {
      type: "note",
      title: `Files modified this session (${fileList.length})`,
      content: fileList.join(", "),
      tags: ["file-changes"],
    },
  ];
}

// ── Extractor 4: Decisions / constraints / architecture from assistant text ──

const DECISION_PATTERNS = [
  { re: /\b(decided to|switched from|switched to|chose|migrated)\b/i, type: "decision" },
  { re: /\b(always|never|must not|must|do not)\b/i, type: "constraint" },
  { re: /\b(the architecture|pattern is|structure|design)\b/i, type: "architecture" },
  { re: /\b(uses \S+ v\d+\.\d+|running on|installed)\b/i, type: "fact" },
];

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

export function extractDecisionsFromText(lines) {
  const items = [];
  const seen = new Set();

  for (const line of lines) {
    const msg = unwrap(line);
    if (!msg || msg.role !== "assistant") continue;

    const text = extractTextFromContent(msg.content);
    if (!text) continue;

    for (const sentence of splitSentences(text)) {
      for (const { re, type } of DECISION_PATTERNS) {
        if (!re.test(sentence)) continue;

        const title = sentence.length > 100 ? sentence.slice(0, 100) + "…" : sentence;
        const key = `${type}:${title}`;
        if (seen.has(key)) break;
        seen.add(key);

        items.push({
          type,
          title,
          content: sentence.slice(0, 500),
          tags: [type],
        });
        break; // one match per sentence
      }
    }
  }

  return items;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export function extractAll(lines) {
  return [
    ...extractFromBashTools(lines),
    ...extractErrorResolutions(lines),
    ...extractFileChanges(lines),
    ...extractDecisionsFromText(lines),
  ];
}
