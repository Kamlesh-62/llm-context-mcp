import { describe, expect, it } from "vitest";

import { parseMarkdownItems } from "../cli/import-md.js";

describe("parseMarkdownItems", () => {
  it("parses a single frontmatter block", () => {
    const md = [
      "---",
      "type: glossary",
      "title: Member types",
      "tags: [business-logic, member-type]",
      "created: 2026-04-29T16:23:51.167Z",
      "updated: 2026-06-12T19:00:00.000Z",
      "source: claude",
      "---",
      "",
      "Body line one.",
      "Body line two.",
    ].join("\n");

    const items = parseMarkdownItems(md);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("glossary");
    expect(items[0].title).toBe("Member types");
    expect(items[0].tags).toEqual(["business-logic", "member-type"]);
    expect(items[0].created).toBe("2026-04-29T16:23:51.167Z");
    expect(items[0].updated).toBe("2026-06-12T19:00:00.000Z");
    expect(items[0].source).toBe("claude");
    expect(items[0].content).toBe("Body line one.\nBody line two.");
  });

  it("keeps bare `---` horizontal rules in the body as ONE item (regression)", () => {
    const md = [
      "---",
      "type: architecture",
      "title: Commission system",
      "---",
      "",
      "## Section A",
      "",
      "---", // markdown horizontal rule, NOT a fence — no key line follows
      "",
      "## Section B",
      "",
      "More prose with a table:",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n");

    const items = parseMarkdownItems(md);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Commission system");
    // The body must include everything after the fence, rules and table intact.
    expect(items[0].content).toContain("## Section A");
    expect(items[0].content).toContain("---");
    expect(items[0].content).toContain("## Section B");
    expect(items[0].content).toContain("| 1 | 2 |");
  });

  it("separates multiple blocks and tracks section banners", () => {
    const md = [
      "<!-- context-bridge memories -->",
      "",
      "---",
      "type: fact",
      "title: First",
      "---",
      "",
      "First body.",
      "",
      "<!-- ================= -->",
      "<!-- 2. COMMISSION SYSTEM -->",
      "<!-- ================= -->",
      "",
      "---",
      "type: fact",
      "title: Second",
      "---",
      "",
      "Second body.",
    ].join("\n");

    const items = parseMarkdownItems(md);
    expect(items.map((i) => i.title)).toEqual(["First", "Second"]);
    expect(items[0].section).toBeUndefined();
    expect(items[1].section).toBe("COMMISSION SYSTEM");
    expect(items[0].content).toBe("First body.");
    expect(items[1].content).toBe("Second body.");
  });

  it("does not treat body lines with a colon as frontmatter keys", () => {
    const md = [
      "---",
      "type: note",
      "title: Backups",
      "---",
      "",
      "Backup subscription table: shop_order_recurring",
    ].join("\n");

    const items = parseMarkdownItems(md);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe("Backup subscription table: shop_order_recurring");
  });

  it("parses tags written without brackets", () => {
    const md = ["---", "type: note", "title: T", "tags: a, b, c", "---", "", "x"].join("\n");
    expect(parseMarkdownItems(md)[0].tags).toEqual(["a", "b", "c"]);
  });

  it("ignores a fence that never closes (malformed)", () => {
    const md = ["prose", "---", "type: note", "title: unterminated", "still going"].join("\n");
    // No closing `---`; nothing valid to import.
    expect(parseMarkdownItems(md)).toHaveLength(0);
  });
});
