/**
 * Codex transcript adapter.
 *
 * Codex rollout files use the OpenAI Responses API shape, not Claude's:
 *   { type: "response_item", payload: { type: "message" | "function_call" |
 *     "function_call_output" | "reasoning", ... } }
 *
 * The heuristic extractors are written against Claude-shaped lines
 * ({ message: { role, content: [ {type:"text"|"tool_use"|"tool_result"} ] } }).
 * This module converts Codex lines into that shape so the SAME extractors work
 * for both CLIs. Claude lines pass through untouched.
 */

import type { TranscriptLine } from "./extractors.js";

// Codex function-call tool names that are shell/command executions. Mapped to
// "Bash" so the existing bash-oriented extractors match.
const SHELL_TOOLS = new Set(["exec_command", "shell", "local_shell", "bash"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A line is Codex-shaped when it is a response_item carrying a payload. */
export function isCodexLine(line: unknown): boolean {
  return isRecord(line) && line.type === "response_item" && isRecord(line.payload);
}

/** Pull the shell command out of a function_call's `arguments` (a JSON string). */
function commandFromArguments(args: unknown): string {
  let obj: unknown = args;
  if (typeof args === "string") {
    try {
      obj = JSON.parse(args);
    } catch {
      return "";
    }
  }
  if (!isRecord(obj)) return "";
  const cmd = obj.cmd ?? obj.command;
  if (typeof cmd === "string") return cmd;
  // Some shells pass an argv array.
  if (Array.isArray(cmd)) return cmd.filter((x) => typeof x === "string").join(" ");
  return "";
}

/** Map a Codex message's content blocks to Claude-style text blocks. */
function mapMessageContent(content: unknown): Array<{ type: string; text: string }> {
  if (!Array.isArray(content)) return [];
  const blocks: Array<{ type: string; text: string }> = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    // output_text (assistant), input_text (user)
    if (
      (block.type === "output_text" || block.type === "input_text" || block.type === "text") &&
      typeof block.text === "string"
    ) {
      blocks.push({ type: "text", text: block.text });
    }
  }
  return blocks;
}

/**
 * Convert one Codex response_item line to a Claude-shaped line, or null if it
 * carries nothing useful (reasoning, unknown payloads).
 */
export function convertCodexLine(line: TranscriptLine): TranscriptLine | null {
  const payload = (line as Record<string, unknown>).payload;
  if (!isRecord(payload)) return null;
  const ptype = payload.type;

  if (ptype === "message") {
    const role = payload.role === "assistant" ? "assistant" : "user";
    const content = mapMessageContent(payload.content);
    if (content.length === 0) return null;
    return { message: { role, content } };
  }

  if (ptype === "function_call") {
    const name = typeof payload.name === "string" ? payload.name : "";
    const command = commandFromArguments(payload.arguments);
    // Only shell-like calls carry a command our extractors can use.
    const toolName = SHELL_TOOLS.has(name) ? "Bash" : name;
    return {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: typeof payload.call_id === "string" ? payload.call_id : "",
            name: toolName,
            input: { command },
          },
        ],
      },
    };
  }

  if (ptype === "function_call_output") {
    const output = payload.output;
    const text =
      typeof output === "string" ? output : output == null ? "" : JSON.stringify(output);
    return {
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: typeof payload.call_id === "string" ? payload.call_id : "",
            content: text,
          },
        ],
      },
    };
  }

  // reasoning / unknown → drop
  return null;
}

/**
 * Normalize a transcript that may be Claude- or Codex-shaped. Codex lines are
 * converted (and un-convertible ones dropped); non-Codex lines pass through
 * unchanged, so this is safe to run on any transcript.
 */
export function normalizeCodexTranscript(lines: TranscriptLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const line of lines) {
    if (isCodexLine(line)) {
      const converted = convertCodexLine(line);
      if (converted) out.push(converted);
    } else {
      out.push(line);
    }
  }
  return out;
}
