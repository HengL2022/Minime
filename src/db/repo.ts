// The ONLY place application SQL runs (spec §14). Every content read applies the tier
// predicate `tier <= allowedTier()`. Tier-0 tables (transactions, health_samples) have no
// content-read functions at all — they are reachable only via metric_agg() (I3).
// Everything is parameterized; string-interpolated SQL is a review-blocker.

import { cjkFold, isCjkStopToken } from "../util/cjk";
import { now } from "../util/clock";
import { config } from "../util/config";
import { sql } from "./client";

export type ParentType =
  | "page"
  | "journal"
  | "interaction"
  | "decision"
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

export async function allowedTier(): Promise<1 | 2> {
  const rows = await sql`
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

export async function ftsCandidates(query: string, types: string[] | null): Promise<Candidate[]> {
  const allowed = await allowedTier();
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
    order by fts desc
    limit 50` as any;
}

export async function vectorCandidates(
  embedding: number[],
  types: string[] | null,
): Promise<Candidate[]> {
  const allowed = await allowedTier();
  const vec = JSON.stringify(embedding);
  return sql`
    select c.id, c.parent_type, c.parent_id, c.ord, c.text,
           (1 - (c.embedding <=> ${vec}::vector))::float as cosine,
           0::float as fts
    from chunks c
    where c.tier <= ${allowed} and c.embedding is not null
      and (${types === null} or c.parent_type = any(${types ?? []}))
    order by c.embedding <=> ${vec}::vector
    limit 50` as any;
}

export interface ParentMeta {
  id: string;
  title: string;
  updated_at: Date;
  created_by: string;
  derived_from: string | null;
}

export async function parentMeta(
  type: ParentType,
  ids: string[],
): Promise<Map<string, ParentMeta>> {
  if (ids.length === 0) return new Map();
  const allowed = await allowedTier();
  const { table, titleCol } = parentTable(type);
  // table/titleCol come from the fixed PARENTS map above, never from user input.
  const rows = await sql`
    select id, left(${sql(titleCol)}::text, 120) as title, updated_at, created_by, derived_from
    from ${sql(table)}
    where id = any(${ids}) and tier <= ${allowed}`;
  return new Map(rows.map((r: any) => [r.id as string, r as ParentMeta]));
}

// People/orgs literally named in the query, for the 1-hop graph boost (spec §9).
export interface EntityRef {
  type: "person" | "org";
  id: string;
}

export async function entitiesNamedIn(query: string): Promise<EntityRef[]> {
  const q = query.toLowerCase();
  const people = await sql`
    select distinct p.id from people p
    left join person_aliases a on a.person_id = p.id
    where ${q} like '%' || lower(p.canonical_name) || '%'
       or (a.alias is not null and ${q} like '%' || lower(a.alias) || '%')`;
  const orgs = await sql`
    select distinct o.id from orgs o
    left join org_aliases a on a.org_id = o.id
    where ${q} like '%' || lower(o.canonical_name) || '%'
       or (a.alias is not null and ${q} like '%' || lower(a.alias) || '%')`;
  return [
    ...people.map((r: any) => ({ type: "person" as const, id: r.id })),
    ...orgs.map((r: any) => ({ type: "org" as const, id: r.id })),
  ];
}

