// Zero-LLM typed edge extraction (DECISIONS.md 2026-06-11). A rule/pattern layer that
// turns prose into graph rows: `mentions` edges for known people/orgs, `works_at` edges
// (person → org), owner-relations ("my physiotherapist") onto people.relation, and
// discovery of new people/orgs anchored to high-precision cues. Deterministic regex only —
// no model calls — so it is cheap, auditable, and runs on every write (indexParent) plus
// a nightly backlog pass (dream step 2). Confidence: 0.85 same sentence, 0.7 same
// paragraph, 0.6 page-dominant org.

import {
  type EntityRef,
  addAlias,
  addOrgAlias,
  allOrgsWithAliases,
  allPeopleWithAliases,
  edgeExists,
  ensureOrg,
  ensurePerson,
  insertEdge,
  parentTable,
  peopleByFirstName,
  resolveOrg,
  resolvePerson,
  setOrgCanonicalName,
  setPersonCanonicalName,
  setPersonRelationIfNull,
} from "../db/repo";

const ACTOR = "system:extract";

// Owner-relations: roles that describe how a person relates to the owner.
const ROLES =
  "manager|boss|physiotherapist|physio|gp|doctor|dentist|vet|veterinarian|therapist|" +
  "teacher|coach|mentor|landlord|landlady|sister|brother|dad|mom|father|mother|friend|" +
  "colleague|collaborator|accountant|lawyer|neighbour|neighbor|trainer|luthier";
// Job titles: imply employment (works_at cue) but are not owner-relations.
const TITLES =
  "engineer|scientist|analyst|developer|designer|consultant|director|founder|lead|" +
  "researcher|professor|nurse|advisor|architect";
const PROF_ROLES = "physiotherapist|physio|gp|doctor|dentist|vet|veterinarian|therapist";
const WORK_CUE = new RegExp(
  `\\b(work\\w*|job|join\\w*|employ\\w*|career|hired|intern\\w*|insur\\w*|service\\w*|${PROF_ROLES}|${TITLES}|manager|boss)\\b`,
  "iu",
);
const NAME = String.raw`(?:Dr\.?\s+)?\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){0,2}`;
const ORGPH = String.raw`(?:\p{Lu}|\d)[\p{L}\d&.’'-]*(?:\s+(?:(?:\p{Lu}|\d)[\p{L}\d&.’'-]*|AS|A\/S))*`;
const LEGAL_SUFFIX = /\s+(AS|A\/S|ASA|AB|ApS|Oy|Inc\.?|Ltd\.?|LLC|GmbH)$/u;
const NAME_STOP = new Set(["the", "my", "our", "we", "i", "norwegian", "norway"]);
const SENTINEL = "․"; // protects honorific dots from the sentence splitter

function hasOrgSuffix(phrase: string): boolean {
  const words = phrase.split(/\s+/);
  const last = words[words.length - 1] ?? "";
  if (
    /^(AS|A\/S|ASA|AB|ApS|Oy|Inc\.?|Ltd\.?|LLC|GmbH|Group|Bank|Railway|Clinic|Hospital|School|College|Institute|Fysio|Bil|Sykehus)$/u.test(
      last,
    )
  )
    return true;
  return words.some((w) =>
    /(senter(et)?|klinikk\w*|legesenter\w*|forsikring|universitet\w*|skole\w*|university|bil)$/iu.test(
      w,
    ),
  );
}

function normalizeRole(role: string): string {
  const r = role.toLowerCase();
  const map: Record<string, string> = {
    physio: "physiotherapist",
    veterinarian: "vet",
    landlady: "landlord",
    mom: "mother",
    dad: "father",
    neighbour: "neighbor",
  };
  return map[r] ?? r;
}

function stripHonorific(name: string): string {
  return name.replace(/^Dr\.?\s+/u, "").trim();
}

