import { describe, it, expect } from "vitest";
import {
  normalizeTags,
  safeSnippet,
  scoreItem,
  tokenize,
  newId,
  validateType,
} from "../domain.js";

describe("normalizeTags", () => {
  it("lowercases and deduplicates tags", () => {
    expect(normalizeTags(["Foo", "bar", "FOO"])).toEqual(["foo", "bar"]);
  });

  it("returns empty array for undefined", () => {
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it("returns empty array for non-array", () => {
    expect(normalizeTags("not-an-array")).toEqual([]);
  });

  it("filters out empty strings", () => {
    expect(normalizeTags(["a", "", "  ", "b"])).toEqual(["a", "b"]);
  });

  it("limits to maxTags", () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    expect(normalizeTags(many).length).toBeLessThanOrEqual(20);
  });
});

describe("safeSnippet", () => {
  it("returns short text unchanged", () => {
    expect(safeSnippet("hello world")).toBe("hello world");
  });

  it("truncates long text with ellipsis", () => {
    const long = "a".repeat(300);
    const result = safeSnippet(long);
    expect(result.length).toBeLessThanOrEqual(280);
    expect(result.endsWith("…")).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(safeSnippet("hello   \n  world")).toBe("hello world");
  });

  it("handles null/undefined", () => {
    expect(safeSnippet(null)).toBe("");
    expect(safeSnippet(undefined)).toBe("");
  });
});

describe("tokenize", () => {
  it("splits on non-alphanumeric characters", () => {
    expect(tokenize("hello world")).toEqual(["hello", "world"]);
  });

  it("lowercases tokens", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  it("filters tokens shorter than 2 chars", () => {
    expect(tokenize("a bb ccc")).toEqual(["bb", "ccc"]);
  });

  it("handles empty/null input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });

  it("limits to 40 tokens", () => {
    const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    expect(tokenize(long).length).toBeLessThanOrEqual(40);
  });
});

describe("scoreItem", () => {
  const item = {
    title: "Node version 20",
    content: "Running node v20.11.0 on production",
    tags: ["environment", "node"],
    pinned: false,
  };

  it("scores query token matches at +3 each", () => {
    const score = scoreItem(item, ["node"], []);
    expect(score).toBe(3);
  });

  it("scores tag matches at +4 each", () => {
    const score = scoreItem(item, [], ["node"]);
    expect(score).toBe(4);
  });

  it("adds +2 for pinned items", () => {
    const pinned = { ...item, pinned: true };
    const score = scoreItem(pinned, [], []);
    expect(score).toBe(2);
  });

  it("combines query + tag + pinned", () => {
    const pinned = { ...item, pinned: true };
    const score = scoreItem(pinned, ["node"], ["environment"]);
    // node in text: +3, environment tag: +4, pinned: +2 = 9
    expect(score).toBe(9);
  });

  it("returns 0 for no matches", () => {
    expect(scoreItem(item, ["redis"], ["database"])).toBe(0);
  });
});

describe("newId", () => {
  it("generates ID with prefix", () => {
    const id = newId("mem");
    expect(id).toMatch(/^mem_[a-f0-9]{12}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId("test")));
    expect(ids.size).toBe(100);
  });
});

describe("validateType", () => {
  it("returns valid types unchanged", () => {
    expect(validateType("fact")).toBe("fact");
    expect(validateType("decision")).toBe("decision");
    expect(validateType("architecture")).toBe("architecture");
  });

  it("defaults to note for invalid types", () => {
    expect(validateType("invalid")).toBe("note");
    expect(validateType("")).toBe("note");
    expect(validateType(null)).toBe("note");
  });

  it("normalizes case", () => {
    expect(validateType("FACT")).toBe("fact");
    expect(validateType("Decision")).toBe("decision");
  });
});
