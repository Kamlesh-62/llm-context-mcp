import { describe, it, expect } from "vitest";

import { isLinkRel, supersededIds, expandByLinks, LINK_RELS } from "../domain.js";
import type { MemoryItem } from "../types.js";

function item(partial: Partial<MemoryItem>): MemoryItem {
  return {
    id: partial.id ?? "mem_x",
    type: partial.type ?? "note",
    title: partial.title ?? "",
    content: partial.content ?? "",
    tags: partial.tags ?? [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("isLinkRel", () => {
  it("accepts the known relations and rejects others", () => {
    for (const r of LINK_RELS) expect(isLinkRel(r)).toBe(true);
    expect(isLinkRel("owns")).toBe(false);
    expect(isLinkRel(3)).toBe(false);
    expect(isLinkRel(undefined)).toBe(false);
  });
});

describe("supersededIds", () => {
  it("collects targets of supersedes edges only", () => {
    const items = [
      item({ id: "new", links: [{ to: "old", rel: "supersedes" }] }),
      item({ id: "old" }),
      item({ id: "a", links: [{ to: "b", rel: "relates-to" }] }),
      item({ id: "b" }),
    ];
    const stale = supersededIds(items);
    expect([...stale]).toEqual(["old"]);
  });

  it("is empty when there are no supersedes edges", () => {
    expect(supersededIds([item({ id: "a" }), item({ id: "b" })]).size).toBe(0);
  });
});

describe("expandByLinks", () => {
  it("adds 1-hop outbound neighbors of the seed", () => {
    const items = [
      item({ id: "a", links: [{ to: "b", rel: "depends-on" }] }),
      item({ id: "b", links: [{ to: "c", rel: "depends-on" }] }),
      item({ id: "c" }),
      item({ id: "z" }),
    ];
    const out = expandByLinks(items, ["a"], 1);
    expect([...out].sort()).toEqual(["a", "b"]); // c is 2 hops away, z unrelated
  });

  it("follows multiple hops when asked", () => {
    const items = [
      item({ id: "a", links: [{ to: "b", rel: "depends-on" }] }),
      item({ id: "b", links: [{ to: "c", rel: "depends-on" }] }),
      item({ id: "c" }),
    ];
    expect([...expandByLinks(items, ["a"], 2)].sort()).toEqual(["a", "b", "c"]);
  });

  it("ignores edges whose target no longer exists", () => {
    const items = [item({ id: "a", links: [{ to: "gone", rel: "relates-to" }] })];
    expect([...expandByLinks(items, ["a"], 1)]).toEqual(["a"]);
  });

  it("keeps only seeds that exist", () => {
    const items = [item({ id: "a" })];
    expect([...expandByLinks(items, ["a", "ghost"], 1)]).toEqual(["a"]);
  });
});
