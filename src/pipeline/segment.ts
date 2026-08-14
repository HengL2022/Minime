// Deterministic multi-entity capture plan. The single-label classifier files one row;
// this pre-pass decides whether extra named orgs/people should become first-class
// identities, or whether the capture is too ambiguous to auto-file (never guess).
// Gated on a cheap cue so a normal one-thing capture still costs one classify call
// and takes this path only when the text looks like several fileable entities.

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
