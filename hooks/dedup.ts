/**
 * Pure dedup-decision helpers for auto-captured memory. Kept free of any store
 * or dynamic-import dependency so it can be unit-tested directly.
 */

export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export type DedupDecision =
  | { action: "add" }
  | { action: "skip" }
  | { action: "update"; index: number };

type Existing = { title: string; type: string };
type Candidate = { title: string; type: string };

/**
 * Decide whether an auto-captured candidate is new (ADD), a refinement of an
 * existing memory (UPDATE), or already covered (SKIP). Replaces the old
 * add-or-skip-only behavior so near-duplicates refresh an item instead of
 * piling up, and contradictory restatements of the same fact update in place.
 *
 * Thresholds are on title Jaccard similarity (one differing token out of ~5
 * scores ≈ 0.67, so "moderately similar" sits around 0.6):
 *  - ≥ 0.9              → SKIP (essentially identical)
 *  - ≥ 0.6, same type   → UPDATE the closest existing item
 *  - ≥ 0.75             → SKIP (similar but a different kind of item)
 *  - otherwise          → ADD
 */
export function classifyCandidate(
  existing: Existing[],
  candidate: Candidate,
  opts: { skipThreshold?: number; updateThreshold?: number } = {},
): DedupDecision {
  const skipThreshold = opts.skipThreshold ?? 0.9;
  const updateThreshold = opts.updateThreshold ?? 0.6;

  let bestIndex = -1;
  let bestSim = 0;
  for (let i = 0; i < existing.length; i++) {
    const sim = jaccardSimilarity(existing[i].title, candidate.title);
    if (sim > bestSim) {
      bestSim = sim;
      bestIndex = i;
    }
  }

  if (bestIndex < 0) return { action: "add" };
  if (bestSim >= skipThreshold) return { action: "skip" };
  if (bestSim >= updateThreshold && existing[bestIndex].type === candidate.type) {
    return { action: "update", index: bestIndex };
  }
  if (bestSim >= 0.75) return { action: "skip" };
  return { action: "add" };
}
