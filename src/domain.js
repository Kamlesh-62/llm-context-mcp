import crypto from "node:crypto";

import { ALLOWED_TYPES, CONFIG } from "./config.js";

export function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  const norm = arr
    .map((t) => String(t || "").trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(norm)).slice(0, 20);
}

export function safeSnippet(text, maxChars = CONFIG.maxContentSnippetChars) {
  const s = String(text ?? "");
  const trimmed = s.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

export function scoreItem(item, queryTokens, tagTokens) {
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

export function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9_\-]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2)
    .slice(0, 40);
}

export function newId(prefix) {
  // short, stable-ish id for CLI readability
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}_${id}`;
}

export function validateType(type) {
  const t = String(type || "note").toLowerCase().trim();
  return ALLOWED_TYPES.has(t) ? t : "note";
}
