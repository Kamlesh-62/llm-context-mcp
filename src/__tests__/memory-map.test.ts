import { describe, it, expect } from "vitest";

import { buildMemoryMap, NO_DOMAIN } from "../domain.js";
import type { MemoryItem } from "../types.js";

function item(partial: Partial<MemoryItem>): MemoryItem {
  return {
    id: partial.id ?? "mem_x",
    type: partial.type ?? "note",
    title: partial.title ?? "",
    content: partial.content ?? "",
    tags: partial.tags ?? [],
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("buildMemoryMap", () => {
  it("groups by domain with counts and a total", () => {
    const map = buildMemoryMap([
      item({ id: "a", domain: "orders" }),
      item({ id: "b", domain: "orders" }),
      item({ id: "c", domain: "auth" }),
    ]);
    expect(map.total).toBe(3);
    expect(map.groups.map((g) => [g.domain, g.count])).toEqual([
      ["orders", 2],
      ["auth", 1],
    ]);
  });

  it("buckets domain-less items under NO_DOMAIN", () => {
    const map = buildMemoryMap([item({ id: "a" }), item({ id: "b", domain: "x" })]);
    const none = map.groups.find((g) => g.domain === NO_DOMAIN);
    expect(none?.count).toBe(1);
    expect(none?.items[0].id).toBe("a");
  });

  it("sorts groups by size then name", () => {
    const map = buildMemoryMap([
      item({ id: "1", domain: "zeta" }),
      item({ id: "2", domain: "alpha" }),
      item({ id: "3", domain: "alpha" }),
      item({ id: "4", domain: "beta" }),
    ]);
    // alpha(2) first by size; beta and zeta both 1 -> alphabetical.
    expect(map.groups.map((g) => g.domain)).toEqual(["alpha", "beta", "zeta"]);
  });

  it("orders items within a group newest-first", () => {
    const map = buildMemoryMap([
      item({ id: "old", domain: "d", updatedAt: "2026-01-01T00:00:00.000Z" }),
      item({ id: "new", domain: "d", updatedAt: "2026-06-01T00:00:00.000Z" }),
    ]);
    expect(map.groups[0].items.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("omits snippets by default and includes them on request", () => {
    const items = [item({ id: "a", domain: "d", content: "the full body text here" })];
    expect(buildMemoryMap(items).groups[0].items[0].snippet).toBeUndefined();
    const withSnip = buildMemoryMap(items, { includeSnippet: true });
    expect(withSnip.groups[0].items[0].snippet).toContain("full body");
  });

  it("entries carry only id/title/type (the cheap index shape)", () => {
    const map = buildMemoryMap([item({ id: "a", title: "T", type: "fact", domain: "d" })]);
    expect(map.groups[0].items[0]).toEqual({ id: "a", title: "T", type: "fact" });
  });
});