function normalize(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s>\s/g, ". ") // chunk-heading breadcrumbs ("Title > Section") are boundaries
    .replace(/[*_`#>]+/g, "");
}

function paragraphsOf(text: string): string[] {
  return normalize(text)
    .split(/\n(?=\s*[-•]\s)|\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean);
}

function sentencesOf(paragraph: string): string[] {
  const guarded = paragraph.replace(/\b(Dr|Mr|Mrs|Ms|Prof|St)\./g, `$1${SENTINEL}`);
  return guarded
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replaceAll(SENTINEL, ".").trim())
    .filter(Boolean);
}

// Person discovery: [regex, nameGroup, roleGroup, roleIsRelation]
const PERSON_PATTERNS: [RegExp, number, number, boolean][] = [
  // "my manager is Sigrid Halvorsen", "my teacher, Lars Brodin"
  [
    new RegExp(`\\b(?:my|our)\\s+(?:\\w+[- ])??(${ROLES})\\b(?:\\s+is)?[,:]?\\s+(${NAME})`, "giu"),
    2,
    1,
    true,
  ],
  // "physiotherapist Kari Nystrøm", "Vet: Dr. Annika Moe", "Landlord is Odd-Einar Strand"
  [new RegExp(`\\b(${ROLES})\\b(?:\\s+is)?[:,]?\\s+(${NAME})`, "giu"), 2, 1, true],
  // "Meera — my younger sister", "Tomasz — work friend"
  [
    new RegExp(
      `(${NAME})\\s*(?:—|–|-{1,2})\\s*(?:my|our|the)?\\s*(?:\\w+[- ])??(${ROLES})\\b`,
      "giu",
    ),
    1,
    2,
    true,
  ],
  // "Tomasz Wójcik, our embedded firmware lead"
  [
    new RegExp(
      `(${NAME}),?\\s+(?:is\\s+)?(?:my|our)\\s+(?:\\w+[- ])??(${ROLES}|${TITLES})\\b`,
      "giu",
    ),
    1,
    2,
    false,
  ],
  // "Appa (dad)"
  [new RegExp(`(${NAME})\\s*\\((${ROLES})\\)`, "giu"), 1, 2, true],
];

const ORG_PREP = new RegExp(`\\b(?:at|for|with)\\s+(${ORGPH})`, "gu");
const ORG_JOIN = new RegExp(`\\bjoin(?:ed|ing|s)?\\s+(${ORGPH})`, "giu");
const ORG_BARE = new RegExp(`(${ORGPH})`, "gu"); // standalone: requires an org suffix
// "the research partner is NTNU's Department…" — the role noun is the cue
const ORG_ROLE = new RegExp(
  `\\b(?:partner|client|customer|vendor|supplier|insurer|employer)\\s+is\\s+(${ORGPH})`,
  "giu",
);

// Fix A (2026-06-16): non-org stoplist — cities, generic nouns, and lab/therapy
// concepts the extractor used to mis-type as orgs. Exact (case-folded) phrase match
// only, so real multi-word orgs containing these words ("Goddard School") are unaffected.
// See docs/known-issues/extractor-phantom-orgs.md.
const NON_ORG_TERMS = new Set(
  [
    // cities / places
    "wuhan", "beijing", "shanghai", "shenzhen", "guangzhou", "singapore", "huangpu",
    "zhuhai", "guangdong",
    // generic nouns
    "school", "lab", "laboratory", "office", "home", "hospital", "clinic",
    "university", "college", "company", "group", "team", "department",
    // lab / therapy / assay concepts
    "car-t", "cart", "crispr", "facs", "pcr", "elisa", "antibody", "plasmid",
    "ldlr", "egfrviii", "il-13", "il13",
  ].map((s) => s.toLowerCase()),
);

export interface DiscoveredPerson {
  name: string;
  relation: string | null;
}
export interface WorksAt {
  person: string;
  org: string;
  confidence: number;
}
export interface Facts {
  mentions: EntityRef[];
  people: DiscoveredPerson[];
  orgs: string[];
  worksAt: WorksAt[];
}

function validName(name: string): boolean {
  const first = name.split(/\s+/)[0]!.toLowerCase();
  if (NAME_STOP.has(first)) return false;
  if (new RegExp(`^(${ROLES}|${TITLES})$`, "iu").test(name)) return false;
  return name.length >= 2;
}

function personsIn(sentence: string): DiscoveredPerson[] {
  const found: DiscoveredPerson[] = [];
  for (const [re, nameG, roleG, isRelation] of PERSON_PATTERNS) {
    for (const m of sentence.matchAll(re)) {
      const name = stripHonorific(m[nameG]!);
      if (!validName(name) || hasOrgSuffix(name)) continue;
      const relation = isRelation ? normalizeRole(m[roleG]!) : null;
      const prev = found.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (prev) prev.relation = prev.relation ?? relation;
      else found.push({ name, relation });
    }
  }
  return found;
}

function orgsIn(sentence: string, personNames: string[], knownPersonNames: string[]): string[] {
  const cued = WORK_CUE.test(sentence);
  const out: string[] = [];
  // Names to reject as orgs: people found in this sentence + all known people in
  // the lexicon (so a bare first name like "Heng" is caught even when the only
  // stored alias is the fuller "Heng Liu"). Fix A, 2026-06-16.
  const blocked = new Set(
    [...personNames, ...knownPersonNames].flatMap((n) => {
      const lower = n.toLowerCase();
      // also block the bare first token ("Heng Liu" → "heng") and the possessive form
      return [lower, lower.split(/\s+/)[0]!];
    }),
  );
  const consider = (phrase: string, ok: boolean) => {
    // "NTNU's Department of Marine Technology" → the possessor is the org;
    // but a lone possessive ("Max's") collapses to the bare name, which is then
    // caught by the person/stoplist guards below.
    const p = phrase
      .replace(/['’]s\s.*$/u, "")
      .replace(/['’]s$/u, "")
      .replace(/[,.;:]+$/u, "")
      .trim();
    if (p.length < 3 || !ok) return;
    if (!/\p{Lu}/u.test(p)) return; // "11-week" and other digit-led phrases are not orgs
    const lower = p.toLowerCase();
    if (NAME_STOP.has(lower)) return;
    if (NON_ORG_TERMS.has(lower)) return; // city / generic noun / concept — not an org
    if (blocked.has(lower)) return; // the phrase IS a (known) person's name
    if (personNames.some((n) => n.toLowerCase() === lower || lower.includes(n.toLowerCase())))
      return;
    if (!out.some((o) => o.toLowerCase() === lower)) out.push(p);
  };
  for (const m of sentence.matchAll(ORG_PREP)) consider(m[1]!, cued || hasOrgSuffix(m[1]!));
  for (const m of sentence.matchAll(ORG_JOIN)) consider(m[1]!, true);
  for (const m of sentence.matchAll(ORG_ROLE)) consider(m[1]!, true);
  for (const m of sentence.matchAll(ORG_BARE)) consider(m[1]!, hasOrgSuffix(m[1]!));
  return out;
}

// Which lexicon entries (canonical or alias, word-boundary match) appear in this text?
function knownIn(text: string, entries: { id: string; names: string[] }[]): Map<string, string> {
  const hits = new Map<string, string>(); // id -> matched name
  for (const e of entries) {
    for (const n of e.names) {
      if (!n || n.length < 3) continue;
      const re = new RegExp(
        `(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
        "iu",
      );
      if (re.test(text)) {
        hits.set(e.id, n);
        break;
      }
    }
  }
  return hits;
}

