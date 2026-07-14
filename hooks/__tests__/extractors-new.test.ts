import { describe, it, expect } from "vitest";
import {
  extractTodos,
  extractConfigValues,
  extractChosenLibraries,
  extractAll,
  RE_TODO,
  RE_CHOSE,
} from "../extractors.js";

function assistantToolUse(id: string, name: string, input: Record<string, unknown>) {
  return { message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } };
}
function assistantText(text: string) {
  return { message: { role: "assistant", content: [{ type: "text", text }] } };
}

describe("extractTodos", () => {
  it("captures TODO / next-step sentences", () => {
    const items = extractTodos([
      assistantText("We finished auth. TODO: add rate limiting to the login route."),
      assistantText("The next step is to wire the retry queue."),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe("todo");
    expect(items[0].tags).toContain("next-steps");
  });

  it("ignores plain prose with no todo signal", () => {
    expect(extractTodos([assistantText("The build passed and everything looks fine.")])).toHaveLength(0);
  });

  it("RE_TODO matches common markers", () => {
    expect(RE_TODO.test("TODO: x")).toBe(true);
    expect(RE_TODO.test("still need to test this")).toBe(true);
    expect(RE_TODO.test("all done")).toBe(false);
  });
});

describe("extractConfigValues", () => {
  it("captures exported env vars", () => {
    const items = extractConfigValues([
      assistantToolUse("t1", "Bash", { command: "export DATABASE_URL=postgres://localhost/app" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Config: DATABASE_URL");
    expect(items[0].content).toContain("postgres://localhost/app");
  });

  it("redacts secret-looking values", () => {
    const items = extractConfigValues([
      assistantToolUse("t1", "Bash", { command: "export API_SECRET_KEY=sk-supersecret123" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain("redacted");
    expect(items[0].content).not.toContain("supersecret");
  });

  it("dedupes repeated keys", () => {
    const items = extractConfigValues([
      assistantToolUse("t1", "Bash", { command: "export PORT=3000" }),
      assistantToolUse("t2", "Bash", { command: "export PORT=4000" }),
    ]);
    expect(items).toHaveLength(1);
  });
});

describe("extractChosenLibraries", () => {
  it("captures a library choice with a reason", () => {
    const items = extractChosenLibraries([
      assistantText("I'm using vitest because it is fast and ESM-native."),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("decision");
    expect(items[0].title).toBe("Chose vitest");
    expect(items[0].tags).toContain("library");
  });

  it("does not fire without a reason clause", () => {
    expect(
      extractChosenLibraries([assistantText("I ran vitest and the suite passed.")]),
    ).toHaveLength(0);
  });

  it("RE_CHOSE captures the library token", () => {
    const m = "we switched to better-sqlite3 because it is synchronous".match(RE_CHOSE);
    expect(m?.[1]).toBe("better-sqlite3");
  });
});

describe("extractAll includes the new extractors", () => {
  it("aggregates todos, config, and library choices", () => {
    const items = extractAll([
      assistantText("TODO: document the migrate command."),
      assistantToolUse("t1", "Bash", { command: "export LOG_LEVEL=debug" }),
      assistantText("Going with zod because it validates at the boundary."),
    ]);
    const types = items.map((i) => i.type);
    expect(types).toContain("todo");
    expect(types).toContain("fact");
    expect(types).toContain("decision");
  });
});
