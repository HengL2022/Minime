// Multi-entity capture plan. The single-label classifier files one row; this
// pre-pass decides whether extra named orgs/people should become first-class
// identities, or whether a strong deterministic cue is too ambiguous to auto-file.
// Ordinary one-thing captures stay on the single-classify path (no extra LLM call).

import { config } from "../util/config";

export type CaptureEntity = { kind: "org" | "person"; name: string };

export type EntityPlan =
  | { kind: "none" }
  | { kind: "entities"; entities: CaptureEntity[] }
  | { kind: "uncertain"; reason: string };

const MAX_ENTITIES = 8;
const LEGAL_SUFFIX = "AS|A\\/S|ASA|AB|ApS|Oy|Inc\\.?|Ltd\\.?|LLC|GmbH|Labs?|Biotech";
// Case-sensitive: English "as" must not count as the Norwegian legal suffix AS.
const SUFFIX_RE = new RegExp(`\\s+(?:${LEGAL_SUFFIX})\\b`, "gu");
const ORG_RE = new RegExp(
  `(\\p{Lu}[\\p{L}\\d&.’'-]+(?:\\s+[\\p{L}\\d&.’'-]+)*)\\s+(${LEGAL_SUFFIX})\\b`,
  "gu",
);
const PERSON_AFTER_VERB =
  /\b(?:asked|emailed|met|called|told|talked to)\s+(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)+)\b/gu;
const PERSON_APPOSITIVE =
  /(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)+),\s+the\s+(?:sales\s+lead|lead|manager|director|founder|engineer)\b/gu;
const ENUMERATED =
  /\b(?:two|three|four|five|[2-9]|1\d)\s+(?:suppliers?|vendors?|companies|organizations?)\b/i;
const CONTACT_RE =
  /\b(?:emailed|email|called|met|talked to|talked with|asked|coffee with|lunch with)\b/i;
const MEET_RE = /\b(?:met|talked to|talked with|asked|coffee with|lunch with)\b/i;
const EMAIL_CALL_RE = /\b(?:emailed|called)\b/i;
const AT_FROM_RE =
  /\b(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)+)\s+(?:at|from)\s+(\p{Lu}[\p{L}\d&.'-]+(?:\s+\p{Lu}[\p{L}\d&.'-]+)*)/gu;
const FIRST_LAST_RE = /\b(\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}+)\b/gu;
const MULTI_WORD_RE = /\b(\p{Lu}[\p{L}\d&.'-]+(?:\s+\p{Lu}[\p{L}\d&.'-]+)+)\b/gu;
const CONTACT_CLAUSE =
  /\b(?:emailed|email|called|met|talked to|talked with|asked|coffee with|lunch with)\s+([^.;\n]+)/giu;

