import crypto from "node:crypto";

import { ALLOWED_TYPES, CONFIG, LIMITS } from "./config.js";
import type { LinkRel, MemoryItem, MemoryType } from "./types.js";

export function normalizeTags(tags?: unknown): string[] {
  const arr = Array.isArray(tags) ? tags : [];
  const norm = arr
    .map((t) => String(t || "").trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(norm)).slice(0, LIMITS.maxTags);
}

export function safeSnippet(text: unknown, maxChars = CONFIG.maxContentSnippetChars): string {
  const s = String(text ?? "");
  const trimmed = s.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

export function scoreItem(
  item: Pick<MemoryItem, "title" | "content" | "tags" | "pinned">,
  queryTokens: string[],
  tagTokens: string[],
): number {
  const hay = `${item.title || ""} ${item.content || ""}`.toLowerCase();
  let score = 0;

  for (const t of queryTokens) {
    if (!t) continue;
    if (hay.includes(t)) score += 3;
  }

  const itemTags = new Set(normalizeTags(item.tags));
  for (const t of tagTokens) {
    if (itemTags.has(t)) score += 4;
  }

  if (item.pinned) score += 2;

  return score;
}

/**
 * Slugify a free-text domain into a stable bucket key: lowercased, non-alnum
 * runs collapsed to `-`, trimmed. `"Commission System"` → `"commission-system"`.
 * Returns undefined for empty input so an absent domain stays absent.
 */
export function normalizeDomain(domain?: unknown): string | undefined {
  const s = String(domain ?? "").trim().toLowerCase();
  if (!s) return undefined;
  const slug = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || undefined;
}

// Ranking weights. BM25 core over query terms (title tokens counted heavier),
// then secondary boosts. Tuned for hundreds–low-thousands of items.
const RANK = {
  k1: 1.5,
  b: 0.75,
  titleWeight: 3, // a query hit in the title counts as 3 body hits
  tagBoost: 4,
  domainBoost: 5,
  pinnedBoost: 2,
  recencyMax: 2,
  recencyDays: 30,
};

// Type priors — a decision/constraint outranks a passing note at equal relevance.
const TYPE_WEIGHT: Record<string, number> = {
  decision: 2,
  constraint: 2,
  architecture: 1.5,
  fact: 1,
  glossary: 1,
  todo: 0.5,
  note: 0,
};

/**
 * Rank items for a query using a BM25-lite core (corpus IDF + length
 * normalization, title tokens weighted) plus secondary signals: tag matches,
 * domain match (explicit filter or query mention), pinned, type prior, and a
 * recency nudge. Returns every item with its score, sorted descending; callers
 * filter `score > 0`.
 *
 * Replaces the flat substring `scoreItem` for retrieval — same inputs available,
 * but rare terms outweigh common ones and title hits beat body hits, so the top
 * of the list is tighter and the LLM reads fewer wasted items. `scoreItem` is
 * kept for back-compat.
 */
export function rankItems(
  items: MemoryItem[],
  queryText: string,
  opts: { tagTokens?: string[]; domain?: string; now?: number } = {},
): Array<{ item: MemoryItem; score: number }> {
  const qSet = new Set(tokenize(queryText));
  const tagTokens = opts.tagTokens ?? [];
  const now = opts.now ?? Date.now();
  const N = Math.max(items.length, 1);

  // Document frequency over title+content tokens, for IDF.
  const df = new Map<string, number>();
  const docs = items.map((it) => {
    const titleToks = tokenize(it.title);
    const bodyToks = tokenize(it.content);
    for (const term of new Set([...titleToks, ...bodyToks])) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
    return { titleToks, bodyToks, len: titleToks.length + bodyToks.length };
  });
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / N || 1;

  return items
    .map((it, i) => {
      const doc = docs[i];
      let score = 0;

      for (const term of qSet) {
        const dfT = df.get(term) ?? 0;
        // BM25+ nonneg IDF: always >= 0 so common terms never subtract.
        const idf = Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5));
        const tfTitle = doc.titleToks.filter((t) => t === term).length * RANK.titleWeight;
        const tfBody = doc.bodyToks.filter((t) => t === term).length;
        const tf = tfTitle + tfBody;
        if (tf === 0) continue;
        const denom = tf + RANK.k1 * (1 - RANK.b + RANK.b * (doc.len / avgLen));
        score += (idf * (tf * (RANK.k1 + 1))) / denom;
      }

      const itemTags = new Set(normalizeTags(it.tags));
      for (const t of tagTokens) if (itemTags.has(t)) score += RANK.tagBoost;

      if (it.domain) {
        if (opts.domain && it.domain === opts.domain) score += RANK.domainBoost;
        if (qSet.has(it.domain)) score += RANK.domainBoost;
      }

      if (it.pinned) score += RANK.pinnedBoost;

      // Priors only apply once an item already has some relevance signal, so
      // pure-noise items stay at 0 and get filtered out by callers.
      if (score > 0) {
        score += TYPE_WEIGHT[it.type] ?? 0;
        const t = Date.parse(it.updatedAt || it.createdAt || "");
        if (Number.isFinite(t)) {
          const ageDays = (now - t) / 86400000;
          if (ageDays >= 0 && ageDays < RANK.recencyDays) {
            score += RANK.recencyMax * (1 - ageDays / RANK.recencyDays);
          }
        }
      }

      return { item: it, score };
    })
    .sort((a, b) => b.score - a.score);
}