const WORK_ROLES = new RegExp(`^(manager|boss|colleague|collaborator|${TITLES})$`, "iu");

export function extractFacts(
  text: string,
  lexicon: { people: { id: string; names: string[] }[]; orgs: { id: string; names: string[] }[] },
): Facts {
  const paras = paragraphsOf(text);
  const whole = paras.join("\n");
  const knownPeople = knownIn(whole, lexicon.people);
  const knownOrgs = knownIn(whole, lexicon.orgs);

  const people: DiscoveredPerson[] = [];
  const worksAt: WorksAt[] = [];
  const pageScope: string[] = []; // persons with a work-role but no org in their paragraph
  const orgCount = new Map<string, number>();
  // "Fjordsonics" and "Fjordsonics AS" are one org: identity is the legal-suffix-stripped
  // base name; the suffixed form wins as the display name.
  const orgDisplay = new Map<string, string>();
  const orgKey = (phrase: string) => phrase.replace(LEGAL_SUFFIX, "").toLowerCase();
  const registerOrg = (phrase: string) => {
    const key = orgKey(phrase);
    const prev = orgDisplay.get(key);
    if (!prev || phrase.length > prev.length) orgDisplay.set(key, phrase);
    return key;
  };

  const addPerson = (p: DiscoveredPerson) => {
    const prev = people.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (prev) prev.relation = prev.relation ?? p.relation;
    else people.push({ ...p });
  };
  const addWork = (person: string, org: string, confidence: number) => {
    const key = `${person.toLowerCase()}|${orgKey(org)}`;
    const prev = worksAt.find((w) => `${w.person.toLowerCase()}|${orgKey(w.org)}` === key);
    if (prev) prev.confidence = Math.max(prev.confidence, confidence);
    else worksAt.push({ person, org, confidence });
  };

  for (const para of paras) {
    const paraPersons = new Map<string, DiscoveredPerson>();
    const paraOrgs: string[] = [];
    const pairedPersons = new Set<string>();

    for (const sentence of sentencesOf(para)) {
      const persons = personsIn(sentence);
      for (const [id, name] of knownIn(sentence, lexicon.people)) {
        if (!persons.some((p) => p.name.toLowerCase() === name.toLowerCase()))
          persons.push({
            name: lexicon.people.find((e) => e.id === id)!.names[0]!,
            relation: null,
          });
      }
      const sentOrgs = orgsIn(
        sentence,
        persons.map((p) => p.name),
        lexicon.people.flatMap((e) => e.names),
      );
      for (const [id] of knownIn(sentence, lexicon.orgs)) {
        const canonical = lexicon.orgs.find((e) => e.id === id)!.names[0]!;
        if (!sentOrgs.some((o) => o.toLowerCase() === canonical.toLowerCase()))
          sentOrgs.push(canonical);
      }
      for (const p of persons) {
        addPerson(p);
        if (!paraPersons.has(p.name.toLowerCase())) paraPersons.set(p.name.toLowerCase(), p);
      }
      for (const o of sentOrgs) {
        const key = registerOrg(o);
        if (!paraOrgs.some((x) => orgKey(x) === key)) paraOrgs.push(o);
        orgCount.set(key, (orgCount.get(key) ?? 0) + 1);
      }
      if (sentOrgs.length > 0 && (WORK_CUE.test(sentence) || persons.some((p) => p.relation))) {
        for (const p of persons) {
          for (const o of sentOrgs) addWork(p.name, o, 0.85);
          pairedPersons.add(p.name.toLowerCase());
        }
      }
    }

    // paragraph scope: person and org co-occur in the same paragraph with a work cue
    if (paraOrgs.length > 0 && WORK_CUE.test(para)) {
      for (const p of paraPersons.values()) {
        if (pairedPersons.has(p.name.toLowerCase())) continue;
        for (const o of paraOrgs) addWork(p.name, o, 0.7);
        pairedPersons.add(p.name.toLowerCase());
      }
    }
    // person holds a work role but no org nearby → candidate for the page-dominant org
    for (const p of paraPersons.values()) {
      if (pairedPersons.has(p.name.toLowerCase())) continue;
      const roleish = p.relation !== null && WORK_ROLES.test(p.relation);
      const titled = new RegExp(`${p.name}[^.]{0,60}\\b(${TITLES})\\b`, "iu").test(para);
      if (roleish || titled) pageScope.push(p.name);
    }
  }

  // page-dominant org: only when the page is unambiguous about where "work" happens —
  // the org must recur (≥2 mentions); a single stray org mention is not enough evidence
  if (pageScope.length > 0 && orgCount.size > 0) {
    const ranked = [...orgCount.entries()].sort((a, b) => b[1] - a[1]);
    const [domKey, domCount] = ranked[0]!;
    if (domCount >= 2) {
      const dom = orgDisplay.get(domKey)!;
      for (const person of pageScope) addWork(person, dom, 0.6);
    }
  }

  return {
    mentions: [
      ...[...knownPeople.keys()].map((id) => ({ type: "person" as const, id })),
      ...[...knownOrgs.keys()].map((id) => ({ type: "org" as const, id })),
    ],
    people,
    orgs: [...orgDisplay.values()],
    worksAt,
  };
}

