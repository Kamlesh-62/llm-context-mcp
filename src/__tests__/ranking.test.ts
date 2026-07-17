import { describe, it, expect } from "vitest";

import { normalizeDomain, rankItems } from "../domain.js";
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

// Fixed "now" far after the fixture dates so recency doesn't skew base cases.
const NOW = Date.parse("2027-01-01T00:00:00.000Z");

describe("normalizeDomain", () => {
  it("slugifies and lowercases", () => {
    expect(normalizeDomain("Commission System")).toBe("commission-system");
    expect(normalizeDomain("  Orders  ")).toBe("orders");
    expect(normalizeDomain("A/B Testing!")).toBe("a-b-testing");
  });
  it("returns undefined for empty", () => {
    expect(normalizeDomain("")).toBeUndefined();
    expect(normalizeDomain(undefined)).toBeUndefined();
    expect(normalizeDomain("   ")).toBeUndefined();
  });
});

describe("rankItems", () => {
  it("ranks a title hit above a body-only hit for the same term", () => {
    const items = [
      item({ id: "body", title: "Unrelated heading", content: "the widget lives here" }),
      item({ id: "title", title: "Widget configuration", content: "unrelated body text" }),
    ];
    const ranked = rankItems(items, "widget", { now: NOW });
    expect(ranked[0].item.id).toBe("title");
  });

  it("weights rare terms above common ones (IDF)", () => {
    // "the" appears in every doc; "kafka" in one. A kafka hit should win.
    const items = [
      item({ id: "common", title: "the the the", content: "the the the the" }),
      item({ id: "rare", title: "kafka pipeline", content: "the the" }),
      item({ id: "c2", title: "the report", content: "the the" }),
      item({ id: "c3", title: "the thing", content: "the" }),
    ];
    const ranked = rankItems(items, "the kafka", { now: NOW });
    expect(ranked[0].item.id).toBe("rare");
  });

  it("boosts an item whose domain matches the filter", () => {
    const items = [
      item({ id: "a", title: "payment flow", content: "x", domain: "orders" }),
      item({ id: "b", title: "payment flow", content: "x", domain: "billing" }),
    ];
    const ranked = rankItems(items, "payment", { domain: "orders", now: NOW });
    expect(ranked[0].item.id).toBe("a");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("boosts when the query mentions the item's domain", () => {
    const items = [
      item({ id: "d", title: "refund rule", content: "x", domain: "commissions" }),
      item({ id: "n", title: "refund rule", content: "x" }),
    ];
    const ranked = rankItems(items, "commissions refund", { now: NOW });
    expect(ranked[0].item.id).toBe("d");
  });

  it("gives no score to items with no signal", () => {
    const items = [item({ title: "alpha", content: "beta" })];
    const ranked = rankItems(items, "gamma", { now: NOW });
    expect(ranked[0].score).toBe(0);
  });

  it("prefers a more recent item when relevance is otherwise equal", () => {
    const items = [
      item({ id: "old", title: "deploy notes", content: "same", updatedAt: "2026-01-01T00:00:00.000Z" }),
      item({ id: "new", title: "deploy notes", content: "same", updatedAt: "2026-12-25T00:00:00.000Z" }),
    ];
    const ranked = rankItems(items, "deploy", { now: NOW });
    expect(ranked[0].item.id).toBe("new");
  });

  it("applies tag boosts via tagTokens", () => {
    const items = [
      item({ id: "tagged", title: "x", content: "y", tags: ["auth"] }),
      item({ id: "plain", title: "x", content: "y" }),
    ];
    const ranked = rankItems(items, "x", { tagTokens: ["auth"], now: NOW });
    expect(ranked[0].item.id).toBe("tagged");
  });
});
