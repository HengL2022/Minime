// The ONLY place application SQL runs (spec §14). Every content read applies the tier
// predicate `tier <= allowedTier()`. Tier-0 tables (transactions, health_samples) have no
// content-read functions at all — they are reachable only via metric_agg() (I3).
// Everything is parameterized; string-interpolated SQL is a review-blocker.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cjkFold, isCjkStopToken } from "../util/cjk";
import { localDateStr, now } from "../util/clock";
import { config } from "../util/config";
import { sql } from "./client";

export type ParentType =
  | "page"
  | "journal"
  | "interaction"
  | "decision"
  | "decision_branch"
  | "task"
  | "goal"
  | "value"
  | "principle"
  | "person"
  | "org"
  | "commitment";

// parent_type -> table + which column serves as a human title. Fixed map, not user input.
const PARENTS: Record<ParentType, { table: string; titleCol: string }> = {
  page: { table: "pages", titleCol: "title" },
  journal: { table: "journal_entries", titleCol: "entry_md" },
  interaction: { table: "interactions", titleCol: "summary" },
  decision: { table: "decisions", titleCol: "question" },
  decision_branch: { table: "decision_branches", titleCol: "label" },
  task: { table: "tasks", titleCol: "title" },
  goal: { table: "goals", titleCol: "statement" },
  value: { table: "values_items", titleCol: "statement" },
  principle: { table: "principles", titleCol: "rule" },
  person: { table: "people", titleCol: "canonical_name" },
  org: { table: "orgs", titleCol: "canonical_name" },
  commitment: { table: "commitments", titleCol: "what" },
};

export function parentTable(type: string): { table: string; titleCol: string } {
  const p = PARENTS[type as ParentType];
  if (!p) throw new Error(`unknown parent type: ${type}`);
  return p;
}

// ---------------------------------------------------------------- tiers & audit

export type AccessActor = string | null | undefined;

export async function allowedTier(actor?: AccessActor): Promise<1 | 2> {
  const rows = actor
    ? await sql`
        select 1 from session_unlocks
        where scope = 'tier2' and granted_via = ${actor} and expires_at > ${now()}
        limit 1`
    : await sql`
        select 1 from session_unlocks where scope = 'tier2' and expires_at > ${now()} limit 1`;
  return rows.length > 0 ? 2 : 1;
}

export async function insertUnlock(
  minutes: number,
  via: string,
): Promise<{ id: string; expires_at: Date }> {
  const expires = new Date(now().getTime() + minutes * 60_000);
  const [row] = await sql`
    insert into session_unlocks (scope, granted_at, expires_at, granted_via)
    values ('tier2', ${now()}, ${expires}, ${via})
    returning id, expires_at`;
  return row as any;
}

export async function logEvent(e: {
  actor: string;
  verb: string;
  entityType?: string;
  entityId?: string;
  payload?: unknown;
}): Promise<void> {
  await sql`
    insert into events (at, actor, verb, entity_type, entity_id, payload)
    values (${now()}, ${e.actor}, ${e.verb}, ${e.entityType ?? null}, ${e.entityId ?? null},
            ${sql.json((e.payload as any) ?? {})})`;
}

export async function eventsSince(since: Date): Promise<any[]> {
  return sql`select id, at, actor, verb, entity_type, entity_id, payload
             from events where at >= ${since} order by at desc`;
}

// ---------------------------------------------------------------- chunks & search