/** One line in a memory map — the cheap index the LLM scans before drilling in. */
export interface MemoryMapEntry {
  id: string;
  title: string;
  type: string;
  snippet?: string;
}

/** A domain's slice of the map: how many items, and their index lines. */
export interface MemoryMapGroup {
  domain: string;
  count: number;
  items: MemoryMapEntry[];
}

export interface MemoryMap {
  total: number;
  groups: MemoryMapGroup[];
}

/** Bucket key for an item with no domain set. */
export const NO_DOMAIN = "(none)";

/**
 * Build a compact, domain-grouped index of items — the "map" half of
 * map-then-drill retrieval. The point is minimal tokens: each entry is just
 * id/title/type (plus an optional one-line snippet), so an agent can survey the
 * whole store cheaply and then `memory_expand` only the ids it actually needs,
 * instead of loading every item's full content into context.
 *
 * Groups are sorted by size (largest domain first), then name; items within a
 * group are newest-first. Pure and deterministic — the caller filters
 * expired/typed items before passing them in.
 */
export function buildMemoryMap(
  items: MemoryItem[],
  opts: { includeSnippet?: boolean } = {},
): MemoryMap {
  const byDomain = new Map<string, MemoryItem[]>();
  for (const it of items) {
    const key = it.domain || NO_DOMAIN;
    const bucket = byDomain.get(key);
    if (bucket) bucket.push(it);
    else byDomain.set(key, [it]);
  }

  const recency = (it: MemoryItem): number =>
    Date.parse(it.updatedAt || it.createdAt || "") || 0;

  const groups: MemoryMapGroup[] = [...byDomain.entries()]
    .map(([domain, list]) => ({
      domain,
      count: list.length,
      items: [...list]
        .sort((a, b) => recency(b) - recency(a))
        .map((it) => ({
          id: it.id,
          title: it.title,
          type: it.type,
          ...(opts.includeSnippet ? { snippet: safeSnippet(it.content, 120) } : {}),
        })),
    }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  return { total: items.length, groups };
}

/** All valid link relationship types. */
export const LINK_RELS: LinkRel[] = [
  "part-of",
  "relates-to",
  "depends-on",
  "supersedes",
  "example-of",
];
const LINK_REL_SET = new Set<string>(LINK_RELS);

export function isLinkRel(rel: unknown): rel is LinkRel {
  return typeof rel === "string" && LINK_REL_SET.has(rel);
}

/**
 * Ids of items that some other item marks as superseded (an edge with
 * `rel: "supersedes"` pointing at them). These are stale — retrieval hides them
 * by default so the newer item wins and the model doesn't read both.
 */
export function supersededIds(items: MemoryItem[]): Set<string> {
  const stale = new Set<string>();
  for (const it of items) {
    for (const link of it.links ?? []) {
      if (link.rel === "supersedes") stale.add(link.to);
    }
  }
  return stale;
}

/**
 * Expand a seed set of item ids to include their linked neighbors, following
 * outbound edges up to `hops` levels. Used to widen a context bundle precisely:
 * once the ranked items are chosen, pull in what they point at (dependencies,
 * parents, examples) instead of unrelated high-scoring items. Only edges whose
 * target still exists are followed. Returns the seeds plus reachable neighbors.
 */
export function expandByLinks(
  items: MemoryItem[],
  seedIds: Iterable<string>,
  hops = 1,
): Set<string> {
  const byId = new Map(items.map((it) => [it.id, it]));
  const result = new Set<string>();
  for (const id of seedIds) if (byId.has(id)) result.add(id);

  let frontier = [...result];
  for (let h = 0; h < hops && frontier.length; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const link of byId.get(id)?.links ?? []) {
        if (byId.has(link.to) && !result.has(link.to)) {
          result.add(link.to);
          next.push(link.to);
        }
      }
    }
    frontier = next;
  }
  return result;
}

export function tokenize(s: unknown): string[] {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2)
    .slice(0, 40);
}

export function newId(prefix: string): string {
  // short, stable-ish id for CLI readability
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}_${id}`;
}

export function findSimilarItems(
  items: MemoryItem[],
  title: string,
  content: string,
  threshold = 0.5,
): Array<{ item: MemoryItem; similarity: number }> {
  const queryTokens = tokenize(`${title} ${content}`);
  if (queryTokens.length === 0) return [];

  return items
    .map((item) => {
      const itemTokens = tokenize(`${item.title} ${item.content}`);
      if (itemTokens.length === 0) return { item, similarity: 0 };
      const overlap = queryTokens.filter((t) => itemTokens.includes(t)).length;
      const similarity = overlap / Math.max(queryTokens.length, itemTokens.length);
      return { item, similarity };
    })
    .filter((x) => x.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);
}

export function isExpired(item: MemoryItem): boolean {
  if (!item.expiresAt) return false;
  const exp = Date.parse(item.expiresAt);
  return Number.isFinite(exp) && exp < Date.now();
}

export function validateType(type: unknown): MemoryType {
  const t = String(type || "note").toLowerCase().trim();
  return ALLOWED_TYPES.has(t as MemoryType) ? (t as MemoryType) : "note";
}
