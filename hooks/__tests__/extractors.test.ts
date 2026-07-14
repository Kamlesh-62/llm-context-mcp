import { describe, it, expect } from "vitest";
import {
  extractFromBashTools,
  extractErrorResolutions,
  extractFileChanges,
  extractDecisionsFromText,
  extractAll,
  RE_VERSION,
  RE_VERSION_OUTPUT,
  RE_COMMIT,
  RE_NPM_INSTALL,
  RE_PIP_INSTALL,
  RE_CARGO_ADD,
} from "../extractors.js";

// Helper to create transcript lines in the format extractors expect
function assistantToolUse(id: string, name: string, input: Record<string, unknown>) {
  return {
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

function userToolResult(toolUseId: string, content: string) {
  return {
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
}

function assistantText(text: string) {
  return {
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

describe("regex patterns", () => {
  it("RE_VERSION matches version commands", () => {
    expect(RE_VERSION.test("node -v")).toBe(true);
    expect(RE_VERSION.test("npm --version")).toBe(true);
    expect(RE_VERSION.test("python --version")).toBe(true);
    expect(RE_VERSION.test("ls -la")).toBe(false);
  });

  it("RE_VERSION_OUTPUT matches version strings", () => {
    expect(RE_VERSION_OUTPUT.test("v20.11.0")).toBe(true);
    expect(RE_VERSION_OUTPUT.test("3.11.5")).toBe(true);
    expect(RE_VERSION_OUTPUT.test("hello")).toBe(false);
  });

  it("RE_COMMIT matches git commit commands", () => {
    const match = 'git commit -m "fix auth bug"'.match(RE_COMMIT);
    expect(match).toBeTruthy();
    expect(match![1]).toBe("fix auth bug");
  });

  it("RE_NPM_INSTALL matches npm/yarn/pnpm install", () => {
    expect(RE_NPM_INSTALL.test("npm install express")).toBe(true);
    expect(RE_NPM_INSTALL.test("yarn add lodash")).toBe(true);
    expect(RE_NPM_INSTALL.test("pnpm add axios")).toBe(true);
  });

  it("RE_PIP_INSTALL matches pip install", () => {
    expect(RE_PIP_INSTALL.test("pip install requests")).toBe(true);
    expect(RE_PIP_INSTALL.test("pip3 install flask")).toBe(true);
  });

  it("RE_CARGO_ADD matches cargo add", () => {
    expect(RE_CARGO_ADD.test("cargo add tokio")).toBe(true);
  });
});

describe("extractFromBashTools", () => {
  it("extracts version facts", () => {
    const lines = [
      assistantToolUse("call_1", "Bash", { command: "node -v" }),
      userToolResult("call_1", "v20.11.0"),
    ];
    const items = extractFromBashTools(lines);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("fact");
    expect(items[0].title).toContain("node version: v20.11.0");
    expect(items[0].tags).toContain("version");
  });

  it("extracts commit messages", () => {
    const lines = [
      assistantToolUse("call_1", "Bash", { command: 'git commit -m "Add login feature"' }),
      userToolResult("call_1", "[main abc123] Add login feature"),
    ];
    const items = extractFromBashTools(lines);
    expect(items.some((i) => i.title.includes("Commit: Add login feature"))).toBe(true);
  });

  it("extracts npm install dependencies", () => {
    const lines = [
      assistantToolUse("call_1", "Bash", { command: "npm install express" }),
      userToolResult("call_1", "added 57 packages"),
    ];
    const items = extractFromBashTools(lines);
    expect(items.some((i) => i.title === "Added dependency: express")).toBe(true);
  });

  it("returns empty for non-matching commands", () => {
    const lines = [
      assistantToolUse("call_1", "Bash", { command: "ls -la" }),
      userToolResult("call_1", "total 64\ndrwxr-xr-x"),
    ];
    expect(extractFromBashTools(lines)).toEqual([]);
  });
});

describe("extractErrorResolutions", () => {
  it("detects error then resolution", () => {
    const lines = [
      assistantToolUse("call_1", "Bash", { command: "npm test" }),
      userToolResult("call_1", "FAIL: exit code 1\nerror: test failed"),
      assistantToolUse("call_2", "Bash", { command: "npm test" }),
      userToolResult("call_2", "PASS: all tests passed"),
    ];
    const items = extractErrorResolutions(lines);
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain("Resolved:");
    expect(items[0].tags).toContain("error-resolution");
  });

  it("returns empty when no errors", () => {
    const lines = [
      assistantToolUse("call_1", "Bash", { command: "echo hello" }),
      userToolResult("call_1", "hello"),
    ];
    expect(extractErrorResolutions(lines)).toEqual([]);
  });
});

describe("extractFileChanges", () => {
  it("extracts Write/Edit tool calls", () => {
    const lines = [
      assistantToolUse("call_1", "Write", { file_path: "/src/index.ts" }),
      userToolResult("call_1", "File written"),
      assistantToolUse("call_2", "Edit", { file_path: "/src/config.ts" }),
      userToolResult("call_2", "File edited"),
    ];
    const items = extractFileChanges(lines);
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain("Files modified this session (2)");
    expect(items[0].content).toContain("/src/index.ts");
    expect(items[0].content).toContain("/src/config.ts");
  });

  it("returns empty when no file changes", () => {
    const lines = [
      assistantToolUse("call_1", "Bash", { command: "ls" }),
      userToolResult("call_1", "output"),
    ];
    expect(extractFileChanges(lines)).toEqual([]);
  });
});

describe("extractDecisionsFromText", () => {
  it("extracts decision patterns", () => {
    const lines = [
      assistantText("We decided to use PostgreSQL for the database."),
    ];
    const items = extractDecisionsFromText(lines);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].type).toBe("decision");
  });

  it("extracts constraint patterns", () => {
    const lines = [
      assistantText("You must not use eval in production code."),
    ];
    const items = extractDecisionsFromText(lines);
    expect(items.some((i) => i.type === "constraint")).toBe(true);
  });
});

describe("extractAll", () => {
  it("combines all extractors", () => {
    const lines = [
      assistantToolUse("call_1", "Bash", { command: "node -v" }),
      userToolResult("call_1", "v20.11.0"),
      assistantToolUse("call_2", "Write", { file_path: "/src/app.ts" }),
      userToolResult("call_2", "Written"),
    ];
    const items = extractAll(lines);
    expect(items.length).toBeGreaterThanOrEqual(2);
  });
});