export async function replaceChunks(
  parentType: ParentType,
  parentId: string,
  texts: string[],
  tier: number,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from chunks where parent_type = ${parentType} and parent_id = ${parentId}`;
    for (let ord = 0; ord < texts.length; ord++) {
      await tx`insert into chunks (parent_type, parent_id, ord, text, tier)
               values (${parentType}, ${parentId}, ${ord}, ${texts[ord]!}, ${tier})`;
    }
  });
}

export async function chunksMissingEmbedding(
  limit: number,
  maxTier = 2, // cloud embed providers pass CLOUD_MAX_TIER; local providers see everything
): Promise<{ id: string; text: string }[]> {
  return sql`select id, text from chunks where embedding is null and tier <= ${maxTier}
             order by updated_at limit ${limit}` as any;
}

export async function setChunkEmbedding(
  id: string,
  vector: number[],
  model: string,
): Promise<void> {
  await sql`update chunks set embedding = ${JSON.stringify(vector)}::vector, embed_model = ${model}
            where id = ${id}`;
}

export async function countChunksMissingEmbedding(): Promise<number> {
  const [r] = await sql`select count(*)::int as n from chunks where embedding is null`;
  return r!.n;
}

// Vectors from different models live in different spaces and must never be compared.
// Switching EMBED_PROVIDER/model therefore wipes everything for a clean re-embed.
export async function clearEmbeddings(): Promise<number> {
  const rows = await sql`update chunks set embedding = null, embed_model = null
                         where embedding is not null returning id`;
  return rows.length;
}

export async function embedModelsInUse(): Promise<string[]> {
  const rows = await sql`select distinct embed_model from chunks where embed_model is not null`;
  return rows.map((r: any) => r.embed_model);
}

export interface Candidate {
  id: string;
  parent_type: ParentType;
  parent_id: string;
  ord: number;
  text: string;
  cosine: number;
  fts: number;
}

export async function ftsCandidates(
  query: string,
  types: string[] | null,
  parentIds: string[] | null = null, // optional scope: restrict to these parent rows
  actor?: AccessActor,
): Promise<Candidate[]> {
  const allowed = await allowedTier(actor);
  // OR the query words: plainto_tsquery ANDs every term, so a natural-language question
  // matched nothing whenever one contentful word was absent from a chunk — on a 100-question
  // retrieval eval, 70% of queries got zero fts candidates, silencing the 0.30 fts weight in
  // hybrid scoring. ts_rank_cd still ranks chunks matching more terms first (DECISIONS.md
  // 2026-06-11). cjkFold mirrors the index-side cjk_fold() so Chinese queries hit the
  // bigram lexemes (009_cjk_fts.sql).
  const orQuery = cjkFold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .filter((t) => !isCjkStopToken(t))
    .join(" OR ");
  return sql`
    select c.id, c.parent_type, c.parent_id, c.ord, c.text,
           0::float as cosine,
           ts_rank_cd(c.tsv, websearch_to_tsquery('english', ${orQuery}))::float as fts
    from chunks c
    where c.tier <= ${allowed}
      and c.tsv @@ websearch_to_tsquery('english', ${orQuery})
      and (${types === null} or c.parent_type = any(${types ?? []}))
      and (${parentIds === null} or c.parent_id = any(${parentIds ?? []}))
    order by fts desc
    limit 50` as any;
}

export async function vectorCandidates(
  embedding: number[],
  types: string[] | null,
  parentIds: string[] | null = null, // optional scope: restrict to these parent rows
  actor?: AccessActor,
): Promise<Candidate[]> {
  const allowed = await allowedTier(actor);
  const vec = JSON.stringify(embedding);
  return sql`
    select c.id, c.parent_type, c.parent_id, c.ord, c.text,
           (1 - (c.embedding <=> ${vec}::vector))::float as cosine,
           0::float as fts
    from chunks c
    where c.tier <= ${allowed} and c.embedding is not null
      and (${types === null} or c.parent_type = any(${types ?? []}))
      and (${parentIds === null} or c.parent_id = any(${parentIds ?? []}))
    order by c.embedding <=> ${vec}::vector
    limit 50` as any;
}

export interface ParentMeta {
  id: string;
  title: string;
  updated_at: Date;
  created_by: string;
  derived_from: string | null;
  source: string;
}

export async function parentMeta(
  type: ParentType,
  ids: string[],
  actor?: AccessActor,
): Promise<Map<string, ParentMeta>> {
  if (ids.length === 0) return new Map();
  const allowed = await allowedTier(actor);
  const { table, titleCol } = parentTable(type);
  // table/titleCol come from the fixed PARENTS map above, never from user input.
  const rows = await sql`
    select id, left(${sql(titleCol)}::text, 120) as title, updated_at, created_by, derived_from,
           source
    from ${sql(table)}
    where id = any(${ids}) and tier <= ${allowed}`;
  return new Map(rows.map((r: any) => [r.id as string, r as ParentMeta]));
}

// People/orgs literally named in the query, for the 1-hop graph boost (spec §9).
export interface EntityRef {
  type: "person" | "org";
  id: string;
}

export async function entitiesNamedIn(query: string, actor?: AccessActor): Promise<EntityRef[]> {
  const allowed = await allowedTier(actor);
  const q = query.toLowerCase();
  const people = await sql`
    select distinct p.id from people p
    left join person_aliases a on a.person_id = p.id
    where (${q} like '%' || lower(p.canonical_name) || '%'
       or (a.alias is not null and ${q} like '%' || lower(a.alias) || '%'))
      and p.tier <= ${allowed}`;
  const orgs = await sql`
    select distinct o.id from orgs o
    left join org_aliases a on a.org_id = o.id
    where (${q} like '%' || lower(o.canonical_name) || '%'
       or (a.alias is not null and ${q} like '%' || lower(a.alias) || '%'))
      and o.tier <= ${allowed}`;
  return [
    ...people.map((r: any) => ({ type: "person" as const, id: r.id })),
    ...orgs.map((r: any) => ({ type: "org" as const, id: r.id })),
  ];
}

export async function oneHopNeighbors(
  refs: EntityRef[],
  actor?: AccessActor,
): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const allowed = await allowedTier(actor);
  const set = new Set<string>();
  for (const type of ["person", "org"] as const) {
    const ids = refs.filter((r) => r.type === type).map((r) => r.id);
    if (ids.length === 0) continue;
    const rows = await sql`
      select src_type as t, src_id as i from edges where dst_type = ${type} and dst_id = any(${ids})
        and tier <= ${allowed}
      union
      select dst_type as t, dst_id as i from edges where src_type = ${type} and src_id = any(${ids})
        and tier <= ${allowed}`;
    for (const r of rows as any[]) set.add(`${r.t}:${r.i}`);
    for (const id of ids) set.add(`${type}:${id}`);
  }
  return set;
}

// Access-frequency signal for ranking (DECISIONS.md 2026-06-12). Counts how often each
// parent id was the PRIMARY row returned by minime_get_context — a deliberate drill-in,
// unlike search hits, so the boost cannot feed back into itself. Only returned_ids[0]
// counts: a dossier's ~20 related rows ride along in the envelope without being asked
// for (invariant-review 2026-06-12). Read off the append-only audit log (I8): ids only,
// never content. The partial index in 011_access_index.sql covers this scan.
export async function accessCounts(
  ids: string[],
  sinceDays: number,
  actor?: AccessActor,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const since = new Date(now().getTime() - sinceDays * 86_400_000);
  const rows = await sql`
    select payload->'returned_ids'->>0 as id, count(*)::int as n
    from events
    where verb = 'tool:minime_get_context'
      and at >= ${since}
      and (${!actor} or actor = ${actor ?? ""})
      and payload->'returned_ids'->>0 = any(${ids})
    group by 1`;
  return new Map(rows.map((r: any) => [r.id as string, r.n as number]));
}

// ---------------------------------------------------------------- people

export async function resolvePerson(name: string, actor?: AccessActor): Promise<any | null> {
  const allowed = await allowedTier(actor);
  const rows = await sql`
    select distinct p.* from people p
    left join person_aliases a on a.person_id = p.id
    where (lower(p.canonical_name) = lower(${name}) or lower(a.alias) = lower(${name}))
      and p.tier <= ${allowed}
    limit 1`;
  return rows[0] ?? null;
}

// Internal by-id lookup for the extractor's works_at guard. NOT tier-gated: the system
// extractor (system:extract) needs the stored relation of a person it just resolved to
// decide whether a works_at edge is legitimate. Returns only structural fields, never
// tier-2 free text. Do not expose through MCP tools.
export async function personById(
  id: string,
): Promise<{ id: string; canonical_name: string; relation: string | null } | null> {
  const rows = await sql`
    select id, canonical_name, relation from people where id = ${id} limit 1`;
  return (rows[0] as any) ?? null;
}

export async function ensurePerson(
  name: string,
  createdBy: string,
  source = "capture",
): Promise<{ id: string; created: boolean }> {
  const existing = await resolvePerson(name);
  if (existing) return { id: existing.id, created: false };
  const [row] = await sql`
    insert into people (canonical_name, created_by, source)
    values (${name}, ${createdBy}, ${source}) returning id`;
  await sql`insert into person_aliases (person_id, alias) values (${row!.id}, ${name})
            on conflict do nothing`;
  return { id: row!.id, created: true };
}

// Owner-relation + free-text context (onboarding interview); never blanks existing values.
export async function setPersonDetails(
  id: string,
  relation: string | null,
  context: string | null,
): Promise<void> {
  await sql`update people set relation = coalesce(${relation}, relation),
                              context = coalesce(${context}, context)
            where id = ${id}`;
}

export async function addAlias(personId: string, alias: string): Promise<void> {
  await sql`insert into person_aliases (person_id, alias) values (${personId}, ${alias})
            on conflict do nothing`;
}

export async function touchLastContact(personId: string, at: Date): Promise<void> {
  await sql`update people set last_contact_at = greatest(coalesce(last_contact_at, ${at}), ${at})
            where id = ${personId}`;
}

// Owner-relation ("my physiotherapist") detected by extraction: fill only if empty —
// a human-set relation is never overwritten by a rule.
export async function setPersonRelationIfNull(personId: string, relation: string): Promise<void> {
  await sql`update people set relation = ${relation} where id = ${personId} and relation is null`;
}

// Extraction may upgrade "Tomasz" to "Tomasz Wójcik" once the fuller form is seen.
export async function setPersonCanonicalName(personId: string, name: string): Promise<void> {
  await sql`update people set canonical_name = ${name} where id = ${personId}`;
}

export async function peopleByFirstName(first: string): Promise<{ id: string }[]> {
  return sql`
    select id from people
    where lower(split_part(canonical_name, ' ', 1)) = ${first.toLowerCase()}` as any;
}

// ---------------------------------------------------------------- orgs

export async function resolveOrg(name: string, actor?: AccessActor): Promise<any | null> {
  const allowed = await allowedTier(actor);
  const rows = await sql`
    select distinct o.* from orgs o
    left join org_aliases a on a.org_id = o.id
    where (lower(o.canonical_name) = lower(${name}) or lower(a.alias) = lower(${name}))
      and o.tier <= ${allowed}
      and o.retired_at is null
    limit 1`;
  return rows[0] ?? null;
}

export async function ensureOrg(
  name: string,
  createdBy: string,
  source = "extract",
): Promise<{ id: string; created: boolean }> {
  const existing = await resolveOrg(name);
  if (existing) return { id: existing.id, created: false };
  const [row] = await sql`
    insert into orgs (canonical_name, created_by, source)
    values (${name}, ${createdBy}, ${source}) returning id`;
  await sql`insert into org_aliases (org_id, alias) values (${row!.id}, ${name})
            on conflict do nothing`;
  return { id: row!.id, created: true };
}

export async function addOrgAlias(orgId: string, alias: string): Promise<void> {
  await sql`insert into org_aliases (org_id, alias) values (${orgId}, ${alias})
            on conflict do nothing`;
}

export async function setOrgCanonicalName(orgId: string, name: string): Promise<void> {
  await sql`update orgs set canonical_name = ${name} where id = ${orgId}`;
}

export async function allOrgsWithAliases(): Promise<{ id: string; names: string[] }[]> {
  const rows = await sql`
    select o.id, array_agg(distinct x.name) as names
    from orgs o
    cross join lateral (
      select o.canonical_name as name
      union select a.alias from org_aliases a where a.org_id = o.id
    ) x
    group by o.id`;
  return rows.map((r: any) => ({ id: r.id, names: r.names }));
}

// ---------------------------------------------------------------- entity retype / supersede
//
// Sanctioned, reversible repair for a mis-typed entity: the relation extractor sometimes
// mints an `org` row for what is really a person (e.g. a boss first seen only inside a task
// title — "Hai Yan"). There is no classifier path that retypes an existing wrong row, so
// this is the one authorized place that converts org → person. It:
//   1. reuses an existing person of the same name, else creates one (carrying org aliases),
//   2. repoints every edge that referenced the org (src or dst) to the person, dropping
//      self-referential edges and de-duping any edge that now collides,
//   3. retires (does NOT delete) the org row and records the supersession pointer on the
//      person, so the change is auditable and reversible from the backup.
export async function retypeOrgToPerson(
  orgId: string,
  opts: { relation?: string | null; reason?: string } = {},
): Promise<{ personId: string; orgId: string; created: boolean; edgesRepointed: number }> {
  const [org] = await sql`select id, canonical_name from orgs where id = ${orgId}`;
  if (!org) throw new Error(`org not found: ${orgId}`);
  const name = org.canonical_name as string;

  return sql.begin(async (tx) => {
    // 1. resolve-or-create the person (no tier predicate here — admin repair path)
    const [existingPerson] = await tx`
      select p.id from people p
      left join person_aliases a on a.person_id = p.id
      where lower(p.canonical_name) = lower(${name}) or lower(a.alias) = lower(${name})
      limit 1`;
    let personId: string;
    let created = false;
    if (existingPerson) {
      personId = existingPerson.id as string;
    } else {
      const [row] = await tx`
        insert into people (canonical_name, created_by, source, supersedes_id)
        values (${name}, 'agent:retype', 'retype', ${orgId}) returning id`;
      personId = row!.id as string;
      created = true;
    }
    if (opts.relation) {
      await tx`update people set relation = coalesce(relation, ${opts.relation}) where id = ${personId}`;
    }
    if (!created) {
      await tx`update people set supersedes_id = coalesce(supersedes_id, ${orgId}) where id = ${personId}`;
    }

    // 2. carry over the org's aliases (canonical + alias rows) to the person
    await tx`insert into person_aliases (person_id, alias)
             values (${personId}, ${name}) on conflict do nothing`;
    await tx`insert into person_aliases (person_id, alias)
             select ${personId}, a.alias from org_aliases a where a.org_id = ${orgId}
             on conflict do nothing`;

    // 3. repoint edges org→person on both sides
    await tx`update edges set src_type = 'person', src_id = ${personId}
             where src_type = 'org' and src_id = ${orgId}`;
    await tx`update edges set dst_type = 'person', dst_id = ${personId}
             where dst_type = 'org' and dst_id = ${orgId}`;
    // drop self-referential edges created by the repoint (e.g. "X works_at X")
    await tx`delete from edges where src_id = ${personId} and dst_id = ${personId}
             and src_type = 'person' and dst_type = 'person'`;
    // de-dupe edges that now collide (keep the oldest by created_at, then id)
    await tx`
      delete from edges e using edges k
      where e.src_type = k.src_type and e.src_id = k.src_id and e.rel = k.rel
        and e.dst_type = k.dst_type and e.dst_id = k.dst_id
        and (e.created_at, e.id) > (k.created_at, k.id)
        and (e.src_id = ${personId} or e.dst_id = ${personId})`;
    const cntRows = await tx`
      select count(*)::int n from edges where src_id = ${personId} or dst_id = ${personId}`;
    const edgesRepointed = ((cntRows[0] as any)?.n ?? 0) as number;

    // 4. retire (keep) the org row — never hard-delete
    await tx`update orgs set retired_at = now(), retired_reason = ${opts.reason ?? "retyped to person"}
             where id = ${orgId}`;

    return { personId, orgId, created, edgesRepointed: edgesRepointed as number };
  });
}

// Read-only DB-wide screen for the mis-typed-entity class. Flags (never auto-fixes):
//   - org_should_be_person: an extractor-minted org whose name has no org cue and is
//     referenced by a person-relation context (a 2-token capitalized personal name).
//   - person_from_pronoun: a person row whose name is a bare pronoun (She/He/They/...).
// Conservative by design: only `system:extract` rows are candidates, never human-confirmed.
//
// Two false-positive filters keep real orgs that merely LOOK like a personal name
// ("Kiddie Winkie", "Johns Hopkins") off the screen:
//   1. workplace signal (automatic): an org that is the `works_at` destination of >= 2
//      DISTINCT people is a real multi-person workplace — a person is never that. This
//      excludes "Kiddie Winkie" (3 employees) with zero curation.
//   2. owner allow-list (curated): names listed in $MINIME_DATA_DIR/known-orgs.txt are
//      never flagged. For the irreducible semantic cases — a single-employee institution
//      like "Johns Hopkins" is structurally identical to a mistyped person ("Bert
//      Vogelstein"), so only a human can disambiguate. Mirrors the non-org-terms.txt
//      convention used by the extractor. Matched case-folded and EXACT.
export async function detectMistypedEntities(): Promise<
  {
    kind: "org_should_be_person" | "person_from_pronoun";
    type: "org" | "person";
    id: string;
    name: string;
    edges: number;
  }[]
> {
  const PRONOUNS = ["he", "she", "they", "him", "her", "them", "it", "we", "you", "i"];
  const knownOrgs = loadKnownOrgs(); // owner allow-list, case-folded exact names
  // orgs that look like a personal name: 2–3 capitalized tokens ("First Last"), no corp/
  // place suffix, extractor-minted and not retired. Single-token names are deliberately
  // excluded — they are ambiguous brand-vs-surname (e.g. "Vazyme", "Fapon") and produce
  // false positives on a review screen. The `>= 2 distinct works_at people` workplace
  // signal is applied below in JS (per-org distinct count) so the rule stays readable.
  const orgs = await sql`
    select o.id, o.canonical_name as name,
           (select count(*)::int from edges e where e.src_id = o.id or e.dst_id = o.id) as edges,
           (select count(distinct e.src_id)::int from edges e
              where e.dst_id = o.id and e.dst_type = 'org'
                and e.rel = 'works_at' and e.src_type = 'person') as employees
    from orgs o
    where o.created_by = 'system:extract' and o.retired_at is null
      and o.canonical_name ~ '^[[:upper:]][[:alpha:]]+( [[:upper:]][[:alpha:]]+){1,2}$'
      and o.canonical_name !~* '(inc|ltd|llc|corp|gmbh|company|university|institute|hospital|clinic|school|lab|biotech|tech|health|pharma|group|center|centre|systems|solutions|holdings|astar)'`;
  const flaggedOrgs = orgs.filter(
    (r: any) => r.employees < 2 && !knownOrgs.has(String(r.name).toLowerCase()),
  );
  const people = await sql`
    select p.id, p.canonical_name as name,
           (select count(*)::int from edges e where e.src_id = p.id or e.dst_id = p.id) as edges
    from people p
    where p.created_by = 'system:extract'
      and lower(p.canonical_name) = any(${PRONOUNS})`;
  return [
    ...flaggedOrgs.map((r: any) => ({
      kind: "org_should_be_person" as const,
      type: "org" as const,
      id: r.id,
      name: r.name,
      edges: r.edges,
    })),
    ...people.map((r: any) => ({
      kind: "person_from_pronoun" as const,
      type: "person" as const,
      id: r.id,
      name: r.name,
      edges: r.edges,
    })),
  ];
}

// Owner-editable allow-list of names that are genuinely orgs even though they look like a
// personal name ("Johns Hopkins", "Morgan Stanley"). Loaded from
// $MINIME_DATA_DIR/known-orgs.txt; missing/unreadable file = empty set (filter inactive).
// Case-folded, EXACT match, '#' comments and blank lines ignored. Memoized.
let knownOrgsCache: Set<string> | null = null;
export function parseKnownOrgs(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.add(line.toLowerCase());
  }
  return out;
}
function loadKnownOrgs(): Set<string> {
  if (knownOrgsCache) return knownOrgsCache;
  try {
    const path = join(config.dataDir, "known-orgs.txt");
    knownOrgsCache = existsSync(path) ? parseKnownOrgs(readFileSync(path, "utf8")) : new Set();
  } catch {
    knownOrgsCache = new Set();
  }
  return knownOrgsCache;
}

interface Std {
  createdBy?: string;
  source?: string;
  derivedFrom?: string | null;
  tier?: number;
}

function decisionTier(tier?: number): 1 | 2 {
  if (tier === undefined) return 1;
  if (tier === 1 || tier === 2) return tier;
  throw new Error("decision tier must be 1 or 2");
}

type DecisionTranscriptInput = {
  questionKey: string;
  prompt: string;
  answer: string;
  at?: Date | null;
};

type DecisionBranchInput = {
  label: string;
  status?: "chosen" | "rejected" | "considered";
  note?: string | null;
  wouldBeRightIf?: string | null;
};

export async function insertJournal(
  e: {
    entryMd: string;
    mood?: number | null;
    energy?: number | null;
    at?: Date;
  } & Std,
): Promise<{ id: string }> {
  const [row] = await sql`
    insert into journal_entries (at, entry_md, mood, energy, created_by, source, derived_from, tier)
    values (${e.at ?? now()}, ${e.entryMd}, ${e.mood ?? null}, ${e.energy ?? null},
            ${e.createdBy ?? "human"}, ${e.source ?? "manual"}, ${e.derivedFrom ?? null}, ${e.tier ?? 2})
    returning id`;
  return row as any;
}

export async function insertDecision(
  d: {
    question: string;
    options: unknown;
    criteria?: unknown;
    choice?: string | null;
    reasoning?: string | null;
    expectedOutcome?: string | null;
    falsifier?: string | null;
    stakes?: string | null;
    reversibility?: string | null;
    confidence?: number | null;
    reviewAt?: string | null;
    decidedAt?: Date | null;
    transcript?: DecisionTranscriptInput[];
    branches?: DecisionBranchInput[];
  } & Std,
): Promise<{ id: string; branchIds: string[] }> {
  const branchIds: string[] = [];
  const decisionId = crypto.randomUUID();
  const tier = decisionTier(d.tier);
  await sql.begin(async (tx) => {
    await tx`
      insert into decisions (id, question, options, criteria, choice, reasoning, expected_outcome,
                             falsifier, stakes, reversibility, confidence,
                             decided_at, review_at, created_by, source, derived_from, tier)
      values (${decisionId}, ${d.question}, ${sql.json(d.options as any)}, ${d.criteria ? sql.json(d.criteria as any) : null},
              ${d.choice ?? null}, ${d.reasoning ?? null}, ${d.expectedOutcome ?? null},
              ${d.falsifier ?? null}, ${d.stakes ?? null}, ${d.reversibility ?? null},
              ${d.confidence ?? null},
              ${d.decidedAt ?? (d.choice ? now() : null)}, ${d.reviewAt ?? null},
              ${d.createdBy ?? "human"}, ${d.source ?? "manual"}, ${d.derivedFrom ?? null}, ${tier})`;

    await insertDecisionTranscriptRows(tx, decisionId, d.transcript ?? [], { ...d, tier });
    branchIds.push(...(await insertDecisionBranchRows(tx, decisionId, { ...d, tier })));
  });
  return { id: decisionId, branchIds };
}

async function insertDecisionTranscriptRows(
  tx: any,
  decisionId: string,
  transcript: DecisionTranscriptInput[],
  std: Std,
): Promise<void> {
  for (let i = 0; i < transcript.length; i++) {
    const turn = transcript[i]!;
    await tx`
      insert into decision_transcripts
        (decision_id, ord, question_key, prompt, answer, at, created_by, source, derived_from, tier)
      values (${decisionId}, ${i + 1}, ${turn.questionKey}, ${turn.prompt}, ${turn.answer},
              ${turn.at ?? now()}, ${std.createdBy ?? "human"}, ${std.source ?? "manual"},
              ${std.derivedFrom ?? null}, ${std.tier ?? 1})`;
  }
}

async function insertDecisionBranchRows(
  tx: any,
  decisionId: string,
  d: { options: unknown; choice?: string | null; branches?: DecisionBranchInput[] } & Std,
): Promise<string[]> {
  const ids: string[] = [];
  const branches = decisionBranchesFrom(d.options, d.choice ?? null, d.branches);
  for (const b of branches) {
    const branchId = crypto.randomUUID();
    await tx`
      insert into decision_branches
        (id, decision_id, label, status, note, would_be_right_if,
         created_by, source, derived_from, tier)
      values (${branchId}, ${decisionId}, ${b.label}, ${b.status}, ${b.note ?? null},
              ${b.wouldBeRightIf ?? null}, ${d.createdBy ?? "human"}, ${d.source ?? "manual"},
              ${d.derivedFrom ?? null}, ${d.tier ?? 1})`;
    ids.push(branchId);
    await tx`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
      values ('decision', ${decisionId}, ${branchRel(b.status)}, 'decision_branch', ${branchId},
              'decision_branches', ${branchId}, ${d.createdBy ?? "human"})`;
  }
  return ids;
}

function decisionBranchesFrom(
  options: unknown,
  choice: string | null,
  explicit?: {
    label: string;
    status?: "chosen" | "rejected" | "considered";
    note?: string | null;
    wouldBeRightIf?: string | null;
  }[],
): {
  label: string;
  status: "chosen" | "rejected" | "considered";
  note?: string | null;
  wouldBeRightIf?: string | null;
}[] {
  if (explicit?.length) {
    return explicit.map((b) => ({
      label: b.label,
      status: b.status ?? (choice && b.label === choice ? "chosen" : "considered"),
      note: b.note ?? null,
      wouldBeRightIf: b.wouldBeRightIf ?? null,
    }));
  }
  if (!Array.isArray(options)) return [];
  return options
    .filter((o): o is string => typeof o === "string" && o.length > 0)
    .map((label) => ({
      label,
      status: choice && label === choice ? ("chosen" as const) : ("considered" as const),
    }));
}

function branchRel(status: "chosen" | "rejected" | "considered"): string {
  if (status === "chosen") return "chose";
  if (status === "rejected") return "rejected";
  return "considered";
}

export async function getDecision(id: string, actor?: AccessActor): Promise<any | null> {
  const allowed = await allowedTier(actor);
  const rows = await sql`select * from decisions where id = ${id} and tier <= ${allowed}`;
  return rows[0] ?? null;
}

export async function getDecisionTranscript(id: string, actor?: AccessActor): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return sql`
    select id, decision_id, ord, question_key, prompt, answer, at, created_at, created_by, source, tier
    from decision_transcripts
    where decision_id = ${id} and tier <= ${allowed}
    order by ord` as any;
}

export async function getDecisionBranches(id: string, actor?: AccessActor): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return sql`
    select id, decision_id, label, status, note, would_be_right_if, created_at, updated_at,
           created_by, source, tier
    from decision_branches
    where decision_id = ${id} and tier <= ${allowed}
    order by created_at, id` as any;
}

export async function decisionBranchesForIndex(id: string): Promise<any[]> {
  return sql`
    select id, decision_id, label, status, note, would_be_right_if, created_at, updated_at,
           created_by, source, tier
    from decision_branches
    where decision_id = ${id}
    order by created_at, id` as any;
}

export async function reviewDecision(
  id: string,
  actualOutcome: string,
  lesson: string | null,
  actor: string,
  outcomeScore?: number | null,
): Promise<{ principleId: string | null }> {
  let principleId: string | null = null;
  await sql.begin(async (tx) => {
    const [dec] = await tx`update decisions
               set actual_outcome = ${actualOutcome}, reviewed_at = ${now()},
                   outcome_score = coalesce(${outcomeScore ?? null}, outcome_score)
                           where id = ${id} returning id`;
    if (!dec) throw new Error("decision not found");
    if (lesson) {
      const [p] = await tx`
        insert into principles (rule, learned_from_decision, created_by, source)
        values (${lesson}, ${id}, ${actor}, 'review') returning id`;
      principleId = p!.id;
      await tx`update decisions set principle_id = ${principleId} where id = ${id}`;
      await tx`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
               values ('principle', ${principleId}, 'learned_from', 'decision', ${id}, 'decisions', ${id}, ${actor})`;
    }
  });
  return { principleId };
}

export async function upsertTask(
  t: {
    id?: string | null;
    title: string;
    body?: string | null;
    status?: string | null;
    due?: string | null;
    goalId?: string | null;
  } & Std,
): Promise<{ id: string }> {
  if (t.id) {
    const [row] = await sql`
      update tasks set title = ${t.title},
                       body = coalesce(${t.body ?? null}, body),
                       status = coalesce(${t.status ?? null}, status),
                       due = coalesce(${t.due ?? null}, due),
                       goal_id = coalesce(${t.goalId ?? null}, goal_id),
                       completed_at = case when ${t.status ?? null} = 'done' then ${now()} else completed_at end
      where id = ${t.id} returning id`;
    if (!row) throw new Error("task not found");
    return row as any;
  }
  const [row] = await sql`
    insert into tasks (title, body, status, due, goal_id, created_by, source, derived_from, tier, completed_at)
    values (${t.title}, ${t.body ?? null}, ${t.status ?? "inbox"}, ${t.due ?? null}, ${t.goalId ?? null},
            ${t.createdBy ?? "human"}, ${t.source ?? "manual"}, ${t.derivedFrom ?? null}, ${t.tier ?? 1},
            ${t.status === "done" ? now() : null})
    returning id`;
  return row as any;
}

export async function insertInteraction(
  i: {
    personId: string;
    kind: string;
    summary: string;
    occurredAt?: Date;
  } & Std,
): Promise<{ id: string }> {
  const at = i.occurredAt ?? now();
  const [row] = await sql`
    insert into interactions (person_id, kind, summary, occurred_at, created_by, source, derived_from, tier)
    values (${i.personId}, ${i.kind}, ${i.summary}, ${at},
            ${i.createdBy ?? "human"}, ${i.source ?? "manual"}, ${i.derivedFrom ?? null}, ${i.tier ?? 2})
    returning id`;
  await touchLastContact(i.personId, at);
  await sql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
            values ('interaction', ${row!.id}, 'involves', 'person', ${i.personId},
                    'interactions', ${row!.id}, ${i.createdBy ?? "human"})`;
  return row as any;
}

