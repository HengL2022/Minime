// Title-phrase boost (spec §9 amendment, Phase 1a). Pure module: decides whether a query
// names a result's title closely enough to deserve a bounded post-fusion multiplier.
//
// Why token-boundary, never raw substring: a substring test ("art" in "Bartholomew")
// fires on accidental letter runs and on partial words, polluting ranking. We match the
// query as a CONTIGUOUS RUN OF WHOLE TOKENS inside the title's token sequence instead, so
// "rivian r1t" matches the title "Rivian R1T deep-dive" but "vian r" matches nothing.
//
// Why the stopword/length guard: a single common word ("the", "and", a CJK function
// word) overlapping a title is meaningless. We require the matched run to carry ≥2
// non-stopword tokens, OR the query to equal the whole title exactly (token-for-token) —
// the latter covers legitimate one-word titles like "Quokkas".
//
// CJK-aware: Han runs are bigram-folded with cjkFold() (mirroring the FTS index side)
// before tokenizing, so "招商银行" tokenizes to ["zh62db5546","zh554694f6","zh94f6884c"]
// on both sides and matches on token boundaries rather than raw characters.

import { cjkFold, isCjkStopToken, isCjkToken } from "../util/cjk";

// Bounded multiplier applied to a hit's fused score when its title matches the query.
// Kept modest: the boost should reorder near-ties, not let a title match dominate a much
// stronger semantic+lexical result. // eval-calibration pending
export const TITLE_BOOST = 1.25;
export const TITLE_BOOST_EXACT = 1.4; // query == full title: a near-certain intent signal

// Small English stopword set — enough to neutralize the most common filler. CJK function
// words are handled separately by isCjkStopToken (the 'english' list knows no Chinese).
const EN_STOP = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "my",
  "me",
  "i",
  "it",
  "this",
  "that",
  "about",
  "what",
  "who",
  "when",
  "how",
]);

function isStop(token: string): boolean {
  return EN_STOP.has(token) || isCjkStopToken(token);
}

// Identical tokenization for query and title: fold Han runs to bigrams, lowercase, split
// on any non-letter/non-digit boundary. Empty tokens dropped.
export function tokenize(text: string): string[] {
  return cjkFold(text.toLowerCase())
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Is `needle` a contiguous run of whole tokens inside `haystack`? (subarray search)
function containsRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

// scale (≥1) lets the entity-intent nudge widen the boost's lift above 1.0; scale=1 keeps
// the defaults. Returns 1.0 (no boost) when the query does not phrase-match the title.
export function titleBoost(query: string, title: string, scale = 1): number {
  const q = tokenize(query);
  const t = tokenize(title);
  if (q.length === 0 || t.length === 0) return 1;
  if (!containsRun(t, q)) return 1;

  const exact = q.length === t.length; // containsRun + equal length ⇒ same sequence
  if (exact) return 1 + (TITLE_BOOST_EXACT - 1) * scale;

  // CJK bigram lexemes count as content even when they fold function words — dropping
  // them here would let an all-function-word run lose a boost the raw-char era granted
  // (behavior preserved across the hex-lexeme migration).
  const content = q.filter((tok) => !isStop(tok) || isCjkToken(tok));
  if (content.length < 2) return 1; // not enough signal for a partial match
  return 1 + (TITLE_BOOST - 1) * scale;
}
