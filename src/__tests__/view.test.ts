import { describe, expect, it } from "vitest";

import { renderHtml } from "../cli/view.js";
import type { MemoryItem, Store } from "../types.js";

function storeWith(items: Partial<MemoryItem>[]): Store {
  return {
    version: 1,
    project: {
      id: "abc123",
      root: "/tmp/proj",
      memoryFile: "/tmp/proj/.ai/memory.sqlite",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    items: items.map((it, i) => ({
      id: `mem_${i}`,
      type: "note",
      title: `Item ${i}`,
      content: "content",
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...it,
    })) as MemoryItem[],
    proposals: [],
    revision: 1,
  };
}

const meta = { projectRoot: "/tmp/proj", backend: "sqlite", generatedAt: "2026-07-17T00:00:00.000Z" };

describe("renderHtml", () => {
  it("is a single self-contained document with no external references", () => {
    const html = renderHtml(storeWith([{ title: "A" }, { title: "B" }]), meta);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // No asset loads over the network. (The inert SVG namespace URI is allowed.)
    expect(html).not.toMatch(/\bsrc\s*=/);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/href\s*=\s*["']https?:/);
    // The only permitted http(s) occurrence is the SVG namespace constant.
    const httpHits = html.match(/https?:\/\/[^"'\s)]+/g) || [];
    expect(httpHits.every((u) => u === "http://www.w3.org/2000/svg")).toBe(true);
  });

  it("reports the item count and backend in the header", () => {
    const html = renderHtml(storeWith([{}, {}, {}]), meta);
    expect(html).toContain("3 item(s)");
    expect(html).toContain("backend: sqlite");
  });

  it("neutralizes a </script> breakout attempt in item content", () => {
    const html = renderHtml(storeWith([{ content: "</script><img src=x onerror=alert(1)>" }]), meta);
    const blob = html.match(/type="application\/json">([\s\S]*?)<\/script>/);
    expect(blob).not.toBeNull();
    // The raw closing tag must not survive inside the embedded JSON blob.
    expect(blob![1]).not.toMatch(/<\/script>/i);
    expect(blob![1]).toContain("\\u003c/script>");
  });

  it("escapes HTML metacharacters in titles/tags rendered into markup", () => {
    const html = renderHtml(storeWith([{ type: "fact", tags: ["<b>", "a&b"] }]), meta);
    // Type appears in a server-rendered <option>; must be escaped there.
    expect(html).toContain("<option value=\"fact\">fact</option>");
    // No unescaped angle bracket from a tag leaked into markup.
    expect(html).not.toContain("<b></b>");
  });
});
