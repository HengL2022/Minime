// Autocut (Phase 3): cut the ranked list where the score curve breaks, instead of
// returning a fixed top-K. Runs on CROSS-ENCODER scores only — GBrain measured that
// RRF rank-gaps are near-identical whether rank-1 is right or wrong (mechanical decay),
// while rerank scores form a real cliff. Pure module; opt-in via hybridSearch.

const MIN_GAP = 0.35; // of the observed score range; eval-derived starting point
const MIN_KEEP = 1;

/**
 * Given descending-ranked rerank scores, return how many results to keep: cut at the
 * largest gap that spans ≥ MIN_GAP of the score range. Returns `scores.length` (no cut)
 * when fewer than 2 finite scores or no qualifying cliff exists.
 */
export function autocut(scores: number[]): number {
  const finite = scores.filter((s) => Number.isFinite(s));
  if (finite.length < 2) return scores.length;
  const range = finite[0]! - finite[finite.length - 1]!;
  if (range <= 0) return scores.length;

  let cutAt = scores.length;
  let bestGap = 0;
  for (let i = 0; i < finite.length - 1; i++) {
    const gap = (finite[i]! - finite[i + 1]!) / range;
    if (gap >= MIN_GAP && gap > bestGap) {
      bestGap = gap;
      cutAt = i + 1;
    }
  }
  return Math.max(MIN_KEEP, cutAt);
}
