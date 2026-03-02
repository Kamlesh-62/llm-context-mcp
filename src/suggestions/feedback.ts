import fs from "node:fs/promises";
import path from "node:path";

import { nowIso } from "../runtime.js";
import type { CategoryFeedback, FeedbackStore, RuleCategory } from "./types.js";
import { ALL_CATEGORIES } from "./rules.js";

export function defaultFeedback(): FeedbackStore {
  const categories = {} as Record<RuleCategory, CategoryFeedback>;
  for (const cat of ALL_CATEGORIES) {
    categories[cat] = { multiplier: 1.0, accepts: 0, rejects: 0 };
  }
  return { categories, updatedAt: nowIso() };
}

export async function loadFeedbackFromDisk(feedbackPath: string): Promise<FeedbackStore> {
  if (!feedbackPath) return defaultFeedback();
  try {
    const raw = await fs.readFile(feedbackPath, "utf8");
    const parsed = JSON.parse(raw) as FeedbackStore;
    if (parsed && parsed.categories) return parsed;
  } catch {
    // file missing or corrupt
  }
  return defaultFeedback();
}

export async function saveFeedbackToDisk(
  feedbackPath: string,
  feedback: FeedbackStore,
): Promise<void> {
  if (!feedbackPath) return;
  feedback.updatedAt = nowIso();
  try {
    await fs.mkdir(path.dirname(feedbackPath), { recursive: true });
    const tmp = `${feedbackPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(feedback, null, 2), "utf8");
    await fs.rename(tmp, feedbackPath);
  } catch {
    // best-effort
  }
}