export async function insertPrinciple(
  p: { rule: string; domain?: string | null } & Std,
): Promise<{ id: string }> {
  const [row] = await sql`
    insert into principles (rule, domain, created_by, source)
    values (${p.rule}, ${p.domain ?? null}, ${p.createdBy ?? "human"}, ${p.source ?? "manual"})
    returning id`;
  return row as any;
}

export async function insertCommitment(
  c: {
    what: string;
    toWhom: string;
    due?: string | null;
    status?: string;
  } & Std,
): Promise<{ id: string }> {
  const [row] = await sql`
    insert into commitments (what, to_whom, due, status, created_by, source)
    values (${c.what}, ${c.toWhom}, ${c.due ?? null}, ${c.status ?? "open"},
            ${c.createdBy ?? "human"}, ${c.source ?? "manual"})
    returning id`;
  return row as any;
}

export async function insertGoal(
  g: {
    horizon: string;
    statement: string;
    why?: string | null;
    parentId?: string | null;
  } & Std,
): Promise<{ id: string }> {
  const [row] = await sql`
    insert into goals (horizon, statement, why, parent_id, created_by, source)
    values (${g.horizon}, ${g.statement}, ${g.why ?? null}, ${g.parentId ?? null},
            ${g.createdBy ?? "human"}, ${g.source ?? "manual"})
    returning id`;
  return row as any;
}