// ---------------------------------------------------------------- DB application

// "Tomasz" later seen as "Tomasz Wójcik" (or vice versa) must not fork into two people:
// exact alias match first, then unique-first-name match, upgrading the canonical name
// when the new form is fuller.
async function resolveOrCreatePerson(name: string): Promise<{ id: string; created: boolean }> {
  const exact = await resolvePerson(name);
  if (exact) return { id: exact.id, created: false };
  const tokens = name.split(/\s+/);
  if (tokens.length === 1) {
    const matches = await peopleByFirstName(tokens[0]!);
    if (matches.length === 1) {
      await addAlias(matches[0]!.id, name);
      return { id: matches[0]!.id, created: false };
    }
  } else {
    const short = await resolvePerson(tokens[0]!);
    if (short && short.canonical_name.toLowerCase() === tokens[0]!.toLowerCase()) {
      await setPersonCanonicalName(short.id, name);
      await addAlias(short.id, name);
      return { id: short.id, created: false };
    }
  }
  const { id } = await ensurePerson(name, ACTOR, "extract");
  return { id, created: true };
}

// "Fjordsonics" / "Fjordsonics AS" are one org: match on the legal-suffix-stripped base
// name via aliases, preferring the suffixed form as canonical.
async function resolveOrCreateOrg(name: string): Promise<{ id: string; created: boolean }> {
  const exact = await resolveOrg(name);
  if (exact) return { id: exact.id, created: false };
  const base = name.replace(LEGAL_SUFFIX, "");
  if (base !== name) {
    const baseHit = await resolveOrg(base);
    if (baseHit) {
      await setOrgCanonicalName(baseHit.id, name);
      await addOrgAlias(baseHit.id, name);
      return { id: baseHit.id, created: false };
    }
  }
  const { id, created } = await ensureOrg(name, ACTOR);
  if (base !== name) await addOrgAlias(id, base);
  return { id, created };
}

