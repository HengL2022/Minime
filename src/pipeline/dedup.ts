// Title-similarity for inbox task dedup. The classifier has no memory of existing rows,
// so re-mentioning the same task (e.g. a kindergarten event reminded twice) used to insert
// a brand-new task every time. We catch likely duplicates here and route them to the
// review queue rather than silently creating a second row — conservative by design: it
// flags for the owner, never auto-merges.

// Normalize a title to a comparable token set: lowercase, strip possessives + punctuation,
// drop short stopwords, collapse whitespace.
const STOP = new Set([
  "the",
  "a",
  "an",
  "to",
  "for",
  "of",
  "at",
  "in",
  "on",
  "and",
  "with",
  "by",
  "is",
  "are",
  "be",
  "event",
  "day",
]);

export function tokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/['’]s\b/g, "") // possessives: "mia's" -> "mia"
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ") // keep alnum + CJK
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

// Overlap coefficient of the significant tokens of two titles, 0..1: |A∩B| / min(|A|,|B|).
// Chosen over Jaccard because a duplicate capture often adds detail ("arrive 2.15pm,
// covered shoes"), inflating the union and sinking Jaccard below threshold even when one
// title's tokens are nearly a subset of the other's. Overlap stays high in that case.
export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const denom = Math.min(ta.size, tb.size);
  return denom === 0 ? 0 : inter / denom;
}

// Normalize a due value (string "YYYY-MM-DD" or a JS Date from postgres) to an ISO day.
function isoDay(due: string | Date | null): string | null {
  if (due == null) return null;
  if (due instanceof Date) return due.toISOString().slice(0, 10);
  const s = String(due);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export interface DedupCandidate {
  id: string;
  title: string;
  due: string | Date | null;
}

// Find the best duplicate match for a candidate title among open tasks. A match needs
// strong title overlap; when both have a due date, they must be within `dueWindowDays`
// (a recurring weekly chore on different dates is NOT a duplicate). Returns the matched
// row + score, or null when nothing clears the bar.
export function findDuplicate(
  candidateTitle: string,
  candidateDue: string | null,
  open: DedupCandidate[],
  opts: { threshold?: number; dueWindowDays?: number } = {},
): { match: DedupCandidate; score: number } | null {
  const threshold = opts.threshold ?? 0.5;
  const dueWindowDays = opts.dueWindowDays ?? 3;
  const candDay = isoDay(candidateDue);
  let best: { match: DedupCandidate; score: number } | null = null;
  for (const row of open) {
    const score = titleSimilarity(candidateTitle, row.title);
    if (score < threshold) continue;
    const rowDay = isoDay(row.due);
    if (candDay && rowDay) {
      const days = Math.abs(Date.parse(candDay) - Date.parse(rowDay)) / 86_400_000;
      if (days > dueWindowDays) continue; // same words, different date → not a dup
    }
    if (!best || score > best.score) best = { match: row, score };
  }
  return best;
}