// Onboarding re-run hint: a non-empty values table means the interview already ran once.
export async function valuesCount(): Promise<number> {
  const [r] = await sql`select count(*)::int as n from values_items`;
  return r!.n;
}

export async function insertValueItem(
  v: { statement: string; priority?: number; notes?: string | null } & Std,
): Promise<{ id: string }> {
  const [row] = await sql`
    insert into values_items (statement, priority, notes, created_by, source)
    values (${v.statement}, ${v.priority ?? 100}, ${v.notes ?? null}, ${v.createdBy ?? "human"}, ${v.source ?? "manual"})
    returning id`;
  return row as any;
}

export async function insertEdge(e: {
  srcType: string;
  srcId: string;
  rel: string;
  dstType: string;
  dstId: string;
  sourceTable?: string | null;
  sourceId?: string | null;
  extractedBy?: string;
  confidence?: number;
}): Promise<void> {
  await sql`
    insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, confidence)
    values (${e.srcType}, ${e.srcId}, ${e.rel}, ${e.dstType}, ${e.dstId},
            ${e.sourceTable ?? null}, ${e.sourceId ?? null}, ${e.extractedBy ?? "human"}, ${e.confidence ?? 1.0})`;
}

export async function deleteExtractedEdgesForSource(
  sourceTable: string,
  sourceId: string,
  extractedBy: string,
): Promise<number> {
  const rows = await sql`
    delete from edges
    where source_table = ${sourceTable} and source_id = ${sourceId} and extracted_by = ${extractedBy}
    returning id`;
  return rows.length;
}