export async function oneHopNeighbors(refs: EntityRef[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const set = new Set<string>();
  for (const type of ["person", "org"] as const) {
    const ids = refs.filter((r) => r.type === type).map((r) => r.id);
    if (ids.length === 0) continue;
    const rows = await sql`
      select src_type as t, src_id as i from edges where dst_type = ${type} and dst_id = any(${ids})
      union
      select dst_type as t, dst_id as i from edges where src_type = ${type} and src_id = any(${ids})`;
    for (const r of rows as any[]) set.add(`${r.t}:${r.i}`);
    for (const id of ids) set.add(`${type}:${id}`);
  }
  return set;
}

// ---------------------------------------------------------------- people

export async function resolvePerson(name: string): Promise<any | null> {
  const allowed = await allowedTier();
  const rows = await sql`
    select distinct p.* from people p
    left join person_aliases a on a.person_id = p.id
    where (lower(p.canonical_name) = lower(${name}) or lower(a.alias) = lower(${name}))
      and p.tier <= ${allowed}
    limit 1`;
  return rows[0] ?? null;
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

export async function resolveOrg(name: string): Promise<any | null> {
  const allowed = await allowedTier();
  const rows = await sql`
    select distinct o.* from orgs o
    left join org_aliases a on a.org_id = o.id
    where (lower(o.canonical_name) = lower(${name}) or lower(a.alias) = lower(${name}))
      and o.tier <= ${allowed}
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

// ---------------------------------------------------------------- writes (rows)

interface Std {
  createdBy?: string;
  source?: string;
  derivedFrom?: string | null;
  tier?: number;
}

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
    reviewAt?: string | null;
    decidedAt?: Date | null;
  } & Std,
): Promise<{ id: string }> {
  const [row] = await sql`
    insert into decisions (question, options, criteria, choice, reasoning, expected_outcome,
                           decided_at, review_at, created_by, source, derived_from, tier)
    values (${d.question}, ${sql.json(d.options as any)}, ${d.criteria ? sql.json(d.criteria as any) : null},
            ${d.choice ?? null}, ${d.reasoning ?? null}, ${d.expectedOutcome ?? null},
            ${d.decidedAt ?? (d.choice ? now() : null)}, ${d.reviewAt ?? null},
            ${d.createdBy ?? "human"}, ${d.source ?? "manual"}, ${d.derivedFrom ?? null}, ${d.tier ?? 1})
    returning id`;
  return row as any;
}

export async function getDecision(id: string): Promise<any | null> {
  const allowed = await allowedTier();
  const rows = await sql`select * from decisions where id = ${id} and tier <= ${allowed}`;
  return rows[0] ?? null;
}

export async function reviewDecision(
  id: string,
  actualOutcome: string,
  lesson: string | null,
  actor: string,
): Promise<{ principleId: string | null }> {
  let principleId: string | null = null;
  await sql.begin(async (tx) => {
    const [dec] =
      await tx`update decisions set actual_outcome = ${actualOutcome}, reviewed_at = ${now()}
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
    insert into tasks (title, body, status, due, goal_id, created_by, source, derived_from, tier)
    values (${t.title}, ${t.body ?? null}, ${t.status ?? "inbox"}, ${t.due ?? null}, ${t.goalId ?? null},
            ${t.createdBy ?? "human"}, ${t.source ?? "manual"}, ${t.derivedFrom ?? null}, ${t.tier ?? 1})
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
  const [existing] = await sql`select id, content_hash from pages where path = ${p.path}`;
  if (existing && existing.content_hash === p.contentHash) {
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

export async function listActivePages(): Promise<any[]> {
  const allowed = await allowedTier();
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

export async function stateSnapshot(): Promise<any> {
  const t = now();
  const [calendar, tasks, commitments, decisionsDue, openReview, anomalies] = await Promise.all([
    sql`select id, uid, starts_at, ends_at, title, location from calendar_events
        where starts_at >= ${t}::timestamptz - interval '1 hour'
          and starts_at < ${t}::timestamptz + interval '2 days'
          and tier <= 1
        order by starts_at`,
    sql`select id, title, status, due from tasks
        where status in ('inbox','active','waiting') and due is not null and due <= ${t}::date
        order by due`,
    sql`select id, what, to_whom, due from commitments where status = 'open' order by due nulls last`,
    sql`select id, question, review_at, choice from decisions
        where (review_at is not null and review_at <= ${t}::date + 3 and reviewed_at is null)
           or (choice is null)
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

export async function getRow(type: ParentType, id: string): Promise<any | null> {
  const allowed = await allowedTier();
  const { table } = parentTable(type);
  const rows = await sql`select * from ${sql(table)} where id = ${id} and tier <= ${allowed}`;
  return rows[0] ?? null;
}

export async function edgesAround(type: string, id: string, limit = 20): Promise<any[]> {
  return sql`
    select * from edges
    where (src_type = ${type} and src_id = ${id}) or (dst_type = ${type} and dst_id = ${id})
    order by created_at desc limit ${limit}`;
}

export async function recentInteractionsFor(personId: string, limit = 20): Promise<any[]> {
  const allowed = await allowedTier();
  return sql`select id, kind, summary, occurred_at, created_by from interactions
             where person_id = ${personId} and tier <= ${allowed}
             order by occurred_at desc limit ${limit}`;
}

export async function openItemsFor(
  personName: string,
): Promise<{ commitments: any[]; tasks: any[] }> {
  const commitments = await sql`
    select id, what, to_whom, due, status from commitments
    where status = 'open' and lower(to_whom) = lower(${personName})`;
  const tasks = await sql`
    select id, title, status, due from tasks
    where status in ('inbox','active','waiting') and title ilike '%' || ${personName} || '%'`;
  return { commitments, tasks };
}

export async function journalCountSince(since: Date): Promise<number> {
  const [r] = await sql`select count(*)::int as n from journal_entries where at >= ${since}`;
  return r!.n;
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
// `latest_mention_at` is the cheap staleness signal (vs. the note page's updated_at). Chunks
// belonging to the note pages themselves are excluded so a note never feeds itself.
export async function noteCandidates(minChunks: number): Promise<NoteCandidate[]> {
  const rows = (await sql`
    select 'person'::text as kind, e.dst_id as id, p.canonical_name as name,
           count(distinct c.id)::int as chunk_count,
           max(c.tier)::int as max_tier,
           max(e.created_at) as latest_mention_at
    from edges e
    join chunks c on c.id = e.source_id
    join people p on p.id = e.dst_id
    where e.rel = 'mentions' and e.dst_type = 'person' and e.source_table = 'chunks'
      and not (c.parent_type = 'page' and exists (
        select 1 from pages pg where pg.id = c.parent_id and pg.source = 'dream:notes'))
    group by e.dst_id, p.canonical_name
    having count(distinct c.id) >= ${minChunks}
    order by chunk_count desc`) as any;
  return rows as NoteCandidate[];
}

// The mentioning chunks for one person, oldest first (so the representative source —
// derived_from — is the earliest mentioning row). Excludes the note pages' own chunks.
export async function noteSourceChunks(
  _kind: "person",
  id: string,
): Promise<{ id: string; parent_type: string; parent_id: string; text: string; tier: number }[]> {
  return sql`
    select c.id, c.parent_type, c.parent_id, c.text, c.tier
    from edges e
    join chunks c on c.id = e.source_id
    where e.rel = 'mentions' and e.dst_type = 'person' and e.dst_id = ${id}
      and e.source_table = 'chunks'
      and not (c.parent_type = 'page' and exists (
        select 1 from pages pg where pg.id = c.parent_id and pg.source = 'dream:notes'))
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
