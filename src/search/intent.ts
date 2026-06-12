// Zero-LLM query-intent classifier (spec §9 amendment, Phase 1a). Pure, deterministic,
// offline: it inspects only the query string and emits *nudges* — small weight deltas the
// fusion path applies on top of its defaults. Intent never overrides anything explicit
// (tier predicate, types filter, derived penalty); a misclassification can only re-rank,
// never hide or surface forbidden content.
//
// Four classes, each mapping to exactly one fusion lever so the effect is auditable:
//   entity   → the query names a person/org/title → trust the title-phrase boost more.
//   temporal → "as of <month>", "latest", "recent" → trust recency more.
//   event    → "what happened", "meeting", "call" → the lexical/FTS arm matters more.
//   general  → no signal → no change (the safe default).

import { CJK_CHAR } from "../util/cjk";

export type Intent = "entity" | "temporal" | "event" | "general";

// Multiplicative nudges layered on the fusion defaults; 1.0 == no change. Bands kept
// narrow so a wrong guess only lightly perturbs ranking. // eval-calibration pending
export interface IntentNudge {
  intent: Intent;
  titleBoostScale: number; // scales the title-phrase boost's lift above 1.0
  recencyScale: number; // scales the recency multiplier's lift above 1.0
  ftsRrfWeight: number; // multiplies the FTS arm's RRF contribution
}

const NUDGES: Record<Intent, Omit<IntentNudge, "intent">> = {
  entity: { titleBoostScale: 1.4, recencyScale: 1.0, ftsRrfWeight: 1.0 },
  temporal: { titleBoostScale: 1.0, recencyScale: 1.6, ftsRrfWeight: 1.0 },
  event: { titleBoostScale: 1.0, recencyScale: 1.0, ftsRrfWeight: 1.25 },
  general: { titleBoostScale: 1.0, recencyScale: 1.0, ftsRrfWeight: 1.0 },
};

// Lowercased substring cues. Deliberately small and explainable rather than a learned
// model — a maintainer can read off why any query classified the way it did.
const TEMPORAL_CUES = [
  "as of",
  "latest",
  "most recent",
  "recently",
  "recent",
  "current",
  "currently",
  "today",
  "yesterday",
  "this week",
  "last week",
  "this month",
  "last month",
  "this year",
  "last year",
];
const MONTHS =
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/;
const EVENT_CUES = [
  "what happened",
  "what did",
  "meeting",
  "meetings",
  "call",
  "calls",
  "event",
  "conversation",
  "discussion",
  "talked",
  "spoke",
  "happened",
  "occurred",
  "trip",
];
// Phrases that signal "find a specific named thing" rather than a topic search.
const ENTITY_CUES = ["who is", "who's", "profile of", "contact for", "page for"];

function hasAny(q: string, cues: string[]): boolean {
  return cues.some((c) => q.includes(c));
}

// A short query (≤3 tokens) of capitalized words, or a query that is entirely CJK, reads
// as a name/title lookup rather than a question — a soft entity signal.
function looksLikeName(raw: string): boolean {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return false;
  if (raw.replace(CJK_CHAR, "").trim() === "") return true; // CJK-only
  return tokens.every((t) => /^[A-Z]/.test(t));
}

// Precedence: temporal beats event beats entity. Temporal/event cues describe how the
// user wants results ranked (by time, by lexical match); entity is the weakest, most
// ambiguous signal, so it loses ties.
export function classifyIntent(query: string): Intent {
  const q = query.toLowerCase();
  if (hasAny(q, TEMPORAL_CUES) || MONTHS.test(q)) return "temporal";
  if (hasAny(q, EVENT_CUES)) return "event";
  if (hasAny(q, ENTITY_CUES) || looksLikeName(query)) return "entity";
  return "general";
}

export function intentNudge(query: string): IntentNudge {
  const intent = classifyIntent(query);
  return { intent, ...NUDGES[intent] };
}