export interface ExtractStats {
  edges: number;
  people: number;
  orgs: number;
}

export async function extractAndLink(
  parentType: string,
  parentId: string,
  text: string,
): Promise<ExtractStats> {
  const lexicon = { people: await allPeopleWithAliases(), orgs: await allOrgsWithAliases() };
  const facts = extractFacts(text, lexicon);
  const stats: ExtractStats = { edges: 0, people: 0, orgs: 0 };
  const srcTable = parentTable(parentType).table;

  const personIds = new Map<string, string>();
  for (const p of facts.people) {
    const { id, created } = await resolveOrCreatePerson(p.name);
    personIds.set(p.name.toLowerCase(), id);
    if (created) stats.people++;
    // manager is both a work-role and an owner-relation; other work-roles are not relations
    if (p.relation && (p.relation === "manager" || !WORK_ROLES.test(p.relation)))
      await setPersonRelationIfNull(id, p.relation);
  }
  const orgIds = new Map<string, string>();
  for (const o of facts.orgs) {
    const { id, created } = await resolveOrCreateOrg(o);
    orgIds.set(o.toLowerCase(), id);
    if (created) stats.orgs++;
  }

  const mentionRefs: EntityRef[] = [
    ...facts.mentions,
    ...[...personIds.values()].map((id) => ({ type: "person" as const, id })),
    ...[...orgIds.values()].map((id) => ({ type: "org" as const, id })),
  ];
  const seen = new Set<string>();
  for (const ref of mentionRefs) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await edgeExists(parentType, parentId, "mentions", ref.type, ref.id)) continue;
    await insertEdge({
      srcType: parentType,
      srcId: parentId,
      rel: "mentions",
      dstType: ref.type,
      dstId: ref.id,
      sourceTable: srcTable,
      sourceId: parentId,
      extractedBy: ACTOR,
      confidence: 0.8,
    });
    stats.edges++;
  }

  for (const w of facts.worksAt) {
    const personId = personIds.get(w.person.toLowerCase()) ?? (await resolvePerson(w.person))?.id;
    const orgId = orgIds.get(w.org.toLowerCase()) ?? (await resolveOrg(w.org))?.id;
    if (!personId || !orgId) continue;
    if (await edgeExists("person", personId, "works_at", "org", orgId)) continue;
    await insertEdge({
      srcType: "person",
      srcId: personId,
      rel: "works_at",
      dstType: "org",
      dstId: orgId,
      sourceTable: srcTable,
      sourceId: parentId,
      extractedBy: ACTOR,
      confidence: w.confidence,
    });
    stats.edges++;
  }
  return stats;
}