export async function edgeExists(
  srcType: string,
  srcId: string,
  rel: string,
  dstType: string,
  dstId: string,
): Promise<boolean> {
  const rows = await sql`select 1 from edges where src_type = ${srcType} and src_id = ${srcId}
    and rel = ${rel} and dst_type = ${dstType} and dst_id = ${dstId} limit 1`;
  return rows.length > 0;
}

// ---------------------------------------------------------------- pages (brain sync)

export async function upsertPage(
  p: {
    path: string;
    title: string;
    bodyMd: string;
    contentHash: string;
    tier?: number;
  } & Std,
): Promise<{ id: string; changed: boolean }> {
  const [existing] = await sql`select id, content_hash, tier from pages where path = ${p.path}`;
  if (existing && existing.content_hash === p.contentHash) {
    const tier = p.tier ?? 1;
    if (existing.tier !== tier) {
      await sql`
        update pages
        set tier = ${tier}, status = 'active',
            derived_from = coalesce(${p.derivedFrom ?? null}, derived_from)
        where id = ${existing.id}`;
      return { id: existing.id, changed: true };
    }
    await sql`update pages set status = 'active' where id = ${existing.id}`;
    return { id: existing.id, changed: false };
  }
  if (existing) {
    const [row] = await sql`
      update pages set title = ${p.title}, body_md = ${p.bodyMd}, content_hash = ${p.contentHash},
                       tier = ${p.tier ?? 1}, status = 'active',
                       derived_from = coalesce(${p.derivedFrom ?? null}, derived_from)
      where id = ${existing.id} returning id`;
    return { id: row!.id, changed: true };
  }
  const [row] = await sql`
    insert into pages (path, title, body_md, content_hash, tier, created_by, source, derived_from)
    values (${p.path}, ${p.title}, ${p.bodyMd}, ${p.contentHash}, ${p.tier ?? 1},
            ${p.createdBy ?? "human"}, ${p.source ?? "brain-sync"}, ${p.derivedFrom ?? null})
    returning id`;
  return { id: row!.id, changed: true };
}

