import { describe, it, expect } from "vitest";
import {
  isCodexLine,
  convertCodexLine,
  normalizeCodexTranscript,
} from "../codex-transcript.js";
import { extractAll } from "../extractors.js";

// Shapes mirror real ~/.codex/sessions rollout lines.
const codexAssistant = {
  type: "response_item",
  payload: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "I decided to use zod because it validates at the boundary." }],
  },
};
const codexUser = {
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "please add tests" }],
  },
};
const codexExec = {
  type: "response_item",
  payload: {
    type: "function_call",
    name: "exec_command",
    arguments: '{"cmd":"npm install better-sqlite3","workdir":"/x","yield_time_ms":1000}',
    call_id: "call_1",
  },
};
const codexExecOutput = {
  type: "response_item",
  payload: {
    type: "function_call_output",
    call_id: "call_1",
    output: "added 1 package\nProcess exited with code 0\n",
  },
};
const codexReasoning = {
  type: "response_item",
  payload: { type: "reasoning", summary: [], encrypted_content: "xxx" },
};

describe("isCodexLine", () => {
  it("recognizes Codex response_item lines", () => {
    expect(isCodexLine(codexExec)).toBe(true);
    expect(isCodexLine({ message: { role: "assistant", content: [] } })).toBe(false);
    expect(isCodexLine(null)).toBe(false);
  });
});

describe("convertCodexLine", () => {
  it("maps an assistant message to a Claude text block", () => {
    const c = convertCodexLine(codexAssistant) as any;
    expect(c.message.role).toBe("assistant");
    expect(c.message.content[0]).toEqual({
      type: "text",
      text: "I decided to use zod because it validates at the boundary.",
    });
  });

  it("maps exec_command to a Bash tool_use with the parsed command", () => {
    const c = convertCodexLine(codexExec) as any;
    expect(c.message.role).toBe("assistant");
    expect(c.message.content[0]).toMatchObject({
      type: "tool_use",
      name: "Bash",
      id: "call_1",
      input: { command: "npm install better-sqlite3" },
    });
  });

  it("maps function_call_output to a tool_result keyed by call_id", () => {
    const c = convertCodexLine(codexExecOutput) as any;
    expect(c.message.role).toBe("user");
    expect(c.message.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_1",
    });
    expect(c.message.content[0].content).toContain("exited with code 0");
  });

  it("drops reasoning payloads", () => {
    expect(convertCodexLine(codexReasoning)).toBeNull();
  });

  it("returns empty command for malformed arguments", () => {
    const c = convertCodexLine({
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: "not json", call_id: "c" },
    }) as any;
    expect(c.message.content[0].input.command).toBe("");
  });
});

describe("normalizeCodexTranscript", () => {
  it("passes Claude-shaped lines through unchanged", () => {
    const claude = { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
    expect(normalizeCodexTranscript([claude])).toEqual([claude]);
  });

  it("converts a mixed transcript and drops non-convertible lines", () => {
    const out = normalizeCodexTranscript([codexAssistant, codexReasoning, codexExec]);
    expect(out).toHaveLength(2); // reasoning dropped
  });
});

describe("extractAll over a real-shaped Codex transcript", () => {
  it("extracts a dependency install and a library decision from Codex lines", () => {
    const items = extractAll([codexUser, codexAssistant, codexExec, codexExecOutput]);
    const titles = items.map((i) => i.title);
    // dependency from exec_command `npm install better-sqlite3`
    expect(titles.some((t) => t.includes("better-sqlite3"))).toBe(true);
    // library decision from assistant text ("use zod because ...")
    expect(titles.some((t) => t.toLowerCase().includes("zod"))).toBe(true);
  });

  it("detects a Codex-phrased error resolution", () => {
    const failing = {
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"npm test"}', call_id: "c1" },
    };
    const failOut = {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c1", output: "Process exited with code 1\nfailing" },
    };
    const fixing = {
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"npm run build"}', call_id: "c2" },
    };
    const fixOut = {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c2", output: "ok\nProcess exited with code 0" },
    };
    const items = extractAll([failing, failOut, fixing, fixOut]);
    expect(items.some((i) => i.tags?.includes("error-resolution"))).toBe(true);
  });
});