function normalize(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .replace(/[,.;:]+$/u, "")
    .trim();
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalize(raw);
    const key = name.toLowerCase();
    if (name.length < 3 || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function extractOrgNames(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(ORG_RE)) {
    found.push(`${m[1]} ${m[2]}`);
  }
  return uniqueNames(found);
}

export function extractPersonNames(text: string, orgNames: string[]): string[] {
  const blocked = orgNames.map((n) => n.toLowerCase());
  const found: string[] = [];
  for (const re of [PERSON_AFTER_VERB, PERSON_APPOSITIVE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) found.push(m[1]!);
  }
  return uniqueNames(found).filter(
    (name) => !blocked.some((org) => org.includes(name.toLowerCase())),
  );
}

function suffixCount(text: string): number {
  return [...text.matchAll(SUFFIX_RE)].length;
}

export function planCaptureEntities(text: string): EntityPlan {
  const suffixes = suffixCount(text);
  const enumerated = ENUMERATED.test(text);
  if (suffixes < 2 && !enumerated) return { kind: "none" };

  const orgs = extractOrgNames(text);
  const people = extractPersonNames(text, orgs);
  const entities: CaptureEntity[] = [
    ...orgs.map((name) => ({ kind: "org" as const, name })),
    ...people.map((name) => ({ kind: "person" as const, name })),
  ];
  if (entities.length > MAX_ENTITIES) {
    return { kind: "uncertain", reason: "too many named entities to file automatically" };
  }
  if (orgs.length >= 2) return { kind: "entities", entities };
  if (enumerated && entities.length >= 2) return { kind: "entities", entities };
  if (enumerated) {
    return {
      kind: "uncertain",
      reason: "enumerated companies or people could not be parsed into named items",
    };
  }
  return { kind: "uncertain", reason: "multi-entity cue without a confident name list" };
}

export function usableEntityName(raw: string): string | null {
  const name = normalize(raw).slice(0, 120);
  if (name.length < 2 || name.length > 80) return null;
  if (!/^\p{L}/u.test(name) || !/\p{L}/u.test(name)) return null;
  if (/[.\n]/.test(name) || /https?:/i.test(name)) return null;
  return name;
}

function contactClauses(text: string): string[] {
  const clauses: string[] = [];
  CONTACT_CLAUSE.lastIndex = 0;
  for (const m of text.matchAll(CONTACT_CLAUSE)) {
    clauses.push(m[1]!.split(/\b(?:about|regarding|for)\b/i)[0]!);
  }
  return clauses;
}

function namesIn(text: string, re: RegExp): string[] {
  re.lastIndex = 0;
  return uniqueNames([...text.matchAll(re)].map((m) => m[1]!));
}

function atFromPairs(text: string): { person: string; org: string }[] {
  const out: { person: string; org: string }[] = [];
  AT_FROM_RE.lastIndex = 0;
  for (const m of text.matchAll(AT_FROM_RE)) {
    const person = usableEntityName(m[1]!);
    const org = usableEntityName(m[2]!);
    if (person && org) out.push({ person, org });
  }
  return out;
}

function peopleInContactClauses(text: string): string[] {
  return uniqueNames(contactClauses(text).flatMap((clause) => namesIn(clause, FIRST_LAST_RE)));
}

function phrasesInContactClauses(text: string): string[] {
  return uniqueNames(contactClauses(text).flatMap((clause) => namesIn(clause, MULTI_WORD_RE)));
}

// Weaker than the legal-suffix / enumeration cue. "met Alice and Bob" stays off
// this path (single tokens, no at/from, no First Last pair).
export function llmSegmentCue(text: string): boolean {
  if (atFromPairs(text).length >= 2) return true;
  if (peopleInContactClauses(text).length >= 2) return true;
  return CONTACT_RE.test(text) && phrasesInContactClauses(text).length >= 2;
}

function pushEntity(
  entities: CaptureEntity[],
  seen: Set<string>,
  kind: "org" | "person",
  raw: string,
) {
  const name = usableEntityName(raw);
  if (!name) return;
  const key = name.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  entities.push({ kind, name });
}

export function heuristicSegmentEntities(text: string): EntityPlan {
  if (!llmSegmentCue(text)) return { kind: "none" };
  const entities: CaptureEntity[] = [];
  const seen = new Set<string>();
  for (const pair of atFromPairs(text)) {
    pushEntity(entities, seen, "person", pair.person);
    pushEntity(entities, seen, "org", pair.org);
  }
  if (MEET_RE.test(text)) {
    for (const name of peopleInContactClauses(text)) pushEntity(entities, seen, "person", name);
  }
  if (EMAIL_CALL_RE.test(text)) {
    for (const name of phrasesInContactClauses(text)) pushEntity(entities, seen, "org", name);
  }
  if (entities.length < 2 || entities.length > MAX_ENTITIES) return { kind: "none" };
  return { kind: "entities", entities };
}

export function parseLlmEntityPlan(raw: string): EntityPlan {
  try {
    const parsed = JSON.parse(raw) as { entities?: unknown };
    if (!Array.isArray(parsed.entities) || parsed.entities.length > MAX_ENTITIES)
      return { kind: "none" };
    const entities: CaptureEntity[] = [];
    const seen = new Set<string>();
    for (const item of parsed.entities) {
      if (!item || typeof item !== "object") continue;
      const row = item as { kind?: unknown; name?: unknown };
      if (row.kind !== "org" && row.kind !== "person") continue;
      if (typeof row.name !== "string") continue;
      pushEntity(entities, seen, row.kind, row.name);
    }
    if (entities.length < 2) return { kind: "none" };
    return { kind: "entities", entities };
  } catch {
    return { kind: "none" };
  }
}

function buildSegmentPrompt(text: string): string {
  return `You extract named people and organizations from a personal capture.
Return ONLY JSON: {"entities":[{"kind":"org"|"person","name":"..."}]}.
Include a name only when it is clearly written in the text. Do not invent names.
Do not copy sentences. kind is org for a company/vendor/institution and person for a human.
If there are fewer than two named entities, return {"entities":[]}. Cap at 8 names.

Text:
${text.slice(0, 4000)}`;
}

// Deterministic plan wins. LLM (or the mock heuristic) runs only when that plan
// is silent and a weaker multi-name cue fired. Failure / junk / a single name
// is none — never unfile a good one-thing capture, never mint Unknown.
export async function resolveEntityPlan(text: string, fetchFn?: typeof fetch): Promise<EntityPlan> {
  const det = planCaptureEntities(text);
  if (det.kind !== "none") return det;
  if (!llmSegmentCue(text)) return { kind: "none" };
  if (config.mockOllama) return heuristicSegmentEntities(text);
  try {
    const { classifyProviderForTier } = await import("../llm");
    const raw = await classifyProviderForTier(2, fetchFn).completeJson(buildSegmentPrompt(text));
    return parseLlmEntityPlan(raw);
  } catch {
    return { kind: "none" };
  }
}