export async function softDeletePagesNotIn(paths: string[]): Promise<string[]> {
  const rows = await sql`
    update pages set status = 'deleted'
    where status = 'active' and not (path = any(${paths}))
    returning id`;
  return rows.map((r: any) => r.id);
}

export async function listActivePages(actor?: AccessActor): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return sql`select id, path, title, content_hash, tier from pages
             where status = 'active' and tier <= ${allowed}`;
}

// ---------------------------------------------------------------- mirrors (importers write-only)

export async function upsertCalendarEvent(e: {
  uid: string;
  startsAt: Date;
  endsAt?: Date | null;
  title: string;
  location?: string | null;
  attendees?: unknown;
}): Promise<boolean> {
  const rows = await sql`
    insert into calendar_events (uid, starts_at, ends_at, title, location, attendees, created_by, source, tier)
    values (${e.uid}, ${e.startsAt}, ${e.endsAt ?? null}, ${e.title}, ${e.location ?? null},
            ${e.attendees ? sql.json(e.attendees as any) : null}, 'importer:calendar', 'importer:calendar', 1)
    on conflict (uid) do update
      set starts_at = excluded.starts_at, ends_at = excluded.ends_at, title = excluded.title,
          location = excluded.location, attendees = excluded.attendees
    returning (xmax = 0) as inserted`;
  return Boolean(rows[0]?.inserted);
}

export async function insertTransaction(t: {
  occurredAt: string;
  amountCents: bigint | number;
  currency: string;
  merchant?: string | null;
  category?: string | null;
  accountLabel: string;
  externalRef: string;
}): Promise<boolean> {
  const rows = await sql`
    insert into transactions (occurred_at, amount_cents, currency, merchant, category,
                              account_label, external_ref, created_by, source, tier)
    values (${t.occurredAt}, ${String(t.amountCents)}::bigint, ${t.currency}, ${t.merchant ?? null}, ${t.category ?? null},
            ${t.accountLabel}, ${t.externalRef}, 'importer:transactions', 'importer:transactions', 0)
    on conflict (account_label, external_ref) do nothing
    returning id`;
  return rows.length > 0;
}

export async function insertHealthSample(h: {
  kind: string;
  at: Date;
  value: number;
  unit: string;
  source?: string;
}): Promise<boolean> {
  const rows = await sql`
    insert into health_samples (kind, at, value, unit, created_by, source, tier)
    values (${h.kind}, ${h.at}, ${h.value}, ${h.unit}, 'importer:health', ${h.source ?? "importer:health"}, 0)
    on conflict (kind, at, source) do nothing
    returning id`;
  return rows.length > 0;
}

export async function upsertEmailMeta(m: {
  messageId: string;
  at: Date;
  fromAddr: string;
  subject?: string | null;
  threadId?: string | null;
}): Promise<boolean> {
  const rows = await sql`
    insert into email_meta (message_id, at, from_addr, subject, thread_id, created_by, source, tier)
    values (${m.messageId}, ${m.at}, ${m.fromAddr}, ${m.subject ?? null}, ${m.threadId ?? null},
            'importer:email-meta', 'importer:email-meta', 2)
    on conflict (message_id) do nothing
    returning id`;
  return rows.length > 0;
}

// counts for importer idempotency checks; counts are not content.
export async function tableCount(
  table: "calendar_events" | "transactions" | "health_samples" | "email_meta",
): Promise<number> {
  const [r] = await sql`select count(*)::int as n from ${sql(table)}`;
  return r!.n;
}

// ---------------------------------------------------------------- inbox & review queue

export async function insertInboxItem(
  i: { rawPath: string; mime?: string | null } & Std,
): Promise<{ id: string }> {
  const [row] = await sql`
    insert into inbox_items (raw_path, mime, created_by, source, tier)
    values (${i.rawPath}, ${i.mime ?? "text/plain"}, ${i.createdBy ?? "human"}, ${i.source ?? "capture"}, 1)
    returning id`;
  return row as any;
}

export async function getInboxItem(id: string): Promise<any | null> {
  const rows = await sql`select * from inbox_items where id = ${id}`;
  return rows[0] ?? null;
}

export async function findInboxByPath(rawPath: string): Promise<any | null> {
  const rows =
    await sql`select * from inbox_items where raw_path = ${rawPath} order by received_at desc limit 1`;
  return rows[0] ?? null;
}

export async function pendingInboxItems(): Promise<any[]> {
  return sql`select * from inbox_items where status = 'pending' order by received_at`;
}

export async function setInboxFiled(
  id: string,
  filedTable: string,
  filedId: string,
  classifierOutput: unknown,
): Promise<void> {
  await sql`update inbox_items set status = 'filed', filed_table = ${filedTable},
            filed_id = ${filedId}, classifier_output = ${sql.json(classifierOutput as any)}
            where id = ${id}`;
}

export async function setInboxPending(id: string, classifierOutput: unknown): Promise<void> {
  await sql`update inbox_items set classifier_output = ${sql.json(classifierOutput as any)} where id = ${id}`;
}

// Mark an inbox row unfileable. Used for orphans whose raw_path no longer exists on this
// host (e.g. rows synced from another machine — macOS /Users/... paths — whose source text
// never landed here). Records the reason in classifier_output so the drop is auditable and
// the row is never retried by drainStartup again.
export async function setInboxRejected(id: string, reason: string): Promise<void> {
  await sql`update inbox_items set status = 'rejected',
            classifier_output = ${sql.json({ rejected: true, reason } as any)}
            where id = ${id}`;
}

export async function insertReviewItem(kind: string, payload: unknown): Promise<{ id: string }> {
  const [row] = await sql`
    insert into review_queue (kind, payload) values (${kind}, ${sql.json(payload as any)}) returning id`;
  return row as any;
}

export async function openReviewItems(kind?: string): Promise<any[]> {
  return sql`select * from review_queue where status = 'open'
             and (${kind === undefined} or kind = ${kind ?? null}) order by created_at`;
}

export async function resolveReviewItem(
  id: string,
  status: "resolved" | "dismissed",
): Promise<void> {
  await sql`update review_queue set status = ${status}, resolved_at = ${now()} where id = ${id}`;
}

// ---------------------------------------------------------------- state snapshot

export async function stateSnapshot(actor?: AccessActor, timeZone?: string): Promise<any> {
  const t = now();
  // Anchor "today" on the LOCAL calendar day, computed in app code. Casting the
  // UTC instant inside Postgres (${t}::date) uses the DB session TZ (UTC here),
  // which truncates to YESTERDAY whenever local time is past midnight but UTC
  // hasn't rolled over yet — e.g. the 7am Asia/Singapore morning brief = 23:00
  // UTC prior day. Passing a local YYYY-MM-DD string makes the day boundary
  // correct regardless of DB session TZ or time of day. See DECISIONS.md.
  const today = localDateStr(t, timeZone);
  const allowed = await allowedTier(actor);
  const [calendar, tasks, commitments, decisionsDue, openReview, anomalies] = await Promise.all([
    sql`select id, uid, starts_at, ends_at, title, location from calendar_events
        where starts_at >= ${t}::timestamptz - interval '1 hour'
          and starts_at < ${t}::timestamptz + interval '2 days'
          and tier <= ${allowed}
        order by starts_at`,
    sql`select id, title, status, due from tasks
        where status in ('inbox','active','waiting') and due is not null and due <= ${today}::date
          and tier <= ${allowed}
        order by due`,
    sql`select id, what, to_whom, due from commitments
        where status = 'open' and tier <= ${allowed}
        order by due nulls last`,
    sql`select id, question, review_at, choice from decisions
        where reviewed_at is null
          and tier <= ${allowed}
          and ( (review_at is not null and review_at <= ${today}::date + 3)
                or choice is null )
        order by review_at nulls last`,
    sql`select count(*)::int as n from review_queue where status = 'open'`,
    metricAnomalies(),
  ]);
  return {
    calendar,
    tasks_due: tasks,
    commitments_open: commitments,
    decision_reviews_due: decisionsDue,
    review_queue_open: openReview[0]?.n ?? 0,
    metric_anomalies: anomalies,
  };
}

// Forward-looking agenda: tasks due within an inclusive [from, to] date range.
// minime_state is today-anchored (due <= today) and CANNOT answer "what's due
// tomorrow / this week"; this fills that gap. Includes inbox/active/waiting
// (open work), excludes done/dropped. Ordered by due date then title.
export async function tasksInRange(from: string, to: string, actor?: AccessActor): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return sql`select id, title, status, due from tasks
      where status in ('inbox','active','waiting')
        and due is not null
        and due >= ${from}::date and due <= ${to}::date
        and tier <= ${allowed}
      order by due, title`;
}

// Dedup support for the inbox pipeline: find open (non-done/dropped) tasks whose
// normalized title closely matches a candidate, so a re-mention of the same item is
// routed to the review queue instead of silently inserting a second row. Normalization
// strips punctuation/case/whitespace; we compare a trigram-ish containment both ways so
// "Attend Mia's KiddieWinkie event" matches "Attend Mia KiddieWinkie Father's Day event".
export async function openTasksForDedup(): Promise<
  { id: string; title: string; due: string | null }[]
> {
  return sql`select id, title, due from tasks
      where status in ('inbox','active','waiting')
      order by created_at desc
      limit 500` as any;
}

// Latest daily value vs trailing-28-day mean ± 2σ, from metric_values only (never raw tier-0).
export async function metricAnomalies(): Promise<any[]> {
  const t = now();
  return sql`
    with latest as (
      select distinct on (metric) metric, period_start, value
      from metric_values
      where granularity = 'day' and period_start <= ${t}::date
      order by metric, period_start desc
    ), stats as (
      select l.metric, avg(mv.value) as mean, stddev_samp(mv.value) as sd
      from latest l
      join metric_values mv on mv.metric = l.metric and mv.granularity = 'day'
        and mv.period_start between l.period_start - 28 and l.period_start - 1
      group by l.metric
    )
    select l.metric, l.period_start, l.value::float, s.mean::float, s.sd::float
    from latest l join stats s on s.metric = l.metric
    where s.sd is not null and s.sd > 0 and abs(l.value - s.mean) > 2 * s.sd`;
}

// ---------------------------------------------------------------- metrics (I6)

export async function metricDef(
  name: string,
): Promise<{ name: string; unit: string | null; description: string | null } | null> {
  const rows = await sql`select name, unit, description from metric_defs where name = ${name}`;
  return (rows[0] as any) ?? null;
}

export async function listMetricDefs(): Promise<
  { name: string; unit: string | null; agg_sql: string | null }[]
> {
  return sql`select name, unit, agg_sql from metric_defs order by name` as any;
}

// The single door to whitelisted aggregate SQL (incl. tier-0 sources): the security definer
// function created in 007_rls.sql. Parameterized; metric name is checked against metric_defs.
export async function runMetricAgg(
  name: string,
  from: string,
  to: string,
): Promise<{ period_start: string; value: number; label: string | null }[]> {
  const def = await metricDef(name);
  if (!def) throw Object.assign(new Error(`unknown metric: ${name}`), { code: "UNKNOWN_METRIC" });
  const rows =
    await sql`select period_start, value::float, label from metric_agg(${name}, ${from}, ${to})`;
  return rows.map((r: any) => ({
    period_start: toDateStr(r.period_start),
    value: Number(r.value),
    label: r.label ?? null,
  }));
}

function toDateStr(d: Date | string): string {
  if (typeof d === "string") return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function storedMetricValues(
  name: string,
  from: string,
  to: string,
  granularity: string,
): Promise<any[]> {
  return sql`select period_start, value::float, source from metric_values
             where metric = ${name} and granularity = ${granularity}
               and period_start between ${from} and ${to}
             order by period_start`;
}

export async function upsertMetricValue(
  name: string,
  periodStart: string,
  granularity: string,
  value: number,
  source: string,
): Promise<void> {
  await sql`
    insert into metric_values (metric, period_start, granularity, value, source, computed_at)
    values (${name}, ${periodStart}, ${granularity}, ${value}, ${source}, ${now()})
    on conflict (metric, granularity, period_start)
      do update set value = excluded.value, source = excluded.source, computed_at = excluded.computed_at`;
}

// ---------------------------------------------------------------- context

export async function getRow(
  type: ParentType,
  id: string,
  actor?: AccessActor,
): Promise<any | null> {
  const allowed = await allowedTier(actor);
  const { table } = parentTable(type);
  const rows = await sql`select * from ${sql(table)} where id = ${id} and tier <= ${allowed}`;
  return rows[0] ?? null;
}

export async function edgesAround(
  type: string,
  id: string,
  limit = 20,
  actor?: AccessActor,
): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return sql`
    select * from edges
    where ((src_type = ${type} and src_id = ${id}) or (dst_type = ${type} and dst_id = ${id}))
      and tier <= ${allowed}
    order by created_at desc limit ${limit}`;
}

export async function recentInteractionsFor(
  personId: string,
  limit = 20,
  actor?: AccessActor,
): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return sql`select id, kind, summary, occurred_at, created_by from interactions
             where person_id = ${personId} and tier <= ${allowed}
             order by occurred_at desc limit ${limit}`;
}

export async function openItemsFor(
  personName: string,
  actor?: AccessActor,
): Promise<{ commitments: any[]; tasks: any[] }> {
  const allowed = await allowedTier(actor);
  const commitments = await sql`
    select id, what, to_whom, due, status from commitments
    where status = 'open' and lower(to_whom) = lower(${personName}) and tier <= ${allowed}`;
  const tasks = await sql`
    select id, title, status, due from tasks
    where status in ('inbox','active','waiting') and title ilike '%' || ${personName} || '%'
      and tier <= ${allowed}`;
  return { commitments, tasks };
}

export async function journalCountSince(since: Date): Promise<number> {
  const [r] = await sql`select count(*)::int as n from journal_entries where at >= ${since}`;
  return r!.n;
}

// Resolve page rows by path, e.g. mapping benchmark haystack ids (encoded in paths) to
// page UUIDs for scoped search.
export async function pagesByPaths(paths: string[]): Promise<{ id: string; path: string }[]> {
  if (paths.length === 0) return [];
  return sql`select id, path from pages where path = any(${paths})` as any;
}

// ---------------------------------------------------------------- dream support

// Parents never touched by the extractor (no system:extract edges yet). Parents whose
// text yields zero entities are re-scanned each night — bounded by `limit`, regex-cheap.
export async function parentsNeedingExtraction(
  limit: number,
): Promise<{ parent_type: string; parent_id: string; text: string }[]> {
  return sql`
    select c.parent_type, c.parent_id, string_agg(c.text, e'\n\n' order by c.ord) as text
    from chunks c
    where not exists (
      select 1 from edges e
      where e.src_type = c.parent_type and e.src_id = c.parent_id
        and e.extracted_by = 'system:extract'
    )
    group by c.parent_type, c.parent_id
    order by max(c.updated_at) desc limit ${limit}` as any;
}

export async function allPeopleWithAliases(): Promise<{ id: string; names: string[] }[]> {
  const rows = await sql`
    select p.id, array_agg(distinct x.name) as names
    from people p
    cross join lateral (
      select p.canonical_name as name
      union select a.alias from person_aliases a where a.person_id = p.id
    ) x
    group by p.id`;
  return rows.map((r: any) => ({ id: r.id, names: r.names }));
}

export async function staleItems(
  referencedSinceDays: number,
  untouchedDays: number,
): Promise<any[]> {
  const t = now();
  return sql`
    select 'page' as type, id, title as label, updated_at from pages
    where status = 'active' and updated_at < ${t}::timestamptz - make_interval(days => ${untouchedDays})
    union all
    select 'person' as type, id, canonical_name as label, updated_at from people
    where coalesce(last_contact_at, updated_at) < ${t}::timestamptz - make_interval(days => ${untouchedDays})`;
}

export async function decisionsNeedingReview(): Promise<any[]> {
  const t = now();
  return sql`select id, question, review_at from decisions
             where review_at is not null and review_at <= ${t}::date and reviewed_at is null`;
}

// Pairs of chunks linked (by the dream entity-link pass) to the same person, for the
// contradiction scan. Chunk text stays inside the dream job — flagged pairs store IDs only.
export async function chunkPairsSharingPerson(limit: number): Promise<
  {
    person_id: string;
    a_id: string;
    a_text: string;
    a_tier: number;
    b_id: string;
    b_text: string;
    b_tier: number;
  }[]
> {
  return sql`
    select e1.dst_id as person_id, c1.id as a_id, c1.text as a_text, c1.tier as a_tier,
           c2.id as b_id, c2.text as b_text, c2.tier as b_tier
    from edges e1
    join edges e2 on e2.dst_type = 'person' and e2.dst_id = e1.dst_id
      and e2.source_table = 'chunks' and e1.source_id < e2.source_id
    join chunks c1 on c1.id = e1.source_id
    join chunks c2 on c2.id = e2.source_id
    where e1.dst_type = 'person' and e1.source_table = 'chunks'
    limit ${limit}` as any;
}

export async function reviewItemExists(
  kind: string,
  payloadKey: string,
  payloadValue: string,
): Promise<boolean> {
  const rows = await sql`select 1 from review_queue where kind = ${kind} and status = 'open'
    and payload ->> ${payloadKey} = ${payloadValue} limit 1`;
  return rows.length > 0;
}

// ---------------------------------------------------------------- compiled notes (dream step)
// System-job reads (like chunkPairsSharingPerson): chunk text stays on-box and the resulting
// note page carries the inherited tier, so agent reads are tier-gated at the page. No
// allowedTier predicate here — the dream job is not an agent context. The entity-link pass
// anchors `mentions` edges at the chunk (source_table='chunks', source_id=chunk.id), so a
// candidate's source chunks are exactly those edges' chunks.

export interface NoteCandidate {
  kind: "person";
  id: string;
  name: string;
  chunk_count: number;
  max_tier: number;
  latest_mention_at: Date;
}

// People with at least `minChunks` chunks that mention them. `max_tier` drives the note tier;
// `latest_mention_at` is the cheap staleness signal (vs. the note page's updated_at). Mention
// edges are PARENT-anchored (src = the mentioning row, M7 extraction shape), so the chunks
// are joined via the edge's src parent. Note pages themselves are excluded so a note never
// feeds itself.
export async function noteCandidates(minChunks: number): Promise<NoteCandidate[]> {
  const rows = (await sql`
    select 'person'::text as kind, e.dst_id as id, p.canonical_name as name,
           count(distinct c.id)::int as chunk_count,
           max(c.tier)::int as max_tier,
           max(e.created_at) as latest_mention_at
    from edges e
    join chunks c on c.parent_type = e.src_type and c.parent_id = e.src_id
    join people p on p.id = e.dst_id
    where e.rel = 'mentions' and e.dst_type = 'person'
      and not (e.src_type = 'page' and exists (
        select 1 from pages pg where pg.id = e.src_id and pg.source = 'dream:notes'))
    group by e.dst_id, p.canonical_name
    having count(distinct c.id) >= ${minChunks}
    order by chunk_count desc`) as any;
  return rows as NoteCandidate[];
}

// The mentioning chunks for one person, oldest first (so the representative source —
// derived_from — is the earliest mentioning row). Parent-anchored edges as above; only
// chunks that literally contain one of the person's names are distilled, so the note
// quotes mentioning text rather than every chunk of a long mentioning page.
export async function noteSourceChunks(
  _kind: "person",
  id: string,
): Promise<{ id: string; parent_type: string; parent_id: string; text: string; tier: number }[]> {
  return sql`
    select c.id, c.parent_type, c.parent_id, c.text, c.tier
    from edges e
    join chunks c on c.parent_type = e.src_type and c.parent_id = e.src_id
    where e.rel = 'mentions' and e.dst_type = 'person' and e.dst_id = ${id}
      and not (e.src_type = 'page' and exists (
        select 1 from pages pg where pg.id = e.src_id and pg.source = 'dream:notes'))
      and exists (
        select 1 from people p
        left join person_aliases a on a.person_id = p.id
        where p.id = ${id}
          and (c.text ilike '%' || p.canonical_name || '%'
               or (a.alias is not null and c.text ilike '%' || a.alias || '%')))
    order by c.updated_at, c.ord, c.id` as any;
}

// The note page's last-compiled marker. updated_at advances only when the body changed
// (upsertPage no-ops on identical content_hash), so a mention newer than this means stale.
export async function notePageFreshness(
  path: string,
): Promise<{ id: string; updated_at: Date } | null> {
  const rows =
    await sql`select id, updated_at from pages where path = ${path} and status = 'active'`;
  return (rows[0] as any) ?? null;
}

// ---------------------------------------------------------------- decision digests (dream step)

export interface DecisionDigestInput {
  id: string;
  question: string;
  options: unknown;
  criteria: unknown;
  choice: string | null;
  reasoning: string | null;
  expected_outcome: string | null;
  actual_outcome: string | null;
  outcome_score: number | null;
  falsifier: string | null;
  stakes: string | null;
  reversibility: string | null;
  confidence: number | null;
  tier: number;
  updated_at: Date;
  transcript: {
    id: string;
    question_key: string;
    prompt: string;
    answer: string;
    tier: number;
  }[];
  branches: {
    id: string;
    label: string;
    status: string;
    note: string | null;
    would_be_right_if: string | null;
    tier: number;
  }[];
}

export function decisionDigestPath(id: string): string {
  return `derived/decisions/${id}.md`;
}

export async function decisionDigestInput(id: string): Promise<DecisionDigestInput | null> {
  const rows = await sql`select * from decisions where id = ${id}`;
  const d = rows[0] as any;
  if (!d) return null;
  const transcript = (await sql`
    select id, question_key, prompt, answer, tier
    from decision_transcripts
    where decision_id = ${id}
    order by ord`) as any[];
  const branches = (await sql`
    select id, label, status, note, would_be_right_if, tier
    from decision_branches
    where decision_id = ${id}
    order by created_at, id`) as any[];
  const tier = [d.tier, ...transcript.map((t) => t.tier), ...branches.map((b) => b.tier)].reduce(
    (max, t) => Math.max(max, Number(t ?? 1)),
    1,
  );
  d.tier = tier;
  return { ...d, transcript, branches } as DecisionDigestInput;
}

export async function decisionDigestCandidates(): Promise<DecisionDigestInput[]> {
  const rows = (await sql`
    select d.id
    from decisions d
    left join pages pg on pg.path = ${"derived/decisions/"} || d.id::text || '.md'
    where pg.id is null
       or pg.status <> 'active'
       or pg.body_md not like '%compiler: dream%'
       or pg.updated_at < d.updated_at
    order by d.updated_at desc`) as any[];
  const out: DecisionDigestInput[] = [];
  for (const r of rows) {
    const input = await decisionDigestInput(r.id);
    if (input) out.push(input);
  }
  return out;
}
