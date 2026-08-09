// The ONLY place application SQL runs (spec §14). Every agent/ordinary content read applies
// the predicate `tier >= 1 AND tier <= allowedTier()`. Tier-0 tables
// (transactions, health_samples) have no
// content-read functions at all — they are reachable only via metric_agg() (I3).
// Everything is parameterized; string-interpolated SQL is a review-blocker.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AuditPayload, assertAuditPayloadForVerb, auditPayload } from "../util/audit-payload";
import { cjkFold, isCjkStopToken } from "../util/cjk";
import { configuredTimeZone, localDateStr, now, todayStr } from "../util/clock";
import {
  COMPILED_NOTE_MARKER,
  COMPILED_NOTE_SOURCE,
  COMPILED_NOTE_UUID_PATH_SQL_RE,
  type CompiledNoteIdentity,
  recognizeCompiledNote,
} from "../util/compiled-note-archive";
import {
  type ProviderName,
  assertTier2UnlockApprovalWindowMinutes,
  assertTier2UnlockMaxMinutes,
  config,
} from "../util/config";
import { type MetricRollup, metricDateString } from "../util/metric-rollup";
import { type RecurFreq, nextDue } from "../util/recurrence";
import {
  type DbExecutor,
  type DbPool,
  type DbReservation,
  db,
  hasDbTransaction,
  reserveDb,
  withDbTransaction,
  withDurableRuntimeDbTransaction,
  withReservedDb,
  withRuntimeDbTransaction,
  withRuntimeReservedDb,
} from "./client";

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

// parent_type -> table, title column, and the fixed SQL expression for that type's semantic
// "event date" (W3-4) — the date a human means by "when did this happen", which is not always
// updated_at (e.g. a decision's updated_at bumps on any edit, but its event date is when it was
// decided). dateCol is raw, developer-authored SQL text and NEVER derived from request input;
// parentMeta below splices it in via db().unsafe(), the same nested-fragment technique
// db()(identifier) and COMPILED_PARENT_TIER already use to compose fixed SQL text into a
// parameterized query (postgres.js treats a nested Query/Identifier value as raw SQL text, not
// a bound parameter — see fragment() in postgres's types.js).
const PARENTS: Record<ParentType, { table: string; titleCol: string; dateCol: string }> = {
  page: { table: "pages", titleCol: "title", dateCol: "updated_at" },
  journal: { table: "journal_entries", titleCol: "entry_md", dateCol: "at" },
  interaction: { table: "interactions", titleCol: "summary", dateCol: "occurred_at" },
  decision: {
    table: "decisions",
    titleCol: "question",
    dateCol: "coalesce(decided_at, created_at)",
  },
  decision_branch: { table: "decision_branches", titleCol: "label", dateCol: "updated_at" },
  task: { table: "tasks", titleCol: "title", dateCol: "coalesce(completed_at, updated_at)" },
  goal: { table: "goals", titleCol: "statement", dateCol: "updated_at" },
  value: { table: "values_items", titleCol: "statement", dateCol: "updated_at" },
  principle: { table: "principles", titleCol: "rule", dateCol: "updated_at" },
  person: { table: "people", titleCol: "canonical_name", dateCol: "updated_at" },
  org: { table: "orgs", titleCol: "canonical_name", dateCol: "updated_at" },
  commitment: { table: "commitments", titleCol: "what", dateCol: "updated_at" },
};

export function parentTable(type: string): { table: string; titleCol: string; dateCol: string } {
  const p = PARENTS[type as ParentType];
  if (!p) throw new Error(`unknown parent type: ${type}`);
  return p;
}

// ---------------------------------------------------------------- owner-only migrations & restored-schema posture

export interface RestoreSchemaStructurePosture {
  readonly extensions: boolean;
  readonly coreRelations: boolean;
  readonly migrationLedger: boolean;
  readonly appendOnlyAudit: boolean;
  readonly tierBoundary: boolean;
  readonly inboxIdentity: boolean;
}

interface RestoreSchemaBaseRow {
  extensions_ok: boolean;
  core_relations_ok: boolean;
  migration_ledger_ok: boolean;
}

interface RestoreSchemaSafetyRow {
  append_only_audit_ok: boolean;
  tier_boundary_ok: boolean;
  inbox_identity_ok: boolean;
}

export async function connectedAdminDatabaseName(executor: DbExecutor): Promise<string> {
  const rows = await executor`select current_database() as name`;
  const name = rows.length === 1 ? rows[0]?.name : undefined;
  if (typeof name !== "string") throw new Error("migration_context_target");
  return name;
}

export async function schemaMigrationNames(executor: DbExecutor): Promise<string[]> {
  return (await executor`select name from schema_migrations order by name`).map((row) =>
    String(row.name),
  );
}

export async function ensureSchemaMigrationLedger(executor: DbExecutor): Promise<void> {
  await executor`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now()
  )`;
}

/** Execute one checked-out migration and ledger insertion as one owner transaction. */
export async function applyCheckedOutMigration(
  executor: DbPool,
  name: string,
  body: string,
): Promise<void> {
  await executor.begin(async (tx) => {
    await tx.unsafe(body);
    await tx`insert into schema_migrations (name) values (${name})`;
  });
}

async function inspectRestoreSchemaBase(executor: DbExecutor): Promise<RestoreSchemaBaseRow> {
  const rows = await executor<[RestoreSchemaBaseRow]>`select
    (select count(*) = 2 from pg_extension where extname in ('pgcrypto', 'vector'))
      as extensions_ok,
    (select count(*) = 8 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and c.relname in ('schema_migrations', 'events', 'tasks', 'people',
          'journal_entries', 'chunks', 'transactions', 'health_samples')) as core_relations_ok,
    ((select count(*) = 2 and bool_and(a.attnotnull)
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'schema_migrations'
        and a.attname in ('name', 'applied_at') and not a.attisdropped)
      and exists (select 1 from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'name'
        where n.nspname = 'public' and c.relname = 'schema_migrations'
          and con.contype = 'p' and cardinality(con.conkey) = 1
          and con.conkey[1] = a.attnum)) as migration_ledger_ok`;
  return rows[0] ?? { extensions_ok: false, core_relations_ok: false, migration_ledger_ok: false };
}

async function inspectRestoreSchemaSafety(executor: DbExecutor): Promise<RestoreSchemaSafetyRow> {
  // pg_trigger.tgtype is a bitmask: row=1, before=2, delete=8, update=16, truncate=32.
  const rows = await executor<[RestoreSchemaSafetyRow]>`select
    (select count(*) = 2 and bool_and(
        t.tgenabled = 'O' and pns.nspname = 'public' and p.proname = 'events_append_only'
        and p.pronargs = 0 and p.prorettype = 'trigger'::regtype
        and t.tgfoid = to_regprocedure('public.events_append_only()')
        and t.tgqual is null and t.tgattr::text = '' and t.tgnargs = 0
        and t.tgoldtable is null and t.tgnewtable is null
        and ((t.tgname = 'events_no_update' and t.tgtype = 27)
          or (t.tgname = 'events_no_truncate' and t.tgtype = 34)))
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid join pg_namespace pns on pns.oid = p.pronamespace
      where n.nspname = 'public' and c.relname = 'events' and not t.tgisinternal
        and t.tgname in ('events_no_update', 'events_no_truncate'))
      as append_only_audit_ok,
    ((select count(*) = 4 and bool_and(c.relrowsecurity) from pg_class c
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
        and c.relname in ('journal_entries', 'inbox_items', 'chunks', 'edges'))
      and not has_table_privilege('minime_app', 'public.transactions', 'select')
      and not has_table_privilege('minime_app', 'public.health_samples', 'select')
      and not has_table_privilege('minime_engineer_ro', 'public.transactions', 'select')
      and not has_table_privilege('minime_engineer_ro', 'public.health_samples', 'select'))
      as tier_boundary_ok,
    ((select count(*) = 4 from pg_attribute a join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'inbox_items'
        and a.attname in ('content_hash', 'archive_path', 'claim_token', 'claimed_at')
        and not a.attisdropped)
      and exists (select 1 from pg_class idx
        join pg_namespace idxns on idxns.oid = idx.relnamespace
        join pg_index i on i.indexrelid = idx.oid
        join pg_class tbl on tbl.oid = i.indrelid
        join pg_namespace tblns on tblns.oid = tbl.relnamespace
        join pg_attribute raw on raw.attrelid = tbl.oid and raw.attname = 'raw_path'
        join pg_attribute hash on hash.attrelid = tbl.oid and hash.attname = 'content_hash'
        where idxns.nspname = 'public' and idx.relname = 'inbox_items_raw_path_content_hash_uidx'
          and tblns.nspname = 'public' and tbl.relname = 'inbox_items'
          and i.indisunique and i.indisvalid and i.indisready and i.indislive
          and i.indnkeyatts = 2 and i.indnatts = 2 and i.indexprs is null
          and i.indkey[0] = raw.attnum and i.indkey[1] = hash.attnum
          and pg_get_expr(i.indpred, i.indrelid) = '(content_hash IS NOT NULL)')
      and exists (select 1 from pg_constraint con
        join pg_class idx on idx.oid = con.conindid
        join pg_namespace idxns on idxns.oid = idx.relnamespace
        join pg_index i on i.indexrelid = idx.oid
        join pg_class tbl on tbl.oid = con.conrelid
        join pg_namespace n on n.oid = tbl.relnamespace
        join pg_attribute archive on archive.attrelid = tbl.oid and archive.attname = 'archive_path'
        where n.nspname = 'public' and tbl.relname = 'inbox_items'
          and idxns.nspname = 'public' and idx.relname = 'inbox_items_archive_path_key'
          and con.conname = 'inbox_items_archive_path_key' and con.contype = 'u'
          and con.convalidated and i.indisunique and i.indisvalid and i.indisready and i.indislive
          and i.indnkeyatts = 1 and i.indnatts = 1
          and i.indexprs is null and i.indpred is null and i.indkey[0] = archive.attnum
          and cardinality(con.conkey) = 1 and con.conkey[1] = archive.attnum)
      and exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_proc p on p.oid = t.tgfoid join pg_namespace pns on pns.oid = p.pronamespace
        where n.nspname = 'public' and c.relname = 'inbox_items' and not t.tgisinternal
          and t.tgenabled = 'O' and t.tgname = 'inbox_capture_identity_immutable'
          and t.tgtype = 19 and pns.nspname = 'public'
          and p.proname = 'enforce_inbox_capture_identity_immutable'
          and p.pronargs = 0 and p.prorettype = 'trigger'::regtype
          and t.tgfoid = to_regprocedure('public.enforce_inbox_capture_identity_immutable()')
          and t.tgqual is null and t.tgattr::text = '' and t.tgnargs = 0
          and t.tgoldtable is null and t.tgnewtable is null))
      as inbox_identity_ok`;
  return (
    rows[0] ?? { append_only_audit_ok: false, tier_boundary_ok: false, inbox_identity_ok: false }
  );
}

export async function inspectRestoreSchemaStructure(
  executor: DbExecutor,
): Promise<RestoreSchemaStructurePosture> {
  const base = await inspectRestoreSchemaBase(executor);
  const safety = await inspectRestoreSchemaSafety(executor);
  return {
    extensions: base.extensions_ok === true,
    coreRelations: base.core_relations_ok === true,
    migrationLedger: base.migration_ledger_ok === true,
    appendOnlyAudit: safety.append_only_audit_ok === true,
    tierBoundary: safety.tier_boundary_ok === true,
    inboxIdentity: safety.inbox_identity_ok === true,
  };
}

// ---------------------------------------------------------------- tiers & audit

export type AccessActor = string | null | undefined;

/** Execute one MCP handler in an actor- and connection-local transaction. */
export async function withActorDbSession<T>(
  actor: string,
  work: () => Promise<T>,
  sessionId?: string,
): Promise<T> {
  if (hasDbTransaction()) throw new Error("nested_actor_scope");
  return withRuntimeDbTransaction(async (tx) => {
    await tx`select set_config('minime.actor', ${actor}, true)`;
    await tx`select set_config('minime.session_id', ${sessionId ?? ""}, true)`;
    return work();
  });
}

/**
 * Like withActorDbSession, but always opens a genuinely independent transaction (client.ts's
 * withDurableRuntimeDbTransaction) regardless of any ambient actor transaction already open —
 * deliberately callable FROM inside one (no nested_actor_scope guard). For work that must commit
 * for real before some later action the caller's own ambient transaction can't order a commit
 * around (e.g. minime_refile publishing a note projection only once its filing has truly
 * committed, not just once the surrounding tool handler returns). Carries the same
 * minime.actor/minime.session_id GUCs withActorDbSession sets, so app_allowed_tier() and every
 * tier predicate behave identically on either transaction.
 */
export async function withActorDurableDbSession<T>(
  actor: string,
  work: () => Promise<T>,
  sessionId?: string,
): Promise<T> {
  return withDurableRuntimeDbTransaction(async (tx) => {
    await tx`select set_config('minime.actor', ${actor}, true)`;
    await tx`select set_config('minime.session_id', ${sessionId ?? ""}, true)`;
    return work();
  });
}

function assertProseTier(tier: number): asserts tier is 1 | 2 {
  if (tier === 0) throw new Error("TIER0_PROSE_BLOCKED");
  if (tier !== 1 && tier !== 2) throw new Error("INVALID_CONTENT_TIER");
}

function evidenceTier(values: number[]): { min: number | null; max: number | null } {
  return values.length === 0
    ? { min: null, max: null }
    : { min: Math.min(...values), max: Math.max(...values) };
}

const COMPILED_PARENT_TIER = (executor: DbExecutor) => executor`
  case c.parent_type
    when 'page' then (select p.tier from pages p where p.id = c.parent_id)
    when 'journal' then (select j.tier from journal_entries j where j.id = c.parent_id)
    when 'decision' then (select d.tier from decisions d where d.id = c.parent_id)
    when 'interaction' then (select i.tier from interactions i where i.id = c.parent_id)
    when 'task' then (select t.tier from tasks t where t.id = c.parent_id)
    else null
  end`;

function containsCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

// One ownership matcher for every compiled-note evidence path. Alphanumeric aliases need
// Unicode letter/number boundaries; punctuation-bearing aliases are literal; CJK names
// intentionally retain substring behavior.
function ownershipNameMatches(text: string, rawName: string): boolean {
  const name = rawName.trim();
  if (!name) return false;
  const haystack = text.toLocaleLowerCase();
  const needle = name.toLocaleLowerCase();
  if (containsCjk(needle) || /[^\p{L}\p{N}\s]/u.test(needle)) {
    return haystack.includes(needle);
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

export async function allowedTier(actor?: AccessActor, sessionId?: string): Promise<1 | 2> {
  const readTier = async (): Promise<1 | 2> => {
    const [row] = await db()`select app_allowed_tier()::int as tier`;
    const tier = Number(row?.tier);
    if (tier !== 1 && tier !== 2) throw new Error("allowed_tier_invalid");
    return tier;
  };
  if (actor !== undefined && !hasDbTransaction()) {
    return withDbTransaction(async (tx) => {
      await tx`select set_config('minime.actor', ${actor ?? ""}, true)`;
      await tx`select set_config('minime.session_id', ${sessionId ?? ""}, true)`;
      return readTier();
    });
  }
  return readTier();
}

export async function requestTier2Unlock(minutes: number): Promise<{ id: string }> {
  const [row] = await db()`
    select app_request_tier2_unlock(${minutes}::smallint)::text as id`;
  if (!row || typeof row.id !== "string") throw new Error("unlock_request_failed");
  return { id: row.id };
}

export interface ApprovedTier2Unlock {
  id: string;
  minutes: number;
  requestedBy: string;
  expires_at: Date;
}

/** Approve one pending request inside an owner/control-plane transaction. */
export async function approveTier2UnlockRequest(
  id: string,
  approvedBy = "owner:cli",
): Promise<ApprovedTier2Unlock> {
  assertTier2UnlockMaxMinutes(config.tier2UnlockMaxMinutes);
  assertTier2UnlockApprovalWindowMinutes(config.tier2UnlockApprovalWindowMinutes);
  const [row] = await db()`
    with approval_clock as (select clock_timestamp() as at)
    update session_unlocks u
    set approved_at = approval_clock.at,
        approved_by = ${approvedBy},
        expires_at = approval_clock.at + make_interval(mins => u.requested_minutes::int)
    from approval_clock
    where u.id = ${id}::uuid
      and u.scope = 'tier2'
      and u.approved_at is null
      and u.approved_by is null
      and u.expires_at is null
      and u.requested_at >= approval_clock.at
          - make_interval(mins => ${config.tier2UnlockApprovalWindowMinutes})
      and u.requested_minutes between 1 and ${config.tier2UnlockMaxMinutes}
    returning u.id::text as id, u.requested_minutes::int as minutes, u.requested_by, u.expires_at`;
  if (!row) throw new Error("unlock_request_not_approvable");
  const approved = {
    id: String(row.id),
    minutes: Number(row.minutes),
    requestedBy: String(row.requested_by),
    expires_at: new Date(row.expires_at),
  };
  await logEvent({
    actor: approvedBy,
    verb: "unlock:tier2:approved",
    entityType: "session_unlock",
    entityId: approved.id,
    payload: auditPayload.tier2Unlock({ requestId: approved.id, minutes: approved.minutes }),
  });
  return approved;
}

export interface PendingTier2UnlockRequest {
  id: string;
  requestedBy: string;
  requestedMinutes: number;
  requestedAt: Date;
}

/**
 * Requests still eligible for approval (same scope/window/ceiling predicates as
 * approveTier2UnlockRequest), newest first. session_id is NEVER selected — DECISIONS.md
 * 2026-08-06 "Session identifiers are never returned or audited" — callers approve by request
 * id only; approveTier2UnlockRequest re-validates every predicate itself, so a request that
 * goes stale between this list and that call is simply not approvable, not miss-approved.
 */
export async function pendingTier2UnlockRequests(): Promise<PendingTier2UnlockRequest[]> {
  assertTier2UnlockMaxMinutes(config.tier2UnlockMaxMinutes);
  assertTier2UnlockApprovalWindowMinutes(config.tier2UnlockApprovalWindowMinutes);
  const rows = await db()`
    select id::text as id, requested_by, requested_minutes::int as requested_minutes, requested_at
    from session_unlocks
    where scope = 'tier2'
      and approved_at is null
      and requested_at >= clock_timestamp()
          - make_interval(mins => ${config.tier2UnlockApprovalWindowMinutes})
      and requested_minutes between 1 and ${config.tier2UnlockMaxMinutes}
    order by requested_at desc`;
  return rows.map((row) => ({
    id: String(row.id),
    requestedBy: String(row.requested_by),
    requestedMinutes: Number(row.requested_minutes),
    requestedAt: new Date(row.requested_at),
  }));
}

export async function logEvent(e: {
  actor: string;
  verb: string;
  entityType?: string;
  entityId?: string;
  payload: AuditPayload;
}): Promise<string> {
  assertAuditPayloadForVerb(e.verb, e.payload);
  const hasEntityType = e.entityType !== undefined;
  const hasEntityId = e.entityId !== undefined;
  if (hasEntityType !== hasEntityId) throw new Error("invalid_audit_payload");
  const entityIdIsUuid =
    typeof e.entityId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(e.entityId);
  const expectsUnlock = e.verb.startsWith("unlock:tier2:");
  const expectsInbox = e.verb.startsWith("inbox:");
  if (
    (expectsUnlock &&
      (e.entityType !== "session_unlock" ||
        !entityIdIsUuid ||
        e.entityId !== e.payload.request_id)) ||
    (expectsInbox && (e.entityType !== "inbox_item" || !entityIdIsUuid)) ||
    (!expectsUnlock && !expectsInbox && (hasEntityType || hasEntityId))
  ) {
    throw new Error("invalid_audit_payload");
  }
  const [row] = await db()`
    insert into events (at, actor, verb, entity_type, entity_id, payload)
    values (${now()}, ${e.actor}, ${e.verb}, ${e.entityType ?? null}, ${e.entityId ?? null},
            ${db().json(e.payload as any)})
    returning id::text as id`;
  if (!row || typeof row.id !== "string") throw new Error("event insert returned no id");
  return row.id;
}

type EgressKind = "embed" | "classify";

async function insertDurableEgressEvent(
  verb: `egress:${EgressKind}` | `egress:${EgressKind}:outcome`,
  payload: AuditPayload,
): Promise<string> {
  assertAuditPayloadForVerb(verb, payload);
  return withRuntimeReservedDb(async (connection) => {
    if (verb.endsWith(":outcome")) {
      const intentVerb = verb === "egress:embed:outcome" ? "egress:embed" : "egress:classify";
      const [row] = await connection`
        insert into events (at, actor, verb, payload)
        select ${now()}, 'system:llm', ${verb}, ${connection.json(payload as any)}
        where exists (
          select 1 from events
          where id = ${String(payload.intent_event_id)}::bigint and verb = ${intentVerb}
        )
        returning id::text as id`;
      if (!row || typeof row.id !== "string") throw new Error("egress_outcome_intent_invalid");
      return row.id;
    }
    const [row] = await connection`
      insert into events (at, actor, verb, payload)
      values (${now()}, 'system:llm', ${verb}, ${connection.json(payload as any)})
      returning id::text as id`;
    if (!row || typeof row.id !== "string") throw new Error("event insert returned no id");
    return row.id;
  });
}

/** Persist cloud-egress intent outside any caller transaction before bytes leave the machine. */
export async function logEgressIntent(input: {
  kind: EgressKind;
  provider: ProviderName;
  model: string;
  items: number;
  routeTier?: 1 | 2;
}): Promise<string> {
  return insertDurableEgressEvent(
    `egress:${input.kind}`,
    auditPayload.llmEgress({
      kind: input.kind,
      provider: input.provider,
      model: input.model,
      items: input.items,
      ...(input.routeTier === undefined ? {} : { routeTier: input.routeTier }),
    }),
  );
}

/** Persist the fixed outcome independently as well; never include provider response text. */
export async function logEgressOutcome(input: {
  kind: EgressKind;
  intentEventId: string;
  status: "succeeded" | "failed";
}): Promise<string> {
  return insertDurableEgressEvent(
    `egress:${input.kind}:outcome`,
    auditPayload.llmEgressOutcome({
      kind: input.kind,
      intentEventId: input.intentEventId,
      status: input.status,
    }),
  );
}

export async function eventsSince(since: Date): Promise<any[]> {
  return db()`select id, at, actor, verb, entity_type, entity_id, payload
             from events where at >= ${since} order by at desc`;
}

// Latest `at` for one verb, or across every verb when omitted. The maintenance scheduler (W3-5)
// uses the verb form to ask "when did dream last finish" and the verb-less form to ask "has this
// database seen any activity at all" — the freshness signal that keeps a brand-new install from
// immediately catching up a dream that was never scheduled, while still catching up an older
// database where dream never ran.
export async function lastEventAt(verb?: string): Promise<Date | null> {
  const rows = verb
    ? await db()`select max(at) as at from events where verb = ${verb}`
    : await db()`select max(at) as at from events`;
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}

// Newest-first, bounded. Used by opsHealth (last dream:summary) and serve.ts's persistent-failure
// detector (last 3 dream:summary events) -- both read-only, content-free (payload shapes crossing
// this are audit-payload.ts's fixed-vocabulary constructors, e.g. dreamSummary's failed_steps).
export async function recentEventsByVerb(verb: string, limit: number): Promise<any[]> {
  return db()`select at, payload from events where verb = ${verb} order by at desc limit ${limit}`;
}

// ---------------------------------------------------------------- chunks & search

export async function replaceChunks(
  parentType: ParentType,
  parentId: string,
  texts: string[],
  tier: number,
): Promise<void> {
  assertProseTier(tier);
  await withDbTransaction(async (tx) => {
    await tx`delete from chunks where parent_type = ${parentType} and parent_id = ${parentId}`;
    for (let ord = 0; ord < texts.length; ord++) {
      await tx`insert into chunks (parent_type, parent_id, ord, text, tier)
               values (${parentType}, ${parentId}, ${ord}, ${texts[ord]!}, ${tier})`;
    }
  });
}

export async function replacePageChunksMonotonic(
  pageId: string,
  texts: string[],
  requestedTier: 1 | 2,
): Promise<{ count: number; effectiveTier: 1 | 2 }> {
  assertProseTier(requestedTier);
  return withDbTransaction(async (tx) => {
    const [page] = await tx`select tier from pages where id = ${pageId} for update`;
    if (!page) return { count: 0, effectiveTier: requestedTier };
    const chunks = await tx`
      select tier from chunks where parent_type = 'page' and parent_id = ${pageId} for update`;
    const edges = await tx`
      select tier from edges
      where ((source_table = 'pages' and source_id = ${pageId})
          or (src_type = 'page' and src_id = ${pageId}))
      for update`;
    const evidence = [
      Number(page.tier),
      ...chunks.map((row: any) => Number(row.tier)),
      ...edges.map((row: any) => Number(row.tier)),
    ];
    for (const tier of evidence) assertProseTier(tier);
    const effectiveTier = Math.max(requestedTier, ...evidence) as 1 | 2;
    await tx`delete from chunks where parent_type = 'page' and parent_id = ${pageId}`;
    for (let ord = 0; ord < texts.length; ord++) {
      await tx`insert into chunks (parent_type, parent_id, ord, text, tier)
               values ('page', ${pageId}, ${ord}, ${texts[ord]!}, ${effectiveTier})`;
    }
    return { count: texts.length, effectiveTier };
  });
}

export async function chunksMissingEmbedding(
  limit: number,
  maxTier = 2, // cloud embed providers pass CLOUD_MAX_TIER; local providers see everything
): Promise<{ id: string; text: string }[]> {
  return db()`select id, text from chunks
             where embedding is null and tier >= 1 and tier <= ${maxTier}
             order by updated_at limit ${limit}` as any;
}

export async function setChunkEmbedding(
  id: string,
  vector: number[],
  model: string,
): Promise<void> {
  await db()`update chunks set embedding = ${JSON.stringify(vector)}::vector, embed_model = ${model}
            where id = ${id} and tier >= 1`;
}

export async function countChunksMissingEmbedding(): Promise<number> {
  const [r] =
    await db()`select count(*)::int as n from chunks where embedding is null and tier >= 1`;
  return r!.n;
}

// Vectors from different models live in different spaces and must never be compared.
// Switching EMBED_PROVIDER/model therefore wipes everything for a clean re-embed.
export async function clearEmbeddings(): Promise<number> {
  const rows = await db()`update chunks set embedding = null, embed_model = null
                         where embedding is not null returning id`;
  return rows.length;
}

export async function embedModelsInUse(): Promise<string[]> {
  const rows = await db()`select distinct embed_model from chunks where embed_model is not null`;
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
  return db()`
    select c.id, c.parent_type, c.parent_id, c.ord, c.text,
           0::float as cosine,
           ts_rank_cd(c.tsv, websearch_to_tsquery('english', ${orQuery}))::float as fts
    from chunks c
    where c.tier >= 1 and c.tier <= ${allowed}
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
  return db()`
    select c.id, c.parent_type, c.parent_id, c.ord, c.text,
           (1 - (c.embedding <=> ${vec}::vector))::float as cosine,
           0::float as fts
    from chunks c
    where c.tier >= 1 and c.tier <= ${allowed} and c.embedding is not null
      and (${types === null} or c.parent_type = any(${types ?? []}))
      and (${parentIds === null} or c.parent_id = any(${parentIds ?? []}))
    order by c.embedding <=> ${vec}::vector
    limit 50` as any;
}

export interface ParentMeta {
  id: string;
  title: string;
  tier: number;
  updated_at: Date;
  created_by: string;
  derived_from: string | null;
  source: string;
  // Correction state (028_correction_supersede.sql), uniform across all twelve PARENTS tables.
  // superseded_by set -> this row has a live successor (down-weighted, not hidden, in hybrid.ts).
  // superseded_by null -> either live (superseded_at also null) or retracted (excluded below).
  superseded_by: string | null;
  superseded_at: Date | null;
  // Semantic "event date" for this parent's type (PARENTS[type].dateCol, W3-4) — e.g. a
  // journal entry's `at`, not its `updated_at`. Only the search date-range filter
  // (hybrid.ts) reads this; every other consumer of ParentMeta keeps using updated_at.
  event_at: Date;
}

export async function parentMeta(
  type: ParentType,
  ids: string[],
  actor?: AccessActor,
): Promise<Map<string, ParentMeta>> {
  if (ids.length === 0) return new Map();
  const allowed = await allowedTier(actor);
  const { table, titleCol, dateCol } = parentTable(type);
  // table/titleCol/dateCol come from the fixed PARENTS map above, never from user input.
  // Retracted rows (superseded_at set, superseded_by null) are excluded here so hybridSearch's
  // existing meta-miss drop (a candidate whose parent has no meta entry is filtered out) removes
  // them from results even if a chunk somehow survived; retractRow already deletes their chunks
  // as belt-and-suspenders. A superseded-with-successor row (both columns set) stays in the map
  // so it remains rankable — hybridSearch down-weights it by SUPERSEDED_PENALTY rather than
  // hiding it. getRow (below) deliberately does NOT apply this filter: the owner/agent can
  // always inspect any row, live or not, by id.
  const rows = await db()`
    select id, left(${db()(titleCol)}::text, 120) as title, tier, updated_at, created_by,
           derived_from, source, superseded_by, superseded_at,
           (${db().unsafe(dateCol)})::timestamptz as event_at
    from ${db()(table)}
    where id = any(${ids}) and tier >= 1 and tier <= ${allowed}
      and not (superseded_at is not null and superseded_by is null)`;
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
  const people = await db()`
    select distinct p.id from people p
    left join person_aliases a on a.person_id = p.id
    where (${q} like '%' || lower(p.canonical_name) || '%'
       or (a.alias is not null and a.tier >= 1 and a.tier <= ${allowed}
           and ${q} like '%' || lower(a.alias) || '%'))
      and p.tier >= 1 and p.tier <= ${allowed}
      and p.superseded_at is null`;
  const orgs = await db()`
    select distinct o.id from orgs o
    left join org_aliases a on a.org_id = o.id
    where (${q} like '%' || lower(o.canonical_name) || '%'
       or (a.alias is not null and a.tier >= 1 and a.tier <= ${allowed}
           and ${q} like '%' || lower(a.alias) || '%'))
      and o.tier >= 1 and o.tier <= ${allowed}`;
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
    const rows = await db()`
      select src_type as t, src_id as i from edges where dst_type = ${type} and dst_id = any(${ids})
        and tier >= 1 and tier <= ${allowed}
      union
      select dst_type as t, dst_id as i from edges where src_type = ${type} and src_id = any(${ids})
        and tier >= 1 and tier <= ${allowed}`;
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
  const rows = await db()`
    select r.payload->'returned_ids'->>0 as id, count(*)::int as n
    from events r
    join events d
      on d.verb = 'tool:minime_get_context:disposition'
     and d.payload->>'result_event_id' = r.id::text
     and d.payload->>'status' = 'released'
    where r.verb = 'tool:minime_get_context'
      and r.payload->>'delivery' = 'transport'
      and r.at >= ${since}
      and (${!actor} or r.actor = ${actor ?? ""})
      and r.payload->'returned_ids'->>0 = any(${ids})
    group by 1`;
  return new Map(rows.map((r: any) => [r.id as string, r.n as number]));
}

// ---------------------------------------------------------------- people

export async function resolvePerson(name: string, actor?: AccessActor): Promise<any | null> {
  const allowed = await allowedTier(actor);
  const rows = await db()`
    select distinct p.* from people p
    left join person_aliases a on a.person_id = p.id
    where (lower(p.canonical_name) = lower(${name})
       or (a.tier >= 1 and a.tier <= ${allowed} and lower(a.alias) = lower(${name})))
      and p.tier >= 1 and p.tier <= ${allowed}
      and p.superseded_at is null
    limit 1`;
  return rows[0] ?? null;
}

export interface EntityDerivationOptions {
  tier?: 1 | 2;
  derivedFrom?: string | null;
}

export interface AliasDerivationOptions extends EntityDerivationOptions {
  createdBy?: string;
  source?: string;
}

function entityDerivationTier(tier: number | undefined): 1 | 2 {
  if (tier === undefined) return 1;
  if (tier === 1 || tier === 2) return tier;
  throw new Error("entity tier must be 1 or 2");
}

export type EntityKind = "person" | "org";

// W4-2 "returns tier 1 when independently evidenced" hook: a tier-1-sourced resolve
// (ensurePerson/ensureOrg below, called with the default/explicit requested tier of 1) that
// finds an EXISTING identity still sitting at tier 2 -- almost always a row the pre-037 monotonic
// rule swallowed before 037_identity_content_tier_split.sql stopped that from happening to new
// resolves -- gets flagged for owner review. This never changes the row's own tier (that stays
// owner-CLI-only, entity:restore-tier/restoreEntityTier below); it only surfaces the mismatch,
// deduped against any already-open item for the same entity. readable_source_tier bypasses RLS
// (same helper sourceTierForParent below calls) so a locked tier-1 caller can still detect that
// the identity it just resolved is sitting above its own request, without that read itself ever
// returning the row's content to the caller.
async function flagEntityPromotionIfStillTierTwo(
  entityType: EntityKind,
  entityId: string,
): Promise<void> {
  const table = entityType === "person" ? "people" : "orgs";
  const [row] = await db()`select readable_source_tier(${table}, ${entityId}::uuid)::int as tier`;
  if (Number(row?.tier) !== 2) return;
  if (await reviewItemExists("entity_promotion", "entity_id", entityId)) return;
  await insertReviewItem("entity_promotion", { entity_type: entityType, entity_id: entityId });
}

/** Exact structural guard for extraction; returns no hidden person fields. */
export async function personHasNonWorkingRelation(id: string): Promise<boolean> {
  const [row] = await db()`
    select person_has_nonworking_relation(${id}::uuid) as blocked`;
  return row?.blocked === true;
}

/** Exact structural guard for auto-routing; returns no hidden org fields. */
export async function exactActiveOrgExists(name: string): Promise<boolean> {
  const [row] = await db()`select exact_active_org_exists(${name}) as exists`;
  return row?.exists === true;
}

export async function ensurePerson(
  name: string,
  createdBy: string,
  source = "capture",
  derivation: EntityDerivationOptions = {},
): Promise<{ id: string; created: boolean }> {
  const tier = entityDerivationTier(derivation.tier);
  const [row] = await db()`
    select entity_id as id, was_created as created
    from resolve_or_promote_entity(
      'person', ${name}, ${tier}::smallint, ${createdBy}, ${source},
      ${derivation.derivedFrom ?? null}::uuid
    )`;
  if (!row) throw new Error("entity_resolver_returned_no_row");
  const result = { id: row.id as string, created: row.created as boolean };
  if (tier === 1 && !result.created) await flagEntityPromotionIfStillTierTwo("person", result.id);
  return result;
}

export async function ensureExtractedPerson(
  name: string,
  createdBy: string,
  derivation: EntityDerivationOptions,
): Promise<{ id: string; created: boolean }> {
  const tier = entityDerivationTier(derivation.tier);
  const [row] = await db()`
    select entity_id as id, was_created as created
    from resolve_or_promote_extracted_person(
      ${name}, ${tier}::smallint, ${createdBy}, 'extract',
      ${derivation.derivedFrom ?? null}::uuid
    )`;
  if (!row) throw new Error("entity_resolver_returned_no_row");
  return { id: row.id as string, created: row.created as boolean };
}

// Owner-relation + free-text context (onboarding interview, and minime_upsert_person's
// set_relation/set_context actions); coalesce means a null argument leaves that column
// unchanged rather than blanking it, so each action can patch just its own field. Returns the
// updated-row count so a caller resolving by a tier-filtered id upstream (minime_upsert_person)
// can turn a 0-row result into NOT_FOUND instead of silently no-op'ing.
export async function setPersonDetails(
  id: string,
  relation: string | null,
  context: string | null,
): Promise<number> {
  const rows = await db()`update people set relation = coalesce(${relation}, relation),
                              context = coalesce(${context}, context)
            where id = ${id} returning id`;
  return rows.length;
}

export async function setDecisionOutcome(
  id: string,
  actualOutcome: string,
  reviewedAt: Date,
): Promise<void> {
  await db()`update decisions
             set actual_outcome = ${actualOutcome}, reviewed_at = ${reviewedAt}
             where id = ${id}`;
}

export async function addAlias(
  personId: string,
  alias: string,
  derivation: AliasDerivationOptions = {},
): Promise<void> {
  const tier = entityDerivationTier(derivation.tier);
  await db()`select upsert_derived_alias(
    'person', ${personId}::uuid, ${alias}, ${tier}::smallint,
    ${derivation.createdBy ?? "human"}, ${derivation.source ?? "manual"},
    ${derivation.derivedFrom ?? null}::uuid
  )`;
}

export async function touchLastContact(personId: string, at: Date): Promise<void> {
  await db()`select touch_person_last_contact(${personId}::uuid, ${at}::timestamptz)`;
}

// Owner-relation ("my physiotherapist") detected by extraction: fill only if empty —
// a human-set relation is never overwritten by a rule.
export async function setPersonRelationIfNull(personId: string, relation: string): Promise<void> {
  await db()`select set_person_relation_if_null(${personId}::uuid, ${relation})`;
}

// Extraction may upgrade "Tomasz" to "Tomasz Wójcik" once the fuller form is seen; also used by
// minime_upsert_person's rename action. Returns the updated-row count (see setPersonDetails).
export async function setPersonCanonicalName(personId: string, name: string): Promise<number> {
  const rows = await db()`update people set canonical_name = ${name}
    where id = ${personId} returning id`;
  return rows.length;
}

export async function peopleByFirstName(first: string): Promise<{ id: string }[]> {
  return db()`
    select id from people
    where lower(split_part(canonical_name, ' ', 1)) = ${first.toLowerCase()}
      and superseded_at is null` as any;
}

// ---------------------------------------------------------------- person_dates (W3-10)

export type PersonDateKind = "birthday" | "anniversary" | "custom";

// Insert-or-update by (person_id, kind, label) — label coalesced to '' so a repeat "set my
// birthday" call updates the one row instead of minting a duplicate (034_person_dates.sql's own
// comment on why a bare unique(person_id, kind, label) can't do this: Postgres never treats two
// NULLs as equal). The ON CONFLICT target below must name the exact same coalesce(label, '')
// expression as the migration's unique index for Postgres to infer it as the arbiter.
// created_by/source/derived_from are stamped once at creation and left alone on an update, same
// as upsertCalendarEvent's content-columns-only SET list.
export async function upsertPersonDate(d: {
  personId: string;
  kind: PersonDateKind;
  label?: string | null;
  month: number;
  day: number;
  year?: number | null;
  createdBy?: string;
  source?: string;
  derivedFrom?: string | null;
}): Promise<{ id: string }> {
  const [row] = await db()`
    insert into person_dates (person_id, kind, label, month, day, year, created_by, source, derived_from)
    values (${d.personId}, ${d.kind}, ${d.label ?? null}, ${d.month}, ${d.day}, ${d.year ?? null},
            ${d.createdBy ?? "human"}, ${d.source ?? "manual"}, ${d.derivedFrom ?? null})
    on conflict (person_id, kind, (coalesce(label, '')))
    do update set month = excluded.month, day = excluded.day, year = excluded.year, updated_at = now()
    returning id`;
  if (!row) throw new Error("person_date_upsert_returned_no_row");
  return { id: row.id as string };
}

// Next occurrence (within [today, today + days - 1], both inclusive -- `days` calendar dates
// starting at today) of every visible person_date, one row per date. "Next occurrence" picks the
// earliest of this-year's and next-year's calendar date >= today for that (month, day) --
// handling the year wrap (e.g. a Dec 28 "today" with a Jan 5 birthday: this year's Jan 5 already
// passed, so next year's is picked, which lands inside a 14-day window from Dec 28).
//
// Documented choice for Feb 29: a birthday stored as month=2/day=29 is clamped to the LAST real
// day of February in a candidate year that isn't a leap year, i.e. it surfaces on Feb 28 that
// year (never skipped, never rolled into March) -- `least(day, last day of that candidate
// month/year)` below. Same clamp applies to any other day that doesn't exist in a given month
// (e.g. day=31 in a 30-day month).
//
// Tier-gated on BOTH the date row's own tier and its person's tier: a date is only visible when
// both are within the caller's allowed tier. A person whose own identity tier is 2 (e.g. minted
// purely from journal/page extraction — 037_identity_content_tier_split.sql; minime_log_interaction
// no longer mints or promotes a subject to tier 2) makes their dates drop out of this list at
// tier 1 too, even a date row that is itself tier 1 -- consistent with how every other
// person-attached fact behaves once its person is hidden, and accepted rather than special-cased
// (W3-10 spec).
export async function upcomingPersonDates(
  today: string,
  days: number,
  actor?: AccessActor,
): Promise<any[]> {
  const allowed = await allowedTier(actor);
  const thisYear = Number(today.slice(0, 4));
  const nextYear = thisYear + 1;
  return db()`
    with candidate as (
      select
        pd.id, pd.person_id, pd.kind, pd.label,
        make_date(${thisYear}, pd.month,
          least(pd.day, extract(day from
            (make_date(${thisYear}, pd.month, 1) + interval '1 month' - interval '1 day')
          )::int)
        ) as this_year_date,
        make_date(${nextYear}, pd.month,
          least(pd.day, extract(day from
            (make_date(${nextYear}, pd.month, 1) + interval '1 month' - interval '1 day')
          )::int)
        ) as next_year_date
      from person_dates pd
      where pd.tier >= 1 and pd.tier <= ${allowed}
    ),
    occurrence as (
      select
        id, person_id, kind, label,
        case when this_year_date >= ${today}::date then this_year_date else next_year_date end
          as next_occurrence
      from candidate
    )
    select o.id, o.person_id, p.canonical_name, o.kind, o.label, o.next_occurrence as date
    from occurrence o
    join people p on p.id = o.person_id
    where p.tier >= 1 and p.tier <= ${allowed}
      and p.superseded_at is null
      and o.next_occurrence between ${today}::date and ${today}::date + (${days}::int - 1)
    order by o.next_occurrence, p.canonical_name` as any;
}

// ---------------------------------------------------------------- orgs

export async function resolveOrg(name: string, actor?: AccessActor): Promise<any | null> {
  const allowed = await allowedTier(actor);
  const rows = await db()`
    select distinct o.* from orgs o
    left join org_aliases a on a.org_id = o.id
    where (lower(o.canonical_name) = lower(${name})
       or (a.tier >= 1 and a.tier <= ${allowed} and lower(a.alias) = lower(${name})))
      and o.tier >= 1 and o.tier <= ${allowed}
      and o.retired_at is null
    limit 1`;
  return rows[0] ?? null;
}

export async function ensureOrg(
  name: string,
  createdBy: string,
  source = "extract",
  derivation: EntityDerivationOptions = {},
): Promise<{ id: string; created: boolean }> {
  const tier = entityDerivationTier(derivation.tier);
  const [row] = await db()`
    select entity_id as id, was_created as created
    from resolve_or_promote_entity(
      'org', ${name}, ${tier}::smallint, ${createdBy}, ${source},
      ${derivation.derivedFrom ?? null}::uuid
    )`;
  if (!row) throw new Error("entity_resolver_returned_no_row");
  const result = { id: row.id as string, created: row.created as boolean };
  if (tier === 1 && !result.created) await flagEntityPromotionIfStillTierTwo("org", result.id);
  return result;
}

export async function ensureExtractedOrg(
  name: string,
  baseName: string,
  createdBy: string,
  derivation: EntityDerivationOptions,
): Promise<{ id: string; created: boolean }> {
  const tier = entityDerivationTier(derivation.tier);
  const [row] = await db()`
    select entity_id as id, was_created as created
    from resolve_or_promote_extracted_org(
      ${name}, ${baseName}, ${tier}::smallint, ${createdBy}, 'extract',
      ${derivation.derivedFrom ?? null}::uuid
    )`;
  if (!row) throw new Error("entity_resolver_returned_no_row");
  return { id: row.id as string, created: row.created as boolean };
}

export async function addOrgAlias(
  orgId: string,
  alias: string,
  derivation: AliasDerivationOptions = {},
): Promise<void> {
  const tier = entityDerivationTier(derivation.tier);
  await db()`select upsert_derived_alias(
    'org', ${orgId}::uuid, ${alias}, ${tier}::smallint,
    ${derivation.createdBy ?? "human"}, ${derivation.source ?? "manual"},
    ${derivation.derivedFrom ?? null}::uuid
  )`;
}

// Used by minime_upsert_person's rename action. Returns the updated-row count (see
// setPersonDetails) — orgs carry a real RLS tier_update policy (008_orgs.sql), so this can
// genuinely match 0 rows when the caller's tier has dropped below the row's since it resolved.
export async function setOrgCanonicalName(orgId: string, name: string): Promise<number> {
  const rows = await db()`update orgs set canonical_name = ${name}
    where id = ${orgId} returning id`;
  return rows.length;
}

export async function allOrgsWithAliases(): Promise<{ id: string; names: string[] }[]> {
  const rows = await db()`
    select o.id, array_agg(distinct x.name) as names
    from orgs o
    cross join lateral (
      select o.canonical_name as name
      union select a.alias from org_aliases a
        where a.org_id = o.id and a.tier in (1,2)
    ) x
    where o.tier in (1,2) and o.retired_at is null
    group by o.id`;
  return rows.map((r: any) => ({ id: r.id, names: r.names }));
}

// ---------------------------------------------------------------- entity retype / supersede
//
// Sanctioned, reversible repair for a mis-typed entity: the relation extractor sometimes
// mints an `org` row for what is really a person (e.g. a boss first seen only inside a task
// title — see the 2026-06-16 mistyped-org retype incident, DECISIONS.md). There is no
// classifier path that retypes an existing wrong row, so this is the one authorized place
// that converts org → person. It:
//   1. reuses an existing person of the same name, else creates one (carrying org aliases),
//   2. repoints every edge that referenced the org (src or dst) to the person, dropping
//      self-referential edges and de-duping any edge that now collides,
//   3. retires (does NOT delete) the org row and records the supersession pointer on the
//      person, so the change is auditable and reversible from the backup.
export async function retypeOrgToPerson(
  orgId: string,
  opts: { relation?: string | null; reason?: string } = {},
): Promise<{ personId: string; orgId: string; created: boolean; edgesRepointed: number }> {
  return withDbTransaction(async (tx) => {
    const [org] = await tx`
      select id, canonical_name, tier, source, created_by, derived_from
      from orgs where id = ${orgId} for update`;
    if (!org) throw new Error(`org not found: ${orgId}`);
    const name = org.canonical_name as string;
    const orgTier = Number(org.tier) as 0 | 1 | 2;

    // 1. Resolve within the source identity's privacy namespace. Tier 0 is quarantined:
    // a readable spelling cannot cause this owner repair to merge with a hidden identity,
    // while a tier-0 alias remains a valid privacy-preserving match for tier-0 source data.
    // superseded_at is null excludes an already-merged-away husk (mergePersonIntoPerson below)
    // from being reused as a surviving identity — same guard as resolvePerson/entitiesNamedIn/
    // peopleByFirstName/phantomPersonCandidates, so a retype can never write new tier/relation/
    // alias/edge data onto a row every resolver path has agreed to hide.
    const [existingPerson] = await tx`
      select p.id from people p
      where ((${orgTier} = 0 and p.tier = 0)
          or (${orgTier} in (1,2) and p.tier in (1,2)))
        and p.superseded_at is null
        and (
          lower(p.canonical_name) = lower(${name})
          or exists (
            select 1 from person_aliases a
            where a.person_id = p.id and lower(a.alias) = lower(${name})
              and ((${orgTier} = 0 and a.tier = 0)
                or (${orgTier} in (1,2) and a.tier in (1,2)))
          )
        )
      order by case p.tier when 0 then 3 else p.tier end desc, p.id
      limit 1 for update`;
    let personId: string;
    let created = false;
    if (existingPerson) {
      personId = existingPerson.id as string;
    } else {
      const [row] = await tx`
        insert into people
          (canonical_name, created_by, source, derived_from, supersedes_id, tier)
        values (${name}, 'agent:retype', 'retype',
                ${org.derived_from ?? orgId}, ${orgId}, ${orgTier}) returning id`;
      personId = row!.id as string;
      created = true;
    }
    // W4-1 identity/content tier split: the reused person's own identity tier is no longer
    // raised to match the org being folded into it (greatest(tier, orgTier)) -- resolving into
    // an EXISTING identity never promotes it, matching resolve_or_promote_entity's own rule
    // (037_identity_content_tier_split.sql). Only the tier-0 quarantine absorb stays unconditional
    // (and is, in practice, unreachable here: the namespace-matching query above already requires
    // existingPerson.tier and orgTier to share tier-0-ness or both be in {1,2}, so the "one side
    // is 0 and the other isn't" arm below never fires for a REUSED person — it is kept anyway as
    // the same defensive, verbatim absorbing floor every other CASE in this migration keeps).
    const [updated] = await tx`
      update people
      set relation = coalesce(relation, ${opts.relation ?? null}),
          tier = case when tier = 0 or ${orgTier} = 0 then 0 else tier end,
          derived_from = case when tier <> 0 and ${orgTier} = 0
                              then ${org.derived_from ?? orgId}
                              else coalesce(derived_from, ${org.derived_from ?? orgId}) end,
          supersedes_id = coalesce(supersedes_id, ${orgId})
      where id = ${personId}
      returning tier, derived_from`;
    const personTier = Number(updated!.tier) as 0 | 1 | 2;
    const personDerivedFrom = (updated!.derived_from as string | null) ?? org.derived_from ?? orgId;
    await tx`
      update person_aliases
      set tier = case when tier = 0 or ${personTier} = 0 then 0
                      else greatest(tier, ${personTier}) end,
          derived_from = case when ${personTier} = 0 then ${personDerivedFrom}
                              else coalesce(derived_from, ${personDerivedFrom}) end
      where person_id = ${personId}`;

    // 2. Carry over the org's canonical spelling and aliases. New rows truthfully identify
    // this repair as their creator; the original row remains on the retired org and its source
    // evidence is linked through derived_from. Tier 0 is absorbing on insert and collision.
    await tx`
      insert into person_aliases
        (person_id, alias, tier, source, created_by, derived_from)
      values (${personId}, ${name},
              case when ${personTier}::smallint = 0 or ${orgTier}::smallint = 0 then 0
                   else greatest(${personTier}::smallint, ${orgTier}::smallint) end,
              'retype', 'agent:retype',
              ${org.derived_from ?? orgId})
      on conflict (person_id, alias, privacy_namespace) do update
      set tier = case when person_aliases.tier = 0 or excluded.tier = 0 then 0
                      else greatest(person_aliases.tier, excluded.tier) end,
          derived_from = case
            when person_aliases.tier <> 0 and excluded.tier = 0 then excluded.derived_from
            else coalesce(person_aliases.derived_from, excluded.derived_from)
          end`;
    await tx`
      insert into person_aliases
        (person_id, alias, tier, source, created_by, derived_from)
      select ${personId}, a.alias,
             case when ${personTier} = 0 or a.tier = 0 then 0
                  else greatest(${personTier}, a.tier) end,
             'retype', 'agent:retype',
             coalesce(a.derived_from, ${org.derived_from ?? orgId})
      from org_aliases a where a.org_id = ${orgId}
      on conflict (person_id, alias, privacy_namespace) do update
      set tier = case when person_aliases.tier = 0 or excluded.tier = 0 then 0
                      else greatest(person_aliases.tier, excluded.tier) end,
          derived_from = case
            when person_aliases.tier <> 0 and excluded.tier = 0 then excluded.derived_from
            else coalesce(person_aliases.derived_from, excluded.derived_from)
          end`;

    // 3. repoint edges org→person on both sides
    await tx`update edges set src_type = 'person', src_id = ${personId}
             where src_type = 'org' and src_id = ${orgId}`;
    await tx`update edges set dst_type = 'person', dst_id = ${personId}
             where dst_type = 'org' and dst_id = ${orgId}`;
    // drop self-referential edges created by the repoint (e.g. "X works_at X")
    await tx`delete from edges where src_id = ${personId} and dst_id = ${personId}
             and src_type = 'person' and dst_type = 'person'`;
    // De-dupe edges that now collide. Privacy strength wins (tier 0, then 2, then 1);
    // age is only the tie-breaker, so repair can never discard quarantine evidence.
    await tx`
      delete from edges e using edges k
      where e.src_type = k.src_type and e.src_id = k.src_id and e.rel = k.rel
        and e.dst_type = k.dst_type and e.dst_id = k.dst_id
        and (
          (case e.tier when 0 then 3 else e.tier end) <
            (case k.tier when 0 then 3 else k.tier end)
          or (
            (case e.tier when 0 then 3 else e.tier end) =
              (case k.tier when 0 then 3 else k.tier end)
            and (e.created_at, e.id) > (k.created_at, k.id)
          )
        )
        and (e.src_id = ${personId} or e.dst_id = ${personId})`;
    // Live post-cleanup snapshot, taken after the self-loop delete and de-dupe above — see the
    // matching edges_repointed comment in mergePersonIntoPerson below for why this is a live
    // count rather than a raw repoint-UPDATE tally.
    const cntRows = await tx`
      select count(*)::int n from edges where src_id = ${personId} or dst_id = ${personId}`;
    const edgesRepointed = ((cntRows[0] as any)?.n ?? 0) as number;

    // 4. retire (keep) the org row — never hard-delete
    await tx`update orgs set retired_at = now(), retired_reason = ${opts.reason ?? "retyped to person"}
             where id = ${orgId}`;

    return { personId, orgId, created, edgesRepointed: edgesRepointed as number };
  });
}

// Sanctioned, reversible repair for a duplicate identity: two person rows that are really the
// same human (ten years of "Sarha"/"Sarah" fragmentation from repeated capture typos). There is
// no auto-merge path — canonical_name has no uniqueness constraint (DECISIONS.md 2026-08-08) —
// so this is the one authorized place that folds one person row into another. Modeled line-by-line
// on retypeOrgToPerson above: same FOR UPDATE locking discipline, same tier-0 quarantine
// namespace rule, same edge-repoint/de-dupe logic. Differences: both rows already exist (no
// find-or-create), and the source row is never retired — it is superseded via the generic W2-1
// superseded_by/superseded_at columns (028_correction_supersede.sql), shared with minime_correct.
const MERGE_PERSON_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres compares `uuid`-typed values case-insensitively; every id comparison below this point
// is a plain JS string operation instead (`===`, and the phantom_person auto-resolve's text match
// against `payload ->> 'person_id'`), so a caller-supplied uppercase spelling of the same id must
// be normalized to lowercase HERE, before anything else runs — and a string that isn't a UUID at
// all must be rejected rather than silently reaching a `where id = ...` clause. Skipping this let
// an uppercase --from equal to a lowercase --into slip past the self-merge guard below while the
// SQL underneath still resolved both to the very same row: FOR UPDATE locked that one row twice,
// its own aliases were moved onto itself and then deleted by the same-row DELETE, and
// supersedeRow stamped it superseded by itself — vanishing the only copy of the person from
// every superseded_at-filtered resolver with nothing left absorbing its data (improve/W2-7F,
// fixing a landed W2-7 review finding). Fixing this in JS also means the auto-resolve match below
// needs no SQL-side cast: `fromId` is lowercase by the time it reaches that query, matching the
// lowercase `person_id` values the system itself always writes into review_queue payloads.
function normalizedMergePersonId(id: string): string {
  if (!MERGE_PERSON_ID_RE.test(id)) throw new Error(`invalid person id: ${id}`);
  return id.toLowerCase();
}

export async function mergePersonIntoPerson(
  fromIdRaw: string,
  intoIdRaw: string,
): Promise<{
  fromId: string;
  intoId: string;
  aliasesMoved: number;
  interactionsRepointed: number;
  edgesRepointed: number;
}> {
  const fromId = normalizedMergePersonId(fromIdRaw);
  const intoId = normalizedMergePersonId(intoIdRaw);
  if (fromId === intoId) throw new Error("cannot merge a person into itself");
  return withDbTransaction(async (tx) => {
    // Lock both rows FOR UPDATE in a fixed (lexicographic id) order, independent of which is
    // from/into, so two concurrent merges naming the same pair in opposite directions can never
    // deadlock against each other.
    const [lowId, highId] = fromId < intoId ? [fromId, intoId] : [intoId, fromId];
    const [lowRow] = await tx`
      select id, canonical_name, tier, relation, context, last_contact_at, derived_from,
             superseded_at
      from people where id = ${lowId} for update`;
    const [highRow] = await tx`
      select id, canonical_name, tier, relation, context, last_contact_at, derived_from,
             superseded_at
      from people where id = ${highId} for update`;
    const source = fromId === lowId ? lowRow : highRow;
    const target = intoId === lowId ? lowRow : highRow;
    if (!source) throw new Error(`person not found: ${fromId}`);
    if (!target) throw new Error(`person not found: ${intoId}`);
    if (source.superseded_at !== null) throw new Error("source person is already merged");
    if (target.superseded_at !== null) {
      throw new Error("cannot merge into an already-merged person");
    }

    const sourceCanonicalName = source.canonical_name as string;
    const sourceRelation = (source.relation ?? null) as string | null;
    const sourceContext = (source.context ?? null) as string | null;
    const sourceLastContactAt = (source.last_contact_at ?? null) as Date | null;
    const sourceDerivedFrom = (source.derived_from as string | null) ?? fromId;
    const sourceTier = Number(source.tier) as 0 | 1 | 2;
    const targetTier = Number(target.tier) as 0 | 1 | 2;
    // Tier-0 quarantine namespace rule (repo.ts:960-974 in retypeOrgToPerson): a readable
    // spelling can never absorb a hidden identity, so tier-0 merges only with tier-0; 1/2 with 1/2.
    if ((sourceTier === 0) !== (targetTier === 0)) {
      throw new Error("cannot merge across the tier-0 quarantine boundary");
    }

    // 1. Move aliases: source's aliases -> target (tier-0 absorbing on insert and on collision),
    // then add the source's own canonical spelling as a target alias, then drop the source's rows
    // (the source row itself is kept — only its now-migrated aliases are removed).
    await tx`
      insert into person_aliases (person_id, alias, tier, source, created_by, derived_from)
      select ${intoId}, a.alias,
             case when ${targetTier}::smallint = 0 or a.tier = 0 then 0
                  else greatest(${targetTier}::smallint, a.tier) end,
             'merge', 'agent:merge', coalesce(a.derived_from, ${sourceDerivedFrom})
      from person_aliases a where a.person_id = ${fromId}
      on conflict (person_id, alias, privacy_namespace) do update
      set tier = case when person_aliases.tier = 0 or excluded.tier = 0 then 0
                      else greatest(person_aliases.tier, excluded.tier) end,
          derived_from = case
            when person_aliases.tier <> 0 and excluded.tier = 0 then excluded.derived_from
            else coalesce(person_aliases.derived_from, excluded.derived_from)
          end`;
    await tx`
      insert into person_aliases (person_id, alias, tier, source, created_by, derived_from)
      values (${intoId}, ${sourceCanonicalName},
              case when ${targetTier}::smallint = 0 or ${sourceTier}::smallint = 0 then 0
                   else greatest(${targetTier}::smallint, ${sourceTier}::smallint) end,
              'merge', 'agent:merge', ${sourceDerivedFrom})
      on conflict (person_id, alias, privacy_namespace) do update
      set tier = case when person_aliases.tier = 0 or excluded.tier = 0 then 0
                      else greatest(person_aliases.tier, excluded.tier) end,
          derived_from = case
            when person_aliases.tier <> 0 and excluded.tier = 0 then excluded.derived_from
            else coalesce(person_aliases.derived_from, excluded.derived_from)
          end`;
    const deletedAliases = await tx`
      delete from person_aliases where person_id = ${fromId} returning alias`;
    const aliasesMoved = deletedAliases.length;

    // 2. Repoint interactions logged against the source (no de-dupe needed — interactions have
    // no per-person uniqueness constraint, unlike aliases/edges).
    const repointedInteractions = await tx`
      update interactions set person_id = ${intoId} where person_id = ${fromId} returning id`;
    const interactionsRepointed = repointedInteractions.length;

    // 3. Repoint edges on both sides, drop self-referential edges the repoint creates, and
    // de-dupe collisions — copied from retypeOrgToPerson's edge-repoint logic (step 3 above).
    await tx`
      update edges set src_id = ${intoId} where src_type = 'person' and src_id = ${fromId}`;
    await tx`
      update edges set dst_id = ${intoId} where dst_type = 'person' and dst_id = ${fromId}`;
    // drop self-referential edges created by the repoint (e.g. "X knows X")
    await tx`delete from edges where src_id = ${intoId} and dst_id = ${intoId}
             and src_type = 'person' and dst_type = 'person'`;
    // De-dupe edges that now collide. Privacy strength wins (tier 0, then 2, then 1);
    // age is only the tie-breaker, so repair can never discard quarantine evidence.
    await tx`
      delete from edges e using edges k
      where e.src_type = k.src_type and e.src_id = k.src_id and e.rel = k.rel
        and e.dst_type = k.dst_type and e.dst_id = k.dst_id
        and (
          (case e.tier when 0 then 3 else e.tier end) <
            (case k.tier when 0 then 3 else k.tier end)
          or (
            (case e.tier when 0 then 3 else e.tier end) =
              (case k.tier when 0 then 3 else k.tier end)
            and (e.created_at, e.id) > (k.created_at, k.id)
          )
        )
        and (e.src_id = ${intoId} or e.dst_id = ${intoId})`;
    // edges_repointed is a live post-cleanup snapshot — edges still touching the target AFTER
    // both the self-loop delete and the collision de-dupe above — not a raw count of rows the
    // repoint UPDATEs touched. Matches retypeOrgToPerson's edgesRepointed (repo.ts:1166-1168) so
    // the shared `edges_repointed` audit key (scripts/repair.ts REPAIR_SUMMARY_COUNT_KEYS,
    // src/util/audit-payload.ts RepairCompleteCounts) means the same thing regardless of which
    // repair produced the event: an edge repointed and then immediately dropped as a self-loop
    // or a losing collision must not be reported as still referencing the target.
    const [edgeCntRow] = await tx`
      select count(*)::int n from edges where src_id = ${intoId} or dst_id = ${intoId}`;
    const edgesRepointed = ((edgeCntRow as any)?.n ?? 0) as number;

    // 4. Target absorbs the source's relation/context/last-contact; supersedes_id records only
    // the FIRST ancestor (coalesce) — a target merged into more than once keeps its original
    // pointer, matching retypeOrgToPerson's own coalesce behavior. W4-1 identity/content tier
    // split: the target's own identity tier is no longer raised to the source's tier
    // (greatest(tier, sourceTier)) — folding in a more-privately-evidenced source must not push a
    // publicly-known identity's own card out of tier-1 reach, mirroring
    // resolve_or_promote_entity's "resolving an existing identity never promotes it" rule
    // (037_identity_content_tier_split.sql). The tier-0 quarantine absorb stays unconditional —
    // and, same as retypeOrgToPerson above, is unreachable in practice here since the guard above
    // this block already refuses a merge that crosses the tier-0 boundary, so source and target
    // always already share tier-0-ness or both sit in {1,2} by the time this UPDATE runs.
    await tx`
      update people
      set relation = coalesce(relation, ${sourceRelation}),
          context = coalesce(context, ${sourceContext}),
          last_contact_at = greatest(last_contact_at, ${sourceLastContactAt}),
          tier = case when tier = 0 or ${sourceTier}::smallint = 0 then 0 else tier end,
          supersedes_id = coalesce(supersedes_id, ${fromId})
      where id = ${intoId}`;

    // 5. Supersede the source (I5: kept, never deleted) — shared helper with minime_correct
    // (W2-4); stamps superseded_by/superseded_at under the same idempotency guard.
    await supersedeRow("person", fromId, intoId);

    // 6. Auto-resolve any open phantom_person flag on the row that no longer independently
    // exists — it would otherwise sit open forever pointing at a now-superseded husk.
    await tx`
      update review_queue
      set status = 'resolved', resolved_at = ${now()}
      where status = 'open' and kind = 'phantom_person'
        and payload ->> 'person_id' = ${fromId}`;

    return { fromId, intoId, aliasesMoved, interactionsRepointed, edgesRepointed };
  });
}

// Read-only DB-wide screen for the mis-typed-entity class. Flags (never auto-fixes):
//   - org_should_be_person: an extractor-minted org whose name has no org cue and is
//     referenced by a person-relation context (a 2-token capitalized personal name).
//   - person_from_pronoun: a person row whose name is a bare pronoun (She/He/They/...).
// Conservative by design: only `system:extract` rows are candidates, never human-confirmed.
//
// Two false-positive filters keep fictional orgs that merely LOOK like a personal name
// ("Marble Lantern", "Cobalt Meadow") off the screen:
//   1. workplace signal (automatic): an org that is the `works_at` destination of >= 2
//      DISTINCT people is a real multi-person workplace — a person is never that. This
//      excludes "Marble Lantern" (3 employees) with zero curation.
//   2. owner allow-list (curated): names listed in $MINIME_DATA_DIR/known-orgs.txt are
//      never flagged. For the irreducible semantic cases — a single-employee institution
//      like "Cobalt Meadow" is structurally identical to a mistyped person ("Sigrid
//      Halvorsen"), so only a human can disambiguate. Mirrors the non-org-terms.txt
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
  // excluded — they are ambiguous brand-vs-surname (e.g. "Fjordsonics", "Glasswing") and produce
  // false positives on a review screen. The `>= 2 distinct works_at people` workplace
  // signal is applied below in JS (per-org distinct count) so the rule stays readable.
  const orgs = await db()`
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
  const people = await db()`
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
// personal name ("Marble Lantern", "Cobalt Meadow"). Loaded from
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
  // Forward pointer stamped on a correction's successor row (minime_correct, W2-4) — the same
  // supersedes_id column retypeOrgToPerson already uses for its own successor person rows.
  supersedesId?: string | null;
  tier?: number;
}

export interface PageSnapshot {
  id: string;
  path: string;
  title: string;
  body_md: string;
  content_hash: string;
  tier: number;
  status: "active" | "deleted";
  source: string;
  created_by: string;
  derived_from: string | null;
  updated_at: Date;
}

export interface PageChunkSnapshot {
  id: string;
  parent_type: ParentType;
  parent_id: string;
  ord: number;
  text: string;
  tier: number;
  updated_at: Date;
}

export interface UpsertPageInput {
  path: string;
  title: string;
  bodyMd: string;
  contentHash: string;
  tier?: number;
  createdBy?: string;
  source?: string;
  derivedFrom?: string | null;
  // Forward pointer for a correction's successor page (minime_correct, W2-4); only meaningful on
  // the insert branch below — a correction successor always mints a fresh path, never upserts an
  // existing one, so the update branch never sees it.
  supersedesId?: string | null;
}

export interface CompiledSourceEvidence {
  requested_ids: string[];
  resolved: {
    id: string;
    tier: number;
    parent_type: ParentType;
    parent_id: string;
    chunk_ord: number;
    chunk_updated_at: Date;
    mention_created_at: Date | null;
    entity_refs: CompiledNoteIdentity[];
    parent_tier: number | null;
    entity_min_tier: number | null;
    entity_max_tier: number | null;
    evidence_unresolved: boolean;
    min_tier: number;
    max_tier: number;
  }[];
  unresolved_ids: string[];
  owner_entities: CompiledNoteIdentity[];
  min_tier: number | null;
  max_tier: number | null;
  latest_mention_at: Date | null;
  representative_parent_id: string | null;
}

export interface CompiledRepresentationTierEvidence {
  page_tier: number;
  chunk_min_tier: number | null;
  chunk_max_tier: number | null;
  edge_max_tier: number | null;
  edge_min_tier: number | null;
  entity_min_tier: number | null;
  entity_max_tier: number | null;
  evidence_unresolved: boolean;
  min_tier: number;
  max_tier: number;
  edge_count: number;
}

const PAGE_SNAPSHOT_COLUMNS = db()`p.id, p.path, p.title, p.body_md, p.content_hash,
  p.tier, p.status, p.source, p.created_by, p.derived_from, p.updated_at`;

function mapPageSnapshot(row: any): PageSnapshot {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    body_md: row.body_md,
    content_hash: row.content_hash,
    tier: Number(row.tier),
    status: row.status,
    source: row.source,
    created_by: row.created_by,
    derived_from: row.derived_from ?? null,
    updated_at: new Date(row.updated_at),
  };
}

export async function pageByPath(path: string): Promise<PageSnapshot | null> {
  const rows =
    await db()`select ${PAGE_SNAPSHOT_COLUMNS} from pages p where p.path = ${path} limit 1`;
  return rows[0] ? mapPageSnapshot(rows[0]) : null;
}

export async function pageById(id: string): Promise<PageSnapshot | null> {
  const rows = await db()`select ${PAGE_SNAPSHOT_COLUMNS} from pages p where p.id = ${id} limit 1`;
  return rows[0] ? mapPageSnapshot(rows[0]) : null;
}

export async function activePagesForCompiledNoteReconciliation(): Promise<PageSnapshot[]> {
  const rows = await db()`select ${PAGE_SNAPSHOT_COLUMNS} from pages p where p.status = 'active'`;
  return rows.map(mapPageSnapshot);
}

export async function pageChunkSnapshot(pageId: string): Promise<PageChunkSnapshot[]> {
  const rows = await db()`
    select id, parent_type, parent_id, ord, text, tier, updated_at
    from chunks where parent_type = 'page' and parent_id = ${pageId}
    order by ord, id`;
  return rows.map((row: any) => ({
    id: row.id,
    parent_type: row.parent_type as ParentType,
    parent_id: row.parent_id,
    ord: Number(row.ord),
    text: row.text,
    tier: Number(row.tier),
    updated_at: new Date(row.updated_at),
  }));
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
  // Generate the identifier client-side.  A locked tier-2 INSERT is allowed, but PostgreSQL's
  // INSERT ... RETURNING applies the SELECT RLS policy and would therefore return no row.
  const id = crypto.randomUUID();
  await db()`
    insert into journal_entries
      (id, at, entry_md, mood, energy, created_by, source, derived_from, supersedes_id, tier)
    values (${id}, ${e.at ?? now()}, ${e.entryMd}, ${e.mood ?? null}, ${e.energy ?? null},
            ${e.createdBy ?? "human"}, ${e.source ?? "manual"}, ${e.derivedFrom ?? null},
            ${e.supersedesId ?? null}, ${e.tier ?? 2})`;
  return { id };
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
  await withDbTransaction(async (tx) => {
    await tx`
      insert into decisions (id, question, options, criteria, choice, reasoning, expected_outcome,
                             falsifier, stakes, reversibility, confidence,
                             decided_at, review_at, created_by, source, derived_from,
                             supersedes_id, tier)
      values (${decisionId}, ${d.question}, ${db().json(d.options as any)}, ${d.criteria ? db().json(d.criteria as any) : null},
              ${d.choice ?? null}, ${d.reasoning ?? null}, ${d.expectedOutcome ?? null},
              ${d.falsifier ?? null}, ${d.stakes ?? null}, ${d.reversibility ?? null},
              ${d.confidence ?? null},
              ${d.decidedAt ?? (d.choice ? now() : null)}, ${d.reviewAt ?? null},
              ${d.createdBy ?? "human"}, ${d.source ?? "manual"}, ${d.derivedFrom ?? null},
              ${d.supersedesId ?? null}, ${tier})`;

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
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by,
         source, created_by, derived_from)
      values ('decision', ${decisionId}, ${branchRel(b.status)}, 'decision_branch', ${branchId},
              'decision_branches', ${branchId}, ${d.createdBy ?? "human"},
              ${d.source ?? "manual"}, ${d.createdBy ?? "human"}, ${branchId})`;
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
  const rows =
    await db()`select * from decisions where id = ${id} and tier >= 1 and tier <= ${allowed}`;
  return rows[0] ?? null;
}

export async function getDecisionTranscript(id: string, actor?: AccessActor): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return db()`
    select id, decision_id, ord, question_key, prompt, answer, at, created_at, created_by, source, tier
    from decision_transcripts
    where decision_id = ${id} and tier >= 1 and tier <= ${allowed}
    order by ord` as any;
}

export async function getDecisionBranches(id: string, actor?: AccessActor): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return db()`
    select id, decision_id, label, status, note, would_be_right_if, created_at, updated_at,
           created_by, source, tier
    from decision_branches
    where decision_id = ${id} and tier >= 1 and tier <= ${allowed}
    order by created_at, id` as any;
}

export async function decisionBranchesForIndex(id: string): Promise<any[]> {
  return db()`
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
): Promise<{ principleId: string | null; principleTier: 1 | 2 | null }> {
  let principleId: string | null = null;
  let principleTier: 1 | 2 | null = null;
  await withDbTransaction(async (tx) => {
    const [dec] = await tx`update decisions
               set actual_outcome = ${actualOutcome}, reviewed_at = ${now()},
                   outcome_score = coalesce(${outcomeScore ?? null}, outcome_score)
                           where id = ${id} returning id, tier`;
    if (!dec) throw new Error("decision not found");
    if (dec.tier !== 1 && dec.tier !== 2) throw new Error("decision tier is not readable prose");
    if (lesson) {
      const [p] = await tx`
        insert into principles
          (rule, learned_from_decision, created_by, source, derived_from, tier)
        values (${lesson}, ${id}, ${actor}, 'review', ${id}, ${dec.tier})
        returning id, tier`;
      principleId = p!.id;
      principleTier = p!.tier as 1 | 2;
      await tx`update decisions set principle_id = ${principleId} where id = ${id}`;
      await tx`insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by,
         source, created_by, derived_from)
        values ('principle', ${principleId}, 'learned_from', 'decision', ${id},
                'decisions', ${id}, ${actor}, 'review', ${actor}, ${id})`;
    }
  });
  return { principleId, principleTier };
}

export class TaskNotFoundError extends Error {
  constructor() {
    super("task not found");
  }
}

// The row shape materializeRecurrence needs from the task that just went done: the fields its
// successor copies verbatim (title/body/goal_id/tier/recur_*) plus the due it computes nextDue
// from and the superseded_at guard. due/recur_anchor come back from postgres.js as Date for a
// plain `date` column (never a process-local getter — see clock.ts's own note on this), hence
// metricDateString below rather than a bare .toISOString() call at each use site.
export interface RecurringTaskRow {
  id: string;
  title: string;
  body: string | null;
  due: Date | string | null;
  goal_id: string | null;
  tier: number;
  recur_freq: string | null;
  recur_interval: number;
  recur_anchor: Date | string | null;
  superseded_at?: Date | string | null;
}

// Mint the next instance of a completed recurring task, unless one already exists (idempotent —
// both upsertTask's own done-transition check and the dream sweeper's crash-safety backfill call
// this for the same row shape). Assumes an ambient transaction from the caller: the existence
// check and the insert must commit together, or a crash between them could double-materialize.
// recur_anchor is copied VERBATIM, never recomputed from the successor's own (possibly
// end-of-month-clamped) due — see recurrence.ts's nextMonthCycle comment for why re-deriving it
// from a clamped date would permanently downgrade a monthly-on-the-31st habit to the 28th.
export async function materializeRecurrence(task: RecurringTaskRow): Promise<string | null> {
  if (!task.recur_freq) return null;
  const [existing] = await db()`
    select 1 from tasks where derived_from = ${task.id} and source = 'recurrence' limit 1`;
  if (existing) return null;
  const fromDue = task.due !== null ? metricDateString(task.due) : todayStr();
  const anchor = task.recur_anchor !== null ? metricDateString(task.recur_anchor) : null;
  const due = nextDue(task.recur_freq as RecurFreq, task.recur_interval, anchor, fromDue);
  const id = crypto.randomUUID();
  await db()`
    insert into tasks
      (id, title, body, status, due, goal_id, tier, recur_freq, recur_interval, recur_anchor,
       created_by, source, derived_from)
    values
      (${id}, ${task.title}, ${task.body}, 'inbox', ${due}::date, ${task.goal_id}, ${task.tier},
       ${task.recur_freq}, ${task.recur_interval}, ${anchor}::date,
       'system:recurrence', 'recurrence', ${task.id})`;
  return id;
}

// Crash-safety net for the dream sweeper (step 5b): done recurring tasks with no recurrence
// successor yet. Normally empty — upsertTask's own done-transition materializes inside the same
// transaction as the completing update — this only finds work after a status='done' write that
// bypassed upsertTask entirely. superseded_at is null excludes a corrected-away row from ever
// spawning a fresh successor (tasks are out of scope for minime_correct today, so this cannot
// currently happen, but the guard costs nothing and matches every other PARENTS-table read).
export async function recurringTasksNeedingSuccessor(): Promise<RecurringTaskRow[]> {
  return db()`
    select t.id, t.title, t.body, t.due, t.goal_id, t.tier, t.recur_freq, t.recur_interval,
           t.recur_anchor
    from tasks t
    where t.recur_freq is not null
      and t.status = 'done'
      and t.superseded_at is null
      and not exists (
        select 1 from tasks s where s.derived_from = t.id and s.source = 'recurrence'
      )
    order by t.completed_at nulls last, t.id` as any;
}

export async function upsertTask(
  t: {
    id?: string | null;
    title?: string | null;
    body?: string | null;
    status?: string | null;
    due?: string | null;
    goalId?: string | null;
    // recur_freq is three-state like due/goalId below (undefined=keep, null=clear); recur_
    // interval is plain coalesce (no clear semantic — meaningless without recur_freq, and the
    // column is not-null so there is nothing to clear it TO). recurAnchor has no update path at
    // all: minime_upsert_task never exposes it, so it is set once (create-time default from due,
    // or an explicit override for internal/test callers) and never touched again.
    recurFreq?: string | null;
    recurInterval?: number | null;
    recurAnchor?: string | null;
  } & Std,
): Promise<{ id: string; title: string; body: string | null }> {
  if (t.id) {
    // Captured into a local: narrowing `t.id` from `if (t.id)` does not survive into the
    // withDbTransaction closure below (TS drops property narrowing across a function boundary).
    const taskId = t.id;
    // due/goal_id/recur_freq are three-state at this boundary: undefined (key omitted) means
    // KEEP, explicit null means CLEAR. coalesce() can't tell those apart (coalesce(null, col) is
    // always "keep"), so the provided-flags carry the distinction into the SQL explicitly.
    const dueProvided = t.due !== undefined;
    const goalIdProvided = t.goalId !== undefined;
    const recurFreqProvided = t.recurFreq !== undefined;
    return withDbTransaction(async (tx) => {
      // First SELECT (locking) the prior status: completing two concurrent "mark done" calls on
      // the same row must materialize exactly one successor. The second call's SELECT blocks on
      // this row lock until the first commits, then reads status='done' post-commit — so at most
      // one caller ever observes a false->done transition for a given completion.
      const [prior] = await tx`select status from tasks where id = ${taskId} for update`;
      if (!prior) throw new TaskNotFoundError();
      const wasDone = prior.status === "done";
      const [row] = await tx`
        update tasks set title = coalesce(${t.title ?? null}, title),
                         body = coalesce(${t.body ?? null}, body),
                         status = coalesce(${t.status ?? null}, status),
                         due = case when ${dueProvided} then ${t.due ?? null}::date else due end,
                         goal_id = case when ${goalIdProvided} then ${t.goalId ?? null}::uuid else goal_id end,
                         recur_freq = case when ${recurFreqProvided} then ${t.recurFreq ?? null}::text else recur_freq end,
                         recur_interval = coalesce(${t.recurInterval ?? null}::int, recur_interval),
                         completed_at = case when ${t.status ?? null} = 'done' then ${now()}
                                             when ${t.status ?? null}::text is not null then null
                                             else completed_at end
        where id = ${taskId}
        returning id, title, body, status, due, goal_id, tier, recur_freq, recur_interval,
                  recur_anchor, superseded_at`;
      if (!row) throw new TaskNotFoundError();
      if (!wasDone && row.status === "done" && row.superseded_at === null) {
        await materializeRecurrence(row as RecurringTaskRow);
      }
      return row as any;
    });
  }
  const id = crypto.randomUUID();
  // Non-goal: no inbox-capture syntax for recurrence, so the only "on create" source for a
  // phase anchor is the due date supplied in this same call.
  const recurAnchor = t.recurAnchor ?? (t.recurFreq && t.due ? t.due : null);
  const [row] = await db()`
    insert into tasks (id, title, body, status, due, goal_id, created_by, source, derived_from, tier,
                        completed_at, recur_freq, recur_interval, recur_anchor)
    values (${id}, ${t.title ?? null}, ${t.body ?? null}, ${t.status ?? "inbox"}, ${t.due ?? null}, ${t.goalId ?? null},
            ${t.createdBy ?? "human"}, ${t.source ?? "manual"}, ${t.derivedFrom ?? null}, ${t.tier ?? 1},
            ${t.status === "done" ? now() : null},
            ${t.recurFreq ?? null}, ${t.recurInterval ?? 1}, ${recurAnchor}::date)
    returning id, title, body`;
  return row as any;
}

// An interaction attaches to EXACTLY ONE subject: a person OR an org (XOR enforced
// by the interactions_subject_xor CHECK in 013_interactions_org.sql). Org-keyed
// interactions are how vendors/institutions get history without minting a phantom
// person row (the root cause of the phantom-org audit churn).
export async function insertInteraction(
  i: {
    id?: string;
    personId?: string;
    orgId?: string;
    kind: string;
    summary: string;
    occurredAt?: Date;
  } & Std,
): Promise<{ id: string }> {
  if ((i.personId ? 1 : 0) + (i.orgId ? 1 : 0) !== 1) {
    throw new Error("insertInteraction requires exactly one of personId or orgId");
  }
  const at = i.occurredAt ?? now();
  // See insertJournal: avoid RETURNING on a locked tier-2 write, while retaining a stable id
  // for the interaction's graph edge and the caller's receipt.
  const id = i.id ?? crypto.randomUUID();
  await db()`
    insert into interactions
      (id, person_id, org_id, kind, summary, occurred_at, created_by, source, derived_from,
       supersedes_id, tier)
    values (${id}, ${i.personId ?? null}, ${i.orgId ?? null}, ${i.kind}, ${i.summary}, ${at},
            ${i.createdBy ?? "human"}, ${i.source ?? "manual"}, ${i.derivedFrom ?? null},
            ${i.supersedesId ?? null}, ${i.tier ?? 2})`;
  if (i.personId) {
    await touchLastContact(i.personId, at);
    await db()`insert into edges
              (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by,
               source, created_by, derived_from)
              values ('interaction', ${id}, 'involves', 'person', ${i.personId},
                      'interactions', ${id}, ${i.createdBy ?? "human"}, ${i.source ?? "manual"},
                      ${i.createdBy ?? "human"}, ${id})`;
  } else {
    await db()`insert into edges
              (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by,
               source, created_by, derived_from)
              values ('interaction', ${id}, 'involves', 'org', ${i.orgId ?? null},
                      'interactions', ${id}, ${i.createdBy ?? "human"}, ${i.source ?? "manual"},
                      ${i.createdBy ?? "human"}, ${id})`;
  }
  return { id };
}

export async function insertPrinciple(
  p: { rule: string; domain?: string | null } & Std,
): Promise<{ id: string }> {
  const [row] = await db()`
    insert into principles (rule, domain, created_by, source)
    values (${p.rule}, ${p.domain ?? null}, ${p.createdBy ?? "human"}, ${p.source ?? "manual"})
    returning id`;
  return row as any;
}

// W3-13: insertCommitment's first production caller (minime_log_interaction's promise param)
// needs full I5 provenance, so tier/derived_from are now persisted rather than silently dropped
// -- the demo seed's own calls (fixtures/seed.ts) pass neither and keep defaulting to tier 1 /
// no derivation, unchanged from before.
export async function insertCommitment(
  c: {
    what: string;
    toWhom: string;
    due?: string | null;
    status?: string;
  } & Std,
): Promise<{ id: string }> {
  // Generate the identifier client-side, matching insertJournal/insertInteraction: a locked
  // tier-2 INSERT is allowed (tier_write's WITH CHECK is unconditional), but PostgreSQL also
  // applies the table's SELECT policy to a RETURNING row, and raises "new row violates row-level
  // security policy" -- not a silent empty result -- when that check fails. minime_log_interaction's
  // promise capture (036_commitment_update_grant.sql / interactions.ts) is the first caller that
  // can hit this: it inserts a commitment at tier 2, the interaction's own tier, and a locked
  // session's app_allowed_tier() is 1.
  const id = crypto.randomUUID();
  await db()`
    insert into commitments (id, what, to_whom, due, status, created_by, source, derived_from, tier)
    values (${id}, ${c.what}, ${c.toWhom}, ${c.due ?? null}, ${c.status ?? "open"},
            ${c.createdBy ?? "human"}, ${c.source ?? "manual"}, ${c.derivedFrom ?? null},
            ${c.tier ?? 1})`;
  return { id };
}

export class CommitmentNotFoundError extends Error {
  constructor() {
    super("commitment not found");
  }
}

export interface CommitmentRow {
  id: string;
  what: string;
  to_whom: string;
  due: string | Date | null;
  status: string;
  tier: number;
}

// id-only update: status/due are the only patchable fields -- what/to_whom are set once at
// creation and immutable via this path, mirroring updateGoal's own horizon-is-immutable design
// just below it. due is three-state like upsertTask's own due handling: omit the key to keep
// the existing due date, pass an explicit null to clear it (a promise renegotiated open-ended).
export async function updateCommitment(
  id: string,
  c: { status?: string | null; due?: string | null },
): Promise<CommitmentRow> {
  const dueProvided = c.due !== undefined;
  const [row] = await db()`
    update commitments set
      status = coalesce(${c.status ?? null}, status),
      due = case when ${dueProvided} then ${c.due ?? null}::date else due end
    where id = ${id}
    returning id, what, to_whom, due, status, tier`;
  if (!row) throw new CommitmentNotFoundError();
  return row as any;
}

// Internal write-path lookups only: the canonical name of a person/org this SAME call just
// ensured (ensurePerson/ensureOrg in minime_log_interaction's promise capture) -- this is
// bookkeeping for a write this call already has authority over, not an agent-facing read. Routed
// through the security-definer entity_canonical_name() (036_commitment_update_grant.sql), NOT a
// plain `select canonical_name from people/orgs where id = ...`: an ordinary select is subject to
// the CALLER's own tier_read RLS policy and would return zero rows for a locked caller reading
// back a brand-new tier-2 subject it just minted in this very call (proven by
// test/entity-tier-provenance.test.ts's restricted-role subprocess harness) -- resolvePerson/
// resolveOrg have the identical problem for the same reason, one level up in application code.
export async function personCanonicalName(id: string): Promise<string> {
  const [row] = await db()`select entity_canonical_name('person', ${id}::uuid) as name`;
  const name = row?.name as string | null | undefined;
  if (name === null || name === undefined) throw new Error("person_not_found_for_canonical_name");
  return name;
}

export async function orgCanonicalName(id: string): Promise<string> {
  const [row] = await db()`select entity_canonical_name('org', ${id}::uuid) as name`;
  const name = row?.name as string | null | undefined;
  if (name === null || name === undefined) throw new Error("org_not_found_for_canonical_name");
  return name;
}

export async function insertGoal(
  g: {
    horizon: string;
    statement: string;
    why?: string | null;
    parentId?: string | null;
  } & Std,
): Promise<{ id: string }> {
  const [row] = await db()`
    insert into goals (horizon, statement, why, parent_id, created_by, source)
    values (${g.horizon}, ${g.statement}, ${g.why ?? null}, ${g.parentId ?? null},
            ${g.createdBy ?? "human"}, ${g.source ?? "manual"})
    returning id`;
  return row as any;
}

export class GoalNotFoundError extends Error {
  constructor() {
    super("goal not found");
  }
}

export interface GoalRow {
  id: string;
  horizon: string;
  statement: string;
  why: string | null;
  status: string;
  parent_id: string | null;
  tier: number;
}

// id-only update: every field is optional and, omitted, keeps its current value (plain
// coalesce) -- the same "id-only means keep everything else" ergonomic upsertTask established,
// so marking a goal achieved never requires resending its statement (do NOT replicate
// upsertTask's own title-handling wart of indexing raw params instead of the stored row --
// goals.ts reads the RETURNING values below back into indexParent, never params). horizon is
// deliberately absent here: it is set once at creation and immutable via this path. parent_id is
// the one three-state field (undefined keeps, explicit null clears), matching upsertTask's own
// due/goal_id handling.
export async function updateGoal(
  id: string,
  g: {
    statement?: string | null;
    why?: string | null;
    status?: string | null;
    parentId?: string | null;
  },
): Promise<GoalRow> {
  const parentIdProvided = g.parentId !== undefined;
  const [row] = await db()`
    update goals set
      statement = coalesce(${g.statement ?? null}, statement),
      why = coalesce(${g.why ?? null}, why),
      status = coalesce(${g.status ?? null}, status),
      parent_id = case when ${parentIdProvided} then ${g.parentId ?? null}::uuid else parent_id end
    where id = ${id}
    returning id, horizon, statement, why, status, parent_id, tier`;
  if (!row) throw new GoalNotFoundError();
  return row as any;
}

// Onboarding re-run hint: a non-empty values table means the interview already ran once.
export async function valuesCount(): Promise<number> {
  const [r] = await db()`select count(*)::int as n from values_items`;
  return r!.n;
}

export async function insertValueItem(
  v: { statement: string; priority?: number; notes?: string | null } & Std,
): Promise<{ id: string }> {
  const [row] = await db()`
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
  source?: string;
  createdBy?: string;
  derivedFrom?: string | null;
  confidence?: number;
}): Promise<void> {
  const createdBy = e.createdBy ?? e.extractedBy ?? "human";
  await db()`
    insert into edges
      (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by,
       confidence, source, created_by, derived_from)
    values (${e.srcType}, ${e.srcId}, ${e.rel}, ${e.dstType}, ${e.dstId},
            ${e.sourceTable ?? null}, ${e.sourceId ?? null}, ${e.extractedBy ?? "human"},
            ${e.confidence ?? 1.0}, ${e.source ?? "manual"}, ${createdBy},
            ${e.derivedFrom ?? e.sourceId ?? null})`;
}

export async function upsertExtractedEdge(e: {
  srcType: string;
  srcId: string;
  rel: string;
  dstType: string;
  dstId: string;
  sourceTable: string;
  sourceId: string;
  confidence?: number;
}): Promise<boolean> {
  const [row] = await db()`select upsert_extracted_edge(
    ${e.srcType}, ${e.srcId}::uuid, ${e.rel}, ${e.dstType}, ${e.dstId}::uuid,
    ${e.sourceTable}, ${e.sourceId}::uuid, ${e.confidence ?? 1.0}::real
  ) as created`;
  return row?.created === true;
}

export async function sourceTierForParent(parentType: string, parentId: string): Promise<1 | 2> {
  const { table } = parentTable(parentType);
  const [row] = await db()`select readable_source_tier(${table}, ${parentId}::uuid)::int as tier`;
  const tier = Number(row?.tier);
  if (tier !== 1 && tier !== 2) throw new Error("extraction_source_provenance_invalid");
  return tier;
}

export async function deleteExtractedEdgesForSource(
  sourceTable: string,
  sourceId: string,
  extractedBy: string,
): Promise<number> {
  const rows = await db()`
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
  const rows = await db()`select 1 from edges where src_type = ${srcType} and src_id = ${srcId}
    and rel = ${rel} and dst_type = ${dstType} and dst_id = ${dstId} limit 1`;
  return rows.length > 0;
}

// ---------------------------------------------------------------- pages (brain sync)

export async function upsertPage(
  p: UpsertPageInput,
  options: {
    provenanceMode?: "preserve" | "replace";
    contentHashMode?: "replace" | "preserve-existing";
    tierMode?: "replace" | "promote";
  } = {},
): Promise<{ id: string; changed: boolean; created: boolean }> {
  const incomingTier = p.tier ?? 1;
  assertProseTier(incomingTier);
  const provenanceMode = options.provenanceMode ?? "preserve";
  const contentHashMode = options.contentHashMode ?? "replace";
  const tierMode = options.tierMode ?? "replace";
  const [existing] = await db()`
    select id, title, body_md, content_hash, tier, status, created_by, source, derived_from
    from pages where path = ${p.path}`;
  if (!existing) {
    const id = crypto.randomUUID();
    await db()`
      insert into pages
        (id, path, title, body_md, content_hash, tier, created_by, source, derived_from,
         supersedes_id)
      values (${id}, ${p.path}, ${p.title}, ${p.bodyMd}, ${p.contentHash}, ${incomingTier},
              ${p.createdBy ?? "human"}, ${p.source ?? "brain-sync"}, ${p.derivedFrom ?? null},
              ${p.supersedesId ?? null})`;
    return { id, changed: true, created: true };
  }
  const existingTier = Number(existing.tier);
  assertProseTier(existingTier);
  const nextTier = tierMode === "promote" ? Math.max(existingTier, incomingTier) : incomingTier;
  const nextHash = contentHashMode === "preserve-existing" ? existing.content_hash : p.contentHash;
  const provenanceChanged =
    provenanceMode === "replace" &&
    (existing.created_by !== (p.createdBy ?? "human") ||
      existing.source !== (p.source ?? "brain-sync") ||
      (existing.derived_from ?? null) !== (p.derivedFrom ?? null));
  const changed =
    existing.title !== p.title ||
    existing.body_md !== p.bodyMd ||
    existing.content_hash !== nextHash ||
    Number(existing.tier) !== nextTier ||
    existing.status !== "active" ||
    provenanceChanged;
  if (!changed) return { id: existing.id, changed: false, created: false };
  if (provenanceMode === "replace") {
    await db()`
      update pages set title = ${p.title}, body_md = ${p.bodyMd}, content_hash = ${nextHash},
        tier = ${nextTier}, status = 'active', created_by = ${p.createdBy ?? "human"},
        source = ${p.source ?? "brain-sync"}, derived_from = ${p.derivedFrom ?? null}
      where id = ${existing.id}`;
  } else {
    await db()`
      update pages set title = ${p.title}, body_md = ${p.bodyMd}, content_hash = ${nextHash},
        tier = ${nextTier}, status = 'active'
      where id = ${existing.id}`;
  }
  return { id: existing.id, changed: true, created: false };
}

export type GeneratedPageQuarantineResult =
  | { status: "missing" }
  | { status: "protected"; pageId: string }
  | { status: "quarantined"; pageId: string };

// Tier-zero quarantine is deliberately separate from ordinary upsert/index paths. It preserves
// prose/archive bytes and row identity while making every generated representation inert.
export async function quarantineGeneratedPageByPath(
  path: string,
): Promise<GeneratedPageQuarantineResult> {
  try {
    return await withDbTransaction(async (tx) => {
      const [page] = await tx`
        select id, source, created_by from pages where path = ${path} for update`;
      if (!page) return { status: "missing" } as const;
      const generated =
        page.source === "brain-sync" ||
        (page.source === COMPILED_NOTE_SOURCE && page.created_by === "system:dream");
      if (!generated) return { status: "protected", pageId: page.id } as const;
      const chunks = await tx`
        select id from chunks
        where parent_type = 'page' and parent_id = ${page.id}
        for update`;
      const chunkIds = chunks.map((row: any) => row.id as string);
      await tx`
        select id from edges
        where (source_table = 'pages' and source_id = ${page.id})
           or (src_type = 'page' and src_id = ${page.id})
           or (${chunkIds.length > 0}
               and source_table = 'chunks' and source_id = any(${chunkIds}::uuid[]))
        for update`;
      await tx`update pages set tier = 0, status = 'deleted' where id = ${page.id}`;
      await tx`
        update chunks set tier = 0, embedding = null, embed_model = null
        where parent_type = 'page' and parent_id = ${page.id}`;
      await tx`
        update edges set tier = 0
        where (source_table = 'pages' and source_id = ${page.id})
           or (src_type = 'page' and src_id = ${page.id})
           or (${chunkIds.length > 0}
               and source_table = 'chunks' and source_id = any(${chunkIds}::uuid[]))`;
      return { status: "quarantined", pageId: page.id } as const;
    });
  } catch {
    throw new Error("TIER0_QUARANTINE_FAILED");
  }
}

export async function softDeletePagesNotIn(
  paths: string[],
  options: { preserveSources?: string[]; preservePageIds?: string[] } = {},
): Promise<string[]> {
  const preserveSources = options.preserveSources ?? [];
  const preservePageIds = options.preservePageIds ?? [];
  const rows = await db()`
    update pages set status = 'deleted'
    where status = 'active'
      and not (path = any(${paths}))
      and not (source = any(${preserveSources}))
      and not (id = any(${preservePageIds}))
    returning id`;
  return rows.map((r: any) => r.id);
}

export async function setPageContentHash(pageId: string, hash: string): Promise<void> {
  await db()`update pages set content_hash = ${hash} where id = ${pageId}`;
}

export async function setPageTier(pageId: string, tier: 1 | 2): Promise<boolean> {
  assertProseTier(tier);
  return withDbTransaction(async (tx) => {
    await tx`select id from pages where id = ${pageId} for update`;
    const [page] = await tx`select tier from pages where id = ${pageId}`;
    if (page) assertProseTier(Number(page.tier));
    const rows = await tx`
      update pages set tier = greatest(tier, ${tier})
      where id = ${pageId} and tier < ${tier}
      returning id`;
    return rows.length > 0;
  });
}

export async function setPageChunkTiers(pageId: string, tier: 1 | 2): Promise<number> {
  assertProseTier(tier);
  return withDbTransaction(async (tx) => {
    await tx`select id from pages where id = ${pageId} for update`;
    const [page] = await tx`select tier from pages where id = ${pageId}`;
    if (page) assertProseTier(Number(page.tier));
    const existing = await tx`
      select tier from chunks where parent_type = 'page' and parent_id = ${pageId} for update`;
    for (const chunk of existing) assertProseTier(Number(chunk.tier));
    const rows = await tx`
      update chunks set tier = greatest(tier, ${tier})
      where parent_type = 'page' and parent_id = ${pageId} and tier < ${tier}
      returning id`;
    return rows.length;
  });
}

export async function retierPageEdges(pageId: string, tier: 1 | 2): Promise<number> {
  assertProseTier(tier);
  return withDbTransaction(async (tx) => {
    await tx`select id from pages where id = ${pageId} for update`;
    const [page] = await tx`select tier from pages where id = ${pageId}`;
    if (page) assertProseTier(Number(page.tier));
    const existing = await tx`
      select tier from edges
      where ((source_table = 'pages' and source_id = ${pageId})
          or (src_type = 'page' and src_id = ${pageId}))
      for update`;
    for (const edge of existing) assertProseTier(Number(edge.tier));
    const rows = await tx`
      update edges set tier = greatest(tier, ${tier})
      where ((source_table = 'pages' and source_id = ${pageId})
          or (src_type = 'page' and src_id = ${pageId}))
        and tier < ${tier}
      returning id`;
    return rows.length;
  });
}

export async function compiledRepresentationTierEvidence(
  pageId: string,
): Promise<CompiledRepresentationTierEvidence> {
  const [row] = await db()`
    with target_page as (
      select id, tier from pages where id = ${pageId}
    ), page_chunks as (
      select c.id, c.tier
      from chunks c join target_page p on c.parent_type = 'page' and c.parent_id = p.id
    ), relevant_edges as (
      select e.tier,
        case
          when e.dst_type = 'person' then pp.tier
          when e.dst_type = 'org' then oo.tier
          else null
        end as entity_tier,
        (e.dst_type in ('person', 'org') and coalesce(pp.id, oo.id) is null) as entity_unresolved
      from edges e
      cross join target_page p
      left join people pp on e.dst_type = 'person' and e.dst_id = pp.id
      left join orgs oo on e.dst_type = 'org' and e.dst_id = oo.id
      where (e.source_table = 'pages' and e.source_id = p.id)
         or (e.src_type = 'page' and e.src_id = p.id)
         or (e.source_table = 'chunks'
             and e.source_id = any(coalesce((select array_agg(id) from page_chunks), array[]::uuid[])))
    )
    select p.tier as page_tier,
      (select min(tier) from page_chunks) as chunk_min_tier,
      (select max(tier) from page_chunks) as chunk_max_tier,
      (select min(tier) from relevant_edges) as edge_min_tier,
      (select max(tier) from relevant_edges) as edge_max_tier,
      (select min(entity_tier) from relevant_edges) as entity_min_tier,
      (select max(entity_tier) from relevant_edges) as entity_max_tier,
      coalesce((select bool_or(entity_unresolved) from relevant_edges), false)
        as evidence_unresolved,
      (select count(*)::int from relevant_edges) as edge_count
    from target_page p`;
  const pageTier = Number(row?.page_tier ?? 1);
  const chunkMin = row?.chunk_min_tier == null ? null : Number(row.chunk_min_tier);
  const chunkMax = row?.chunk_max_tier == null ? null : Number(row.chunk_max_tier);
  const edgeMax = row?.edge_max_tier == null ? null : Number(row.edge_max_tier);
  const edgeMin = row?.edge_min_tier == null ? null : Number(row.edge_min_tier);
  const entityMin = row?.entity_min_tier == null ? null : Number(row.entity_min_tier);
  const entityMax = row?.entity_max_tier == null ? null : Number(row.entity_max_tier);
  const tiers = evidenceTier(
    [pageTier, chunkMin, chunkMax, edgeMin, edgeMax, entityMin, entityMax].filter(
      (tier): tier is number => tier !== null,
    ),
  );
  return {
    page_tier: pageTier,
    chunk_min_tier: chunkMin,
    chunk_max_tier: chunkMax,
    edge_max_tier: edgeMax,
    edge_min_tier: edgeMin,
    entity_min_tier: entityMin,
    entity_max_tier: entityMax,
    evidence_unresolved: Boolean(row?.evidence_unresolved),
    min_tier: tiers.min ?? pageTier,
    max_tier: tiers.max ?? pageTier,
    edge_count: Number(row?.edge_count ?? 0),
  };
}

export async function compiledSourceEvidence(sourceIds: string[]): Promise<CompiledSourceEvidence> {
  const requested_ids = [...new Set(sourceIds.map((id) => id.toLowerCase()))];
  if (requested_ids.length === 0) {
    return {
      requested_ids,
      resolved: [],
      unresolved_ids: [],
      owner_entities: [],
      min_tier: null,
      max_tier: null,
      latest_mention_at: null,
      representative_parent_id: null,
    };
  }
  const chunks = (await db()`
    select requested.ord, requested.id as requested_id,
           c.id, c.tier, c.parent_type, c.parent_id, c.ord as chunk_ord,
           c.updated_at, c.text, ${COMPILED_PARENT_TIER(db())} as parent_tier
    from unnest(${requested_ids}::uuid[]) with ordinality requested(id, ord)
    left join chunks c on c.id = requested.id
    order by requested.ord`) as any[];
  const present = chunks.filter((row) => row.id);
  const presentIds = present.map((row) => row.id as string);
  const ownerRows =
    presentIds.length === 0
      ? []
      : ((await db()`
    select e.source_table, e.source_id, e.src_type, e.src_id, e.dst_type, e.dst_id,
           e.created_at, e.tier,
           coalesce(pp.canonical_name, oo.canonical_name) as entity_name,
           pa.alias as person_alias, oa.alias as org_alias,
           pa.tier as person_alias_tier, oa.tier as org_alias_tier,
           coalesce(pp.tier, oo.tier) as entity_tier
    from edges e
    left join people pp on e.dst_type = 'person' and e.dst_id = pp.id
    left join person_aliases pa on pa.person_id = pp.id and pa.tier in (1,2)
    left join orgs oo on e.dst_type = 'org' and e.dst_id = oo.id
    left join org_aliases oa on oa.org_id = oo.id and oa.tier in (1,2)
    where e.rel = 'mentions'
      and ((e.source_table = 'chunks' and e.source_id = any(${presentIds}::uuid[]))
       or exists (
         select 1 from chunks pc where pc.id = any(${presentIds}::uuid[])
           and e.src_type = pc.parent_type and e.src_id = pc.parent_id
       ))`) as any[]);
  const byChunk = new Map<
    string,
    {
      entities: Map<string, CompiledNoteIdentity>;
      latest: Date | null;
      acceptedEdgeTiers: number[];
      acceptedEntityTiers: number[];
      unresolvedOwner: boolean;
    }
  >();
  for (const row of present)
    byChunk.set(row.id, {
      entities: new Map(),
      latest: null,
      acceptedEdgeTiers: [],
      acceptedEntityTiers: [],
      unresolvedOwner: false,
    });
  for (const edge of ownerRows) {
    if (edge.dst_type !== "person" && edge.dst_type !== "org") continue;
    const entityName = edge.entity_name as string | null;
    const entityTier = edge.entity_tier == null ? null : Number(edge.entity_tier);
    const readableNames = [
      { name: entityName, tier: entityTier },
      { name: edge.person_alias, tier: Number(edge.person_alias_tier) },
      { name: edge.org_alias, tier: Number(edge.org_alias_tier) },
    ].filter(
      (entry): entry is { name: string; tier: number } =>
        typeof entry.name === "string" &&
        entry.name.trim().length > 0 &&
        (entry.tier === 1 || entry.tier === 2),
    );
    for (const chunk of present) {
      const chunkAnchored = edge.source_table === "chunks" && edge.source_id === chunk.id;
      const parentAnchored = edge.src_type === chunk.parent_type && edge.src_id === chunk.parent_id;
      const matchedNameTiers = readableNames
        .filter(({ name }) => ownershipNameMatches(chunk.text, name))
        .map(({ tier }) => tier);
      const literalOwner = matchedNameTiers.length > 0;
      if (parentAnchored && entityTier === null) byChunk.get(chunk.id)!.unresolvedOwner = true;
      if (!chunkAnchored && !(parentAnchored && literalOwner)) continue;
      if (entityTier !== 1 && entityTier !== 2) continue;
      const bucket = byChunk.get(chunk.id)!;
      const key = `${edge.dst_type}:${edge.dst_id}`;
      bucket.entities.set(key, { kind: edge.dst_type, entityId: edge.dst_id });
      bucket.acceptedEntityTiers.push(entityTier);
      bucket.acceptedEntityTiers.push(...matchedNameTiers);
      const at = edge.created_at ? new Date(edge.created_at) : null;
      if (at && (!bucket.latest || at > bucket.latest)) bucket.latest = at;
      bucket.acceptedEdgeTiers.push(Number(edge.tier));
    }
  }
  const resolved = present.map((row) => {
    const bucket = byChunk.get(row.id)!;
    const parentTier = row.parent_tier == null ? null : Number(row.parent_tier);
    const entityTiers = evidenceTier(bucket.acceptedEntityTiers);
    const levels = [
      Number(row.tier),
      ...bucket.acceptedEdgeTiers,
      ...bucket.acceptedEntityTiers,
      ...(parentTier === null ? [] : [parentTier]),
    ];
    return {
      id: row.id,
      tier: Number(row.tier),
      parent_type: row.parent_type as ParentType,
      parent_id: row.parent_id,
      chunk_ord: Number(row.chunk_ord),
      chunk_updated_at: new Date(row.updated_at),
      mention_created_at: bucket.latest,
      entity_refs: [...bucket.entities.values()],
      parent_tier: parentTier,
      entity_min_tier: entityTiers.min,
      entity_max_tier: entityTiers.max,
      evidence_unresolved: parentTier === null || bucket.unresolvedOwner,
      min_tier: Math.min(...levels),
      max_tier: Math.max(...levels),
    };
  });
  resolved.sort(
    (a, b) =>
      a.chunk_updated_at.getTime() - b.chunk_updated_at.getTime() ||
      a.chunk_ord - b.chunk_ord ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const unresolved_ids = [
    ...new Set([
      ...chunks.filter((row) => !row.id).map((row) => row.requested_id as string),
      ...resolved.filter((row) => row.evidence_unresolved).map((row) => row.id),
    ]),
  ];
  const ownerMap = new Map<string, CompiledNoteIdentity>();
  for (const row of resolved)
    for (const entity of row.entity_refs) ownerMap.set(`${entity.kind}:${entity.entityId}`, entity);
  const latest = resolved.reduce<Date | null>((max, row) => {
    if (!row.mention_created_at) return max;
    return !max || row.mention_created_at > max ? row.mention_created_at : max;
  }, null);
  const tiers = evidenceTier(resolved.flatMap((row) => [row.min_tier, row.max_tier]));
  return {
    requested_ids,
    resolved,
    unresolved_ids,
    owner_entities: [...ownerMap.values()],
    min_tier: tiers.min,
    max_tier: tiers.max,
    latest_mention_at: latest,
    representative_parent_id: resolved[0]?.parent_id ?? null,
  };
}

async function excludedDerivedPageIdsForCompiledNoteSources(): Promise<string[]> {
  const pages = await activePagesForCompiledNoteReconciliation();
  return pages
    .filter(
      (page) =>
        page.source === "dream:decision-digest" ||
        recognizeCompiledNote({ path: page.path, source: page.source, bodyMd: page.body_md })
          .recognized,
    )
    .map((page) => page.id);
}

export async function compiledEntityClusterEvidence(identities: CompiledNoteIdentity[]): Promise<{
  source_chunk_ids: string[];
  min_tier: number | null;
  max_tier: number | null;
  evidence_unresolved: boolean;
  latest_mention_at: Date | null;
}> {
  if (identities.length === 0)
    return {
      source_chunk_ids: [],
      min_tier: null,
      max_tier: null,
      evidence_unresolved: true,
      latest_mention_at: null,
    };
  const ids = [...new Set(identities.map((identity) => identity.entityId))];
  const excluded = await excludedDerivedPageIdsForCompiledNoteSources();
  const rows = (await db()`
    select distinct c.id, c.text, c.tier, c.updated_at, e.created_at, e.tier as edge_tier,
      e.dst_type, e.dst_id, e.source_table, e.source_id, e.src_type, e.src_id,
      ${COMPILED_PARENT_TIER(db())} as parent_tier,
      coalesce(p.tier, o.tier) as entity_tier,
      coalesce(p.canonical_name, o.canonical_name) as entity_name,
      pa.alias as person_alias, oa.alias as org_alias,
      pa.tier as person_alias_tier, oa.tier as org_alias_tier
    from edges e
    join chunks c on c.parent_type = e.src_type and c.parent_id = e.src_id
    left join people p on e.dst_type = 'person' and e.dst_id = p.id
    left join person_aliases pa on pa.person_id = p.id and pa.tier in (1,2)
    left join orgs o on e.dst_type = 'org' and e.dst_id = o.id
    left join org_aliases oa on oa.org_id = o.id and oa.tier in (1,2)
    where e.rel = 'mentions' and e.dst_id = any(${ids}::uuid[])
      and e.dst_type in ('person', 'org')
      and (e.src_type <> 'page' or not (e.src_id = any(${excluded}::uuid[])))
      and (c.parent_type <> 'page' or exists (
        select 1 from pages pg where pg.id = c.parent_id and pg.status = 'active'
      ))`) as any[];
  const accepted = rows.flatMap((row) => {
    const identity = identities.find((candidate) => candidate.entityId === row.dst_id);
    if (!identity || identity.kind !== row.dst_type) return [];
    const entityTier = Number(row.entity_tier);
    if (entityTier !== 1 && entityTier !== 2) return [];
    const chunkAnchored = row.source_table === "chunks" && row.source_id === row.id;
    const matchedNameTiers = [
      { name: row.entity_name, tier: entityTier },
      { name: row.person_alias, tier: Number(row.person_alias_tier) },
      { name: row.org_alias, tier: Number(row.org_alias_tier) },
    ]
      .filter(
        (entry): entry is { name: string; tier: number } =>
          typeof entry.name === "string" &&
          entry.name.length > 0 &&
          (entry.tier === 1 || entry.tier === 2),
      )
      .filter(({ name }) => ownershipNameMatches(row.text, name))
      .map(({ tier }) => tier);
    if (!chunkAnchored && matchedNameTiers.length === 0) return [];
    return [{ ...row, matched_name_tiers: matchedNameTiers }];
  });
  const source_chunk_ids = [...new Set(accepted.map((row) => row.id as string))];
  const tierEvidence = evidenceTier(
    accepted.flatMap((row) => [
      Number(row.tier),
      Number(row.edge_tier ?? row.tier),
      ...(row.parent_tier == null ? [] : [Number(row.parent_tier)]),
      ...(row.entity_tier == null ? [] : [Number(row.entity_tier)]),
      ...row.matched_name_tiers,
    ]),
  );
  const latest_mention_at = accepted.reduce<Date | null>((max, row) => {
    const at = row.created_at ? new Date(row.created_at) : null;
    return at && (!max || at > max) ? at : max;
  }, null);
  return {
    source_chunk_ids,
    min_tier: tierEvidence.min,
    max_tier: tierEvidence.max,
    evidence_unresolved: accepted.some((row) => row.parent_tier == null || row.entity_tier == null),
    latest_mention_at,
  };
}

async function withAdvisoryLease<T>(keySql: any, work: () => Promise<T>): Promise<T> {
  return withReservedDb(async (connection) => {
    await connection`select pg_advisory_lock(${keySql})`;
    try {
      return await work();
    } finally {
      await connection`select pg_advisory_unlock(${keySql})`;
    }
  });
}

export async function withCompiledNotesLease<T>(work: () => Promise<T>): Promise<T> {
  return withReservedDb(async (connection) => {
    await connection`select pg_advisory_lock(1296649541, 1)`;
    try {
      return await work();
    } finally {
      await connection`select pg_advisory_unlock(1296649541, 1)`;
    }
  });
}

export async function withCompiledNoteTargetLease<T>(
  targetKey: string,
  work: () => Promise<T>,
): Promise<T> {
  return withAdvisoryLease(
    db()`hashtextextended('minime:compiled-note:' || ${targetKey}, 0)`,
    work,
  );
}

// Single-maintenance-owner coordination (W3-5): every resident `serve` calls
// tryAcquireMaintenanceLock() before scheduling dream/backup; only the winner runs them. Unlike
// withCompiledNotesLease's pg_advisory_lock (blocks until free, held only for one `work()` call),
// this is pg_try_advisory_lock (returns immediately) on a dedicated reserved connection the
// caller keeps for as long as it owns maintenance. The lock is released explicitly via
// releaseMaintenanceLock(), or automatically by Postgres if the holding connection/process dies —
// so a crashed owner cannot deadlock a survivor's takeover retry.
const MAINTENANCE_LOCK_KEY = [1296649541, 2] as const;

export interface MaintenanceLockHandle {
  readonly reservation: DbReservation;
}

/** Non-blocking: resolves a handle when the caller becomes the maintenance owner, else null. */
export async function tryAcquireMaintenanceLock(): Promise<MaintenanceLockHandle | null> {
  const reservation = await reserveDb();
  // The query runs on a reservation the caller doesn't own yet (unlike withReservedDb's
  // single-call try/finally, this reservation is meant to outlive the function on success), so a
  // throw here needs its own release-before-rethrow -- otherwise a mid-query failure (Postgres
  // restart, backend termination) leaks the reservation forever and eventually starves the pool.
  try {
    const [row] = (await reservation.executor`
      select pg_try_advisory_lock(${MAINTENANCE_LOCK_KEY[0]}, ${MAINTENANCE_LOCK_KEY[1]}) as locked
    `) as { locked: boolean }[];
    if (row?.locked) return { reservation };
  } catch (error) {
    await reservation.release();
    throw error;
  }
  await reservation.release();
  return null;
}

/** Release a handle from tryAcquireMaintenanceLock() and return its connection to the pool. */
export async function releaseMaintenanceLock(handle: MaintenanceLockHandle): Promise<void> {
  try {
    await handle.reservation.executor`
      select pg_advisory_unlock(${MAINTENANCE_LOCK_KEY[0]}, ${MAINTENANCE_LOCK_KEY[1]})`;
  } finally {
    await handle.reservation.release();
  }
}

// `minime doctor` (W3-7): true when SOME process (any backend, not necessarily the caller) holds
// the maintenance lock right now -- pg_locks is a system view, readable regardless of who granted
// it, so this answers "is anything currently scheduled to run dream/backup" without taking or
// releasing the lock itself.
export async function maintenanceLockHeld(): Promise<boolean> {
  const rows = await db()`
    select 1 from pg_locks
    where locktype = 'advisory' and granted
      and classid = ${MAINTENANCE_LOCK_KEY[0]} and objid = ${MAINTENANCE_LOCK_KEY[1]}
    limit 1`;
  return rows.length > 0;
}

export async function listActivePages(actor?: AccessActor): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return db()`select id, path, title, content_hash, tier from pages
             where status = 'active' and tier >= 1 and tier <= ${allowed}`;
}

// ---------------------------------------------------------------- mirrors (importers write-only)

// One row per expanded occurrence (migration 031): identity is (uid, occurrence_start), not
// uid alone, so a recurring event's weekly/monthly/yearly instances coexist as separate rows.
// occurrenceStart is always the same instant as startsAt for the importer today -- the two
// columns are kept distinct in the schema so a future single-instance edit (move just this
// Tuesday's meeting) could change starts_at without changing the row's recurrence identity.
export async function upsertCalendarEvent(e: {
  uid: string;
  occurrenceStart: Date;
  startsAt: Date;
  endsAt?: Date | null;
  title: string;
  location?: string | null;
  attendees?: unknown;
}): Promise<boolean> {
  const rows = await db()`
    insert into calendar_events (uid, occurrence_start, starts_at, ends_at, title, location, attendees, created_by, source, tier)
    values (${e.uid}, ${e.occurrenceStart}, ${e.startsAt}, ${e.endsAt ?? null}, ${e.title}, ${e.location ?? null},
            ${e.attendees ? db().json(e.attendees as any) : null}, 'importer:calendar', 'importer:calendar', 1)
    on conflict (uid, occurrence_start) do update
      set starts_at = excluded.starts_at, ends_at = excluded.ends_at, title = excluded.title,
          location = excluded.location, attendees = excluded.attendees
    returning (xmax = 0) as inserted`;
  return Boolean(rows[0]?.inserted);
}

// Deletes this uid's mirror rows that the importer no longer produces, scoped to
// occurrence_start >= fromInstant (the current import's window start) so past occurrences --
// which the importer never re-generates on a later import -- are structurally untouched no
// matter what keepInstants contains. Safe to call for every imported uid (recurring or not):
// keepInstants=[] correctly clears every future row for a uid whose recurrence disappeared
// entirely from the latest export.
export async function deleteCalendarOccurrencesNotIn(
  uid: string,
  fromInstant: Date,
  keepInstants: Date[],
): Promise<number> {
  const rows = await db()`
    delete from calendar_events
    where uid = ${uid}
      and occurrence_start >= ${fromInstant}
      and not (occurrence_start = any(${db().array(keepInstants)}))
    returning id`;
  return rows.length;
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
  try {
    await db()`
      insert into transactions (occurred_at, amount_cents, currency, merchant, category,
                                account_label, external_ref, created_by, source, tier)
      values (${t.occurredAt}, ${String(t.amountCents)}::bigint, ${t.currency}, ${t.merchant ?? null}, ${t.category ?? null},
              ${t.accountLabel}, ${t.externalRef}, 'importer:transactions', 'importer:transactions', 0)`;
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return false;
    throw error;
  }
}

export async function insertHealthSample(h: {
  kind: string;
  at: Date;
  value: number;
  unit: string;
  source?: string;
}): Promise<boolean> {
  try {
    await db()`
      insert into health_samples (kind, at, value, unit, created_by, source, tier)
      values (${h.kind}, ${h.at}, ${h.value}, ${h.unit}, 'importer:health', ${h.source ?? "importer:health"}, 0)`;
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return false;
    throw error;
  }
}

export async function upsertEmailMeta(m: {
  messageId: string;
  at: Date;
  fromAddr: string;
  subject?: string | null;
  threadId?: string | null;
}): Promise<boolean> {
  const rows = await db()`
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
  const [r] = await db()`select count(*)::int as n from ${db()(table)}`;
  return r!.n;
}

// ---------------------------------------------------------------- inbox & review queue

export type InboxStatus = "pending" | "processing" | "filed" | "rejected";

export interface InboxItem {
  id: string;
  received_at: Date;
  raw_path: string;
  mime: string | null;
  status: InboxStatus;
  filed_table: string | null;
  filed_id: string | null;
  classifier_output: unknown | null;
  content_hash: string | null;
  archive_path: string | null;
  claim_token: string | null;
  claimed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_by: string;
  source: string;
  derived_from: string | null;
  supersedes_id: string | null;
  tier: number;
}

export interface InboxClaim {
  item: InboxItem;
  token: string;
}

function inboxItem(row: unknown): InboxItem {
  return row as InboxItem;
}

function assertClaimUpdate(rows: unknown[]): void {
  if (rows.length === 0) throw new Error("inbox_claim_lost");
}

export async function insertInboxItem(
  i: { rawPath: string; mime?: string | null; contentHash?: string | null } & Std,
): Promise<{ id: string }> {
  const [row] = await db()`
    insert into inbox_items (raw_path, mime, content_hash, created_by, source, tier)
    values (${i.rawPath}, ${i.mime ?? "text/plain"}, ${i.contentHash ?? null},
            ${i.createdBy ?? "human"}, ${i.source ?? "capture"}, 1)
    returning id`;
  return { id: String(row!.id) };
}

/**
 * Return the existing byte identity, adopt one untouched legacy row, or create a new capture.
 * The path-scoped lock closes the no-row insertion race without updating an exact replay.
 */
export async function ensureInboxItemIdentity(
  i: { rawPath: string; contentHash: string; mime?: string | null } & Std,
): Promise<InboxItem> {
  return withDbTransaction(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${i.rawPath}, 0))`;
    const [existing] = await tx`
      select * from inbox_items
      where raw_path = ${i.rawPath} and content_hash = ${i.contentHash}
        and tier >= 1 and tier <= app_allowed_tier()
      limit 1`;
    if (existing) return inboxItem(existing);

    const [adopted] = await tx`
      update inbox_items set content_hash = ${i.contentHash}
      where id = (
        select id from inbox_items
        where raw_path = ${i.rawPath}
          and content_hash is null
          and status = 'pending'
          and classifier_output is null
          and tier >= 1 and tier <= app_allowed_tier()
        order by received_at, id
        for update
        limit 1
      )
      and tier >= 1 and tier <= app_allowed_tier()
      returning *`;
    if (adopted) return inboxItem(adopted);

    const [created] = await tx`
      insert into inbox_items (raw_path, mime, content_hash, created_by, source, tier)
      values (${i.rawPath}, ${i.mime ?? "text/plain"}, ${i.contentHash},
              ${i.createdBy ?? "human"}, ${i.source ?? "capture"}, 1)
      returning *`;
    return inboxItem(created!);
  });
}

export async function getInboxItem(id: string): Promise<InboxItem | null> {
  const rows = await db()`select * from inbox_items
    where id = ${id} and tier >= 1 and tier <= app_allowed_tier()`;
  return rows[0] ? inboxItem(rows[0]) : null;
}

export async function findInboxByIdentity(
  rawPath: string,
  contentHash: string,
): Promise<InboxItem | null> {
  const rows = await db()`select * from inbox_items
    where raw_path = ${rawPath} and content_hash = ${contentHash}
      and tier >= 1 and tier <= app_allowed_tier()
    limit 1`;
  return rows[0] ? inboxItem(rows[0]) : null;
}

export async function findInboxByPath(rawPath: string): Promise<InboxItem | null> {
  const rows = await db()`select * from inbox_items
      where raw_path = ${rawPath} and tier >= 1 and tier <= app_allowed_tier()
      order by received_at desc, id desc limit 1`;
  return rows[0] ? inboxItem(rows[0]) : null;
}

export async function claimInboxItem(id: string): Promise<InboxClaim | null> {
  const token = crypto.randomUUID();
  const [row] = await db()`
    update inbox_items
    set status = 'processing', claim_token = ${token}, claimed_at = clock_timestamp()
    where id = ${id}
      and tier >= 1 and tier <= app_allowed_tier()
      and (
        (status = 'pending' and classifier_output is null)
        or
        (status = 'processing'
          and claimed_at <= clock_timestamp() - interval '5 minutes')
      )
    returning *`;
  return row ? { item: inboxItem(row), token } : null;
}

/**
 * Claim a pending item for OWNER-DRIVEN manual refiling (minime_refile), regardless of whether
 * it was already classified. claimInboxItem's 'pending' branch deliberately requires
 * classifier_output IS NULL, mirroring retryableInboxItems(): an already-classified pending row
 * (every inbox_unfiled/duplicate review-queue item, per setInboxPendingClaimed) is left for the
 * owner rather than auto-retried, so claimInboxItem can never claim it. This sibling drops only
 * that restriction; the stale-processing branch is identical, so a live concurrent claim (fresh
 * claimed_at, any worker) still fences this exactly as claimInboxItem does.
 */
export async function claimPendingInboxItemForRefile(id: string): Promise<InboxClaim | null> {
  const token = crypto.randomUUID();
  const [row] = await db()`
    update inbox_items
    set status = 'processing', claim_token = ${token}, claimed_at = clock_timestamp()
    where id = ${id}
      and tier >= 1 and tier <= app_allowed_tier()
      and (
        status = 'pending'
        or
        (status = 'processing'
          and claimed_at <= clock_timestamp() - interval '5 minutes')
      )
    returning *`;
  return row ? { item: inboxItem(row), token } : null;
}

export async function setInboxArchivePath(
  id: string,
  token: string,
  archivePath: string,
): Promise<void> {
  const rows = await db()`
    update inbox_items set archive_path = ${archivePath}
    where id = ${id}
      and tier >= 1 and tier <= app_allowed_tier()
      and status = 'processing' and claim_token = ${token}::uuid
    returning id`;
  assertClaimUpdate(rows);
}

export async function setInboxClassification(
  id: string,
  token: string,
  classifierOutput: unknown,
): Promise<void> {
  const rows = await db()`
    update inbox_items set classifier_output = ${db().json(classifierOutput as any)}
    where id = ${id}
      and tier >= 1 and tier <= app_allowed_tier()
      and status = 'processing' and claim_token = ${token}::uuid
    returning id`;
  assertClaimUpdate(rows);
}

/** Lock and validate the fencing token inside the caller's final filing transaction. */
export async function assertInboxClaim(id: string, token: string): Promise<InboxItem> {
  const [row] = await db()`
    select * from inbox_items
    where id = ${id}
      and tier >= 1 and tier <= app_allowed_tier()
      and status = 'processing' and claim_token = ${token}::uuid
    for update`;
  if (!row) throw new Error("inbox_claim_lost");
  return inboxItem(row);
}

export async function setInboxFiledClaimed(
  id: string,
  token: string,
  filedTable: string,
  filedId: string,
  classifierOutput: unknown,
): Promise<void> {
  const rows = await db()`
    update inbox_items
    set status = 'filed', filed_table = ${filedTable}, filed_id = ${filedId},
        classifier_output = ${db().json(classifierOutput as any)},
        claim_token = null, claimed_at = null
    where id = ${id}
      and tier >= 1 and tier <= app_allowed_tier()
      and status = 'processing' and claim_token = ${token}::uuid
    returning id`;
  assertClaimUpdate(rows);
}

export async function setInboxPendingClaimed(
  id: string,
  token: string,
  classifierOutput: unknown,
): Promise<void> {
  const rows = await db()`
    update inbox_items
    set status = 'pending', classifier_output = ${db().json(classifierOutput as any)},
        claim_token = null, claimed_at = null
    where id = ${id}
      and tier >= 1 and tier <= app_allowed_tier()
      and status = 'processing' and claim_token = ${token}::uuid
    returning id`;
  assertClaimUpdate(rows);
}

/** Keep classifier output but expire this token so another worker can reclaim immediately. */
export async function markInboxClaimRetryable(id: string, token: string): Promise<boolean> {
  const rows = await db()`
    update inbox_items
    set claimed_at = clock_timestamp() - interval '6 minutes'
    where id = ${id}
      and tier >= 1 and tier <= app_allowed_tier()
      and status = 'processing' and claim_token = ${token}::uuid
    returning id`;
  return rows.length > 0;
}

export async function retryableInboxItems(): Promise<InboxItem[]> {
  const rows = await db()`
    select * from inbox_items
    where tier >= 1 and tier <= app_allowed_tier()
      and (
        (status = 'pending' and classifier_output is null)
        or (status = 'processing'
            and claimed_at <= clock_timestamp() - interval '5 minutes')
      )
    order by received_at, id`;
  return rows.map(inboxItem);
}

/** Earliest fresh processing lease that will become reclaimable without a filesystem event. */
export async function nextInboxClaimExpiry(): Promise<Date | null> {
  const [row] = await db()`
    select min(claimed_at + interval '5 minutes') as retry_at
    from inbox_items
    where status = 'processing'
      and tier >= 1 and tier <= app_allowed_tier()`;
  return row?.retry_at ? new Date(row.retry_at) : null;
}

export async function filedInboxNoteItems(): Promise<InboxItem[]> {
  const rows = await db()`
    select * from inbox_items
    where status = 'filed'
      and filed_table = 'pages'
      and archive_path is not null
      and content_hash is not null
      and tier >= 1 and tier <= app_allowed_tier()
    order by received_at, id`;
  return rows.map(inboxItem);
}

// Orphan rejection is fenced by the same retryable predicate as claiming. A concurrent fresh
// claim makes this update lose harmlessly rather than rejecting work owned by another worker.
export async function rejectRetryableInboxItem(id: string, reason: string): Promise<boolean> {
  const rows = await db()`
    update inbox_items
    set status = 'rejected',
        classifier_output = ${db().json({ rejected: true, reason } as any)},
        claim_token = null, claimed_at = null
    where id = ${id}
      and tier >= 1 and tier <= app_allowed_tier()
      and (
        (status = 'pending' and classifier_output is null)
        or
        (status = 'processing'
          and claimed_at <= clock_timestamp() - interval '5 minutes')
      )
    returning id`;
  return rows.length > 0;
}

/** Resolve an extra pre-025 pending row after another row has claimed the observed byte identity. */
export async function rejectDuplicateLegacyInboxItem(id: string): Promise<boolean> {
  const rows = await db()`
    update inbox_items
    set status = 'rejected',
        classifier_output = ${db().json({ rejected: true, reason: "legacy_duplicate_identity" } as any)}
    where id = ${id}
      and tier >= 1 and tier <= app_allowed_tier()
      and content_hash is null
      and status = 'pending'
      and classifier_output is null
    returning id`;
  return rows.length > 0;
}

export async function insertReviewItem(kind: string, payload: unknown): Promise<{ id: string }> {
  const [row] = await db()`
    insert into review_queue (kind, payload) values (${kind}, ${db().json(payload as any)}) returning id`;
  return row as any;
}

export async function openReviewItems(kind?: string): Promise<any[]> {
  return db()`select * from review_queue where status = 'open'
             and (${kind === undefined} or kind = ${kind ?? null}) order by created_at`;
}

export async function resolveReviewItem(
  id: string,
  status: "resolved" | "dismissed",
): Promise<void> {
  await db()`update review_queue set status = ${status}, resolved_at = ${now()} where id = ${id}`;
}

/**
 * Auto-resolve any open inbox_unfiled/duplicate review-queue items that point at an inbox item
 * which has just been filed (minime_refile). Scoped to exactly these two kinds — the only ones
 * whose payload carries inbox_item_id (review-queue.ts) — so this can never resolve an unrelated
 * flag (contradiction/stale/decision_review/phantom_person/extract_suspect) by accident.
 */
export async function resolveOpenReviewItemsForInbox(inboxItemId: string): Promise<string[]> {
  const rows = await db()`
    update review_queue
    set status = 'resolved', resolved_at = ${now()}
    where status = 'open'
      and kind in ('inbox_unfiled', 'duplicate')
      and payload ->> 'inbox_item_id' = ${inboxItemId}
    returning id`;
  return rows.map((row) => String(row.id));
}

// ---------------------------------------------------------------- entity tier restore (W4-2)

export interface PendingEntityPromotion {
  id: string;
  entityType: EntityKind;
  entityId: string;
  name: string;
  createdAt: Date;
}

/**
 * Owner-terminal-only listing (`entity:restore-tier --list`, src/cli.ts) — resolves each open
 * entity_promotion item's CURRENT name directly, unlike the MCP tool (review-queue.ts), which
 * masks it behind the caller's own tier. Never call this from an MCP tool handler. An item whose
 * entity has since been removed/retyped out from under it is skipped, not crashed on, so one
 * stale row can never break the whole listing.
 */
export async function pendingEntityPromotions(): Promise<PendingEntityPromotion[]> {
  const out: PendingEntityPromotion[] = [];
  for (const item of await openReviewItems("entity_promotion")) {
    const entityType = item.payload?.entity_type;
    const entityId = item.payload?.entity_id;
    if (entityType !== "person" && entityType !== "org") continue;
    if (typeof entityId !== "string") continue;
    const table = entityType === "person" ? "people" : "orgs";
    const [row] = await db()`
      select canonical_name from ${db()(table)} where id = ${entityId}::uuid`;
    if (!row) continue;
    out.push({
      id: String(item.id),
      entityType,
      entityId,
      name: String(row.canonical_name),
      createdAt: new Date(item.created_at),
    });
  }
  return out;
}

export interface EntityTierRestoreResult {
  entityType: EntityKind;
  entityId: string;
  resolvedReviewItemId: string | null;
}

/**
 * Owner-CLI-only 2->1 demotion (`entity:restore-tier`, src/cli.ts — never exposed through any
 * MCP tool: demotion approval lives in the owner terminal, DECISIONS.md 2026-08-09). Sets the
 * transaction-local `minime.allow_tier_demotion` GUC the guarded trigger
 * (037_identity_content_tier_split.sql's keep_entity_tier_guarded) requires, then demotes ONLY
 * the person/org row's own tier — any alias or edge minted BY a tier-2 extraction stays tier 2.
 * That is a deliberate limitation, not a bug: a demoted identity card becomes tier-1-readable
 * again, but content genuinely derived from tier-2 prose about it does not silently follow.
 * Resolves the matching open entity_promotion item, if any, and audits with the entity id only —
 * never its name.
 *
 * Wraps its own transaction (withDbTransaction), so it composes correctly whether called bare
 * (opens a fresh one on whatever pool is ambient) or nested inside an outer
 * withAdminDbTransaction (the CLI's own wrap, reused transparently). Either way this must
 * actually run on the owner/control-plane connection to succeed: the SQL trigger itself refuses
 * a minime_app-role demotion attempt even with the GUC set, so a caller that skipped the CLI's
 * admin wrap fails closed at the database — entity_tier_demotion_forbidden — rather than
 * silently succeeding as the app role.
 */
export async function restoreEntityTier(
  entityType: EntityKind,
  entityId: string,
  restoredBy = "owner:cli",
): Promise<EntityTierRestoreResult> {
  if (entityType !== "person" && entityType !== "org") throw new Error("entity_kind_invalid");
  const table = entityType === "person" ? "people" : "orgs";
  return withDbTransaction(async (tx) => {
    const [existing] = await tx`select tier from ${tx(table)} where id = ${entityId}::uuid`;
    if (!existing) throw new Error("entity_not_found");
    if (Number(existing.tier) !== 2) throw new Error("entity_not_tier_two");

    await tx`select set_config('minime.allow_tier_demotion', '1', true)`;
    const demoted = await tx`
      update ${tx(table)} set tier = 1
      where id = ${entityId}::uuid and tier = 2
      returning id`;
    // Defensive: the precheck above already refuses anything but a live tier-2 row, so this can
    // only fire on a genuine concurrent change between the two statements.
    if (demoted.length === 0) throw new Error("entity_not_tier_two");

    const [openItem] = await tx`
      select id from review_queue
      where kind = 'entity_promotion' and status = 'open'
        and payload ->> 'entity_id' = ${entityId}
      order by created_at limit 1`;
    let resolvedReviewItemId: string | null = null;
    if (openItem) {
      await resolveReviewItem(String(openItem.id), "resolved");
      resolvedReviewItemId = String(openItem.id);
    }

    await logEvent({
      actor: restoredBy,
      verb: "entity:tier:restored",
      payload: auditPayload.entityTierRestored({ entityType, entityId }),
    });
    return { entityType, entityId, resolvedReviewItemId };
  });
}

// ---------------------------------------------------------------- state snapshot

// inbox_items.filed_table (the raw SQL table name fileRow/refile.ts just filed into) -> the
// ParentType parentMeta expects. Fixed map, not user input; mirrors refile.ts's own SOURCE_TYPE
// (a different layer, same five destinations — pipeline/watcher.ts's FiledTable is the closed
// set fileRow ever produces). Kept local to this file rather than imported/exported: repo.ts
// must not depend on src/pipeline or src/mcp/tools (layering).
const FILED_TABLE_PARENT_TYPE: Record<string, ParentType> = {
  tasks: "task",
  journal_entries: "journal",
  pages: "page",
  interactions: "interaction",
  decisions: "decision",
};

// Mirrors review-queue.ts's HIDDEN sentinel. Duplicated rather than imported: repo.ts must not
// depend on src/mcp/tools (layering), and stateSnapshot is the one place that needs it here.
const FILING_HIDDEN_TITLE = "[above current tier]";
// Mirrors review-queue.ts's RETRACTED sentinel, for the identical reason it exists there:
// parentMeta excludes retracted rows (superseded_at set, superseded_by null) for EVERY caller
// regardless of tier (see the comment on parentMeta above), so a parentMeta miss alone can't tell
// "above current tier" apart from "withdrawn via minime_correct retract". Collapsing both into
// FILING_HIDDEN_TITLE would tell the owner a same-day filing still needs a tier-2 unlock when it
// has already been corrected and needs nothing — defeating the point of the evening classifier
// audit (W2-8's stated purpose). resolveFiledToday re-checks every parentMeta miss through getRow
// (tier bound only, no retraction filter) to tell the two apart, exactly as review-queue.ts's
// visibleTitle does for the sibling case.
const FILING_RETRACTED_TITLE = "[retracted]";

export interface FiledTodayEntry {
  id: string; // inbox_items.id (the capture)
  type: ParentType | null; // resolved via FILED_TABLE_PARENT_TYPE; null only for an unrecognized filed_table
  filed_table: string;
  filed_id: string;
  kind: string | null; // classifier_output->>'type' — the classifier's own guess, unmasked (tier 1: inbox_items is always tier 1)
  confidence: number | null;
  // Resolved through parentMeta at the caller's tier. FILING_HIDDEN_TITLE when the destination
  // row is genuinely above the caller's tier; FILING_RETRACTED_TITLE when the row is visible but
  // was withdrawn via minime_correct (retract) — see resolveFiledToday for how the two misses are
  // told apart.
  title: string;
  // The destination row's actual tier — populated whenever the row is visible to the caller,
  // including a retracted-but-visible row (retraction is not a tier fact); null only when the row
  // is genuinely above the caller's current tier.
  tier: number | null;
}

interface FiledTodayRow {
  id: string;
  filed_table: string | null;
  filed_id: string | null;
  kind: string | null;
  confidence: number | null;
}

/**
 * Resolve each today-filed capture's destination title/tier through the SAME tier-filtered
 * parentMeta every other title lookup uses — never from classifier_output (which is unmasked
 * inbox metadata and may describe tier-2-grade content the caller cannot see). A filing whose
 * destination is above the caller's tier keeps kind/confidence/filed_table (all inbox_items
 * metadata, always tier 1) but its title reads FILING_HIDDEN_TITLE and tier is null.
 *
 * parentMeta also excludes retracted rows (superseded_at set, superseded_by null) for every
 * caller, tier notwithstanding, so a parentMeta miss by itself is ambiguous between "above tier"
 * and "retracted". Every miss is re-checked through getRow — same tier bound, no retraction
 * filter, exactly as review-queue.ts's visibleTitle does — so a getRow hit proves tier was never
 * the issue and reports FILING_RETRACTED_TITLE with the row's real tier instead of a false
 * FILING_HIDDEN_TITLE that would send the owner toward an unneeded tier-2 unlock.
 */
async function resolveFiledToday(
  rows: FiledTodayRow[],
  actor: AccessActor,
): Promise<FiledTodayEntry[]> {
  if (rows.length === 0) return [];
  const idsByType = new Map<ParentType, Set<string>>();
  for (const r of rows) {
    const type = r.filed_table ? FILED_TABLE_PARENT_TYPE[r.filed_table] : undefined;
    if (!type || !r.filed_id) continue;
    if (!idsByType.has(type)) idsByType.set(type, new Set());
    idsByType.get(type)!.add(r.filed_id);
  }
  const meta = new Map<string, ParentMeta>();
  for (const [type, ids] of idsByType) {
    for (const [id, m] of await parentMeta(type, [...ids], actor)) {
      meta.set(`${type}:${id}`, m);
    }
  }
  // Second pass: only for parentMeta misses, ask getRow (tier bound only) whether the row is
  // actually visible. A hit here is a retracted-but-visible row; a miss on both is genuinely
  // above tier (or the id is stale/missing) — unchanged from before this distinction existed.
  const retractedTier = new Map<string, number>(); // "type:id" -> real tier
  for (const [type, ids] of idsByType) {
    for (const id of ids) {
      if (meta.has(`${type}:${id}`)) continue;
      const row = await getRow(type, id, actor);
      if (row) retractedTier.set(`${type}:${id}`, Number(row.tier));
    }
  }
  return rows.map((r) => {
    const type = r.filed_table ? (FILED_TABLE_PARENT_TYPE[r.filed_table] ?? null) : null;
    const key = type && r.filed_id ? `${type}:${r.filed_id}` : null;
    const hit = key ? meta.get(key) : undefined;
    const retracted = hit || !key ? undefined : retractedTier.get(key);
    return {
      id: r.id,
      type,
      filed_table: r.filed_table ?? "",
      filed_id: r.filed_id ?? "",
      kind: r.kind,
      confidence: r.confidence,
      title: hit
        ? hit.title
        : retracted !== undefined
          ? FILING_RETRACTED_TITLE
          : FILING_HIDDEN_TITLE,
      tier: hit ? Number(hit.tier) : (retracted ?? null),
    };
  });
}

export interface OpsHealth {
  dream_last_at: Date | null;
  failed_steps: string[];
  ops_failure_open: number;
}

// Content-free operational facts for minime_state's ops_health block and `minime doctor`
// (W3-7): the last dream:summary run and its failed step names (fixed identifiers only --
// see audit-payload.ts's dreamSummary/DREAM_STEPS), plus how many ops_failure review items are
// currently open. Deliberately not tier-gated: none of this is personal content, so it is
// identical for every actor/tier -- unlike the rest of stateSnapshot, which allowedTier()-filters
// calendar/tasks/etc.
export async function opsHealth(): Promise<OpsHealth> {
  const [[latest], openFailures] = await Promise.all([
    recentEventsByVerb("dream:summary", 1),
    openReviewItems("ops_failure"),
  ]);
  const steps = latest?.payload?.failed_steps;
  return {
    dream_last_at: latest ? new Date(latest.at) : null,
    failed_steps: Array.isArray(steps) ? steps.filter((s: unknown) => typeof s === "string") : [],
    ops_failure_open: openFailures.length,
  };
}

export interface GoalOverviewRow {
  id: string;
  horizon: string;
  statement: string;
  open_task_count: number;
  last_task_activity_at: Date | null;
}

// Active goals for minime_state's goals_active section (W3-12): horizon/statement plus an
// open-task count (inbox/active/waiting only) and the most recent activity across ANY linked
// task, open or closed -- the same "touched" signal goalsNeedingReview uses to judge staleness,
// so what the owner sees here and what dream flags for review agree. Tasks above the caller's
// tier contribute to neither figure (a hidden task's mere existence is not this endpoint's to
// leak). superseded_at excludes a corrected-away goal (028_correction_supersede.sql);
// dropped/achieved goals are deliberately absent -- this is a "what's still live" view, not a
// full listing (minime_search covers ad hoc lookup of any goal by id/content).
export async function goalsOverview(actor?: AccessActor): Promise<GoalOverviewRow[]> {
  const allowed = await allowedTier(actor);
  return db()`
    select g.id, g.horizon, g.statement,
           count(t.id) filter (
             where t.status in ('inbox','active','waiting')
               and t.tier >= 1 and t.tier <= ${allowed}
           )::int as open_task_count,
           max(t.updated_at) filter (where t.tier >= 1 and t.tier <= ${allowed})
             as last_task_activity_at
    from goals g
    left join tasks t on t.goal_id = g.id
    where g.status = 'active' and g.superseded_at is null
      and g.tier >= 1 and g.tier <= ${allowed}
    group by g.id, g.horizon, g.statement
    order by (case g.horizon when 'life' then 0 when 'year' then 1 when 'quarter' then 2 else 3 end),
             g.statement` as any;
}

export async function stateSnapshot(actor?: AccessActor, timeZone?: string): Promise<any> {
  const t = now();
  const ownerTimeZone = configuredTimeZone(config.tz);
  const effectiveTimeZone = configuredTimeZone(timeZone);
  // Anchor "today" on the LOCAL calendar day, computed in app code. Casting the
  // UTC instant inside Postgres (${t}::date) uses the DB session TZ (UTC here),
  // which truncates to YESTERDAY whenever local time is past midnight but UTC
  // hasn't rolled over yet — e.g. the 7am Asia/Singapore morning brief = 23:00
  // UTC prior day. Passing a local YYYY-MM-DD string makes the day boundary
  // correct regardless of DB session TZ or time of day. See DECISIONS.md.
  const today = localDateStr(t, effectiveTimeZone);
  // Persisted metric rollups have one canonical owner-zone identity. Caller-local dates still
  // govern due work and moved_today, but must never select a different cache day.
  const ownerToday = localDateStr(t, ownerTimeZone);
  const allowed = await allowedTier(actor);
  const [
    calendar,
    tasks,
    commitments,
    decisionsDue,
    openReview,
    anomalies,
    movedToday,
    filedTodayRaw,
    opsHealthResult,
    upcomingDates,
    goalsActive,
  ] = await Promise.all([
    db()`select id, uid, starts_at, ends_at, title, location from calendar_events
        where starts_at >= ${t}::timestamptz - interval '1 hour'
          and starts_at < ${t}::timestamptz + interval '2 days'
          and tier >= 1 and tier <= ${allowed}
        order by starts_at`,
    db()`select id, title, status, due from tasks
        where status in ('inbox','active','waiting') and due is not null and due <= ${today}::date
          and tier >= 1 and tier <= ${allowed}
        order by due`,
    db()`select id, what, to_whom, due from commitments
        where status = 'open' and superseded_at is null and tier >= 1 and tier <= ${allowed}
        order by due nulls last`,
    db()`select id, question, review_at, choice from decisions
        where reviewed_at is null
          and tier >= 1 and tier <= ${allowed}
          and ( (review_at is not null and review_at <= ${today}::date + 3)
                or choice is null )
        order by review_at nulls last`,
    db()`select count(*)::int as n from review_queue where status = 'open'`,
    metricAnomalies(ownerToday, ownerTimeZone),
    // What MOVED today: tasks closed (done/dropped) on the caller's LOCAL calendar day
    // (the owner zone by default). minime_state otherwise reports only OPEN work, so completions
    // were structurally invisible to the evening review's "what moved today".
    // Compare updated_at and today in the same effective caller zone (owner zone by default).
    db()`select id, title, status, updated_at from tasks
        where status in ('done','dropped')
          and (updated_at at time zone ${effectiveTimeZone})::date = ${today}::date
          and tier >= 1 and tier <= ${allowed}
        order by updated_at`,
    // What was FILED today: captures the classifier/refile routed into a typed row on the
    // caller's LOCAL calendar day (same predicate shape as moved_today above). inbox_items
    // itself is always tier 1 (assigned before the row has a real destination), so this read
    // never needs to hide a row — only the destination title/tier resolved below can be masked.
    db()`select id, filed_table, filed_id, classifier_output->>'type' as kind,
           (classifier_output->>'confidence')::float as confidence
        from inbox_items
        where status = 'filed'
          and (updated_at at time zone ${effectiveTimeZone})::date = ${today}::date
          and tier >= 1 and tier <= ${allowed}
        order by updated_at`,
    opsHealth(),
    // Birthdays/anniversaries/custom dates due in the next 14 days (today counted as day one, so
    // the window is [today, today+13]) — minime_state is otherwise entirely due/today-anchored
    // and cannot warn about a Friday birthday before Friday, same gap minime_agenda closes for
    // tasks.
    upcomingPersonDates(today, 14, actor),
    goalsOverview(actor),
  ]);
  const filedToday = await resolveFiledToday(filedTodayRaw as unknown as FiledTodayRow[], actor);
  return {
    calendar,
    tasks_due: tasks,
    moved_today: movedToday,
    filed_today: filedToday,
    commitments_open: commitments,
    decision_reviews_due: decisionsDue,
    review_queue_open: openReview[0]?.n ?? 0,
    metric_anomalies: anomalies,
    ops_health: opsHealthResult,
    upcoming_dates: upcomingDates,
    goals_active: goalsActive,
  };
}

export type OpenTaskStatus = "inbox" | "active" | "waiting";
const OPEN_TASK_STATUSES: OpenTaskStatus[] = ["inbox", "active", "waiting"];

export interface TasksInRangeOptions {
  // Also return open tasks with no due date at all (captured but never scheduled) —
  // otherwise they never resurface anywhere, since minime_state is due-anchored too.
  includeUndated?: boolean;
  // Narrow to a subset of open statuses. Defaults to all three (unchanged behavior).
  statuses?: OpenTaskStatus[];
}

// Forward-looking agenda: tasks due within an inclusive [from, to] date range.
// minime_state is today-anchored (due <= today) and CANNOT answer "what's due
// tomorrow / this week"; this fills that gap. Includes inbox/active/waiting
// (open work), excludes done/dropped. Ordered by due date then title.
export async function tasksInRange(
  from: string,
  to: string,
  actor?: AccessActor,
  options?: TasksInRangeOptions,
): Promise<any[]> {
  const allowed = await allowedTier(actor);
  const includeUndated = options?.includeUndated ?? false;
  const statuses = options?.statuses ?? OPEN_TASK_STATUSES;
  // The dated branch reproduces the original predicate exactly; includeUndated only ever
  // ADDS rows (due is null), never relaxes the dated range or the tier predicate below.
  return db()`select id, title, status, due from tasks
      where status = any(${statuses})
        and ((due is not null and due >= ${from}::date and due <= ${to}::date)
             or (${includeUndated} and due is null))
        and tier >= 1 and tier <= ${allowed}
      order by due nulls last, title`;
}

// Dedup support for the inbox pipeline: find open (non-done/dropped) tasks whose
// normalized title closely matches a candidate, so a re-mention of the same item is
// routed to the review queue instead of silently inserting a second row. Normalization
// strips punctuation/case/whitespace; we compare a trigram-ish containment both ways so
// "Attend Mina's Marble Lantern event" matches "Attend Mina Marble Lantern family event".
export async function openTasksForDedup(): Promise<
  { id: string; title: string; due: string | null }[]
> {
  return db()`select id, title, due from tasks
      where status in ('inbox','active','waiting')
      order by created_at desc
      limit 500` as any;
}

// Latest daily value vs trailing-28-day mean ± 2σ, from metric_values only (never raw tier-0).
export async function metricAnomalies(asOfDate: string, timeZone: string): Promise<any[]> {
  const rows = await db()`
    with eligible as (
      select mv.metric, mv.period_start, mv.value
      from metric_values mv
      join metric_defs def on def.name = mv.metric
      where mv.granularity = 'day' and (
        def.agg_sql is null
        or mv.source not in ('dream', 'query')
        or (mv.source = 'dream' and exists (
          select 1 from metric_cache_state state
          where state.singleton and state.time_zone = ${timeZone}
        ))
      )
    ), latest as (
      select distinct on (metric) metric, period_start, value
      from eligible
      where period_start <= ${asOfDate}::date
      order by metric, period_start desc
    ), stats as (
      select l.metric, avg(eligible.value) as mean, stddev_samp(eligible.value) as sd
      from latest l
      join eligible on eligible.metric = l.metric
        and eligible.period_start between l.period_start - 28 and l.period_start - 1
      group by l.metric
    )
    select l.metric, l.period_start, l.value::float, s.mean::float, s.sd::float
    from latest l join stats s on s.metric = l.metric
    where s.sd is not null and s.sd > 0 and abs(l.value - s.mean) > 2 * s.sd`;
  return rows.map((row) => ({ ...row, period_start: metricDateString(row.period_start) }));
}

// ---------------------------------------------------------------- metrics (I6)

export async function metricDef(name: string): Promise<{
  name: string;
  unit: string | null;
  description: string | null;
  rollup: MetricRollup;
} | null> {
  const rows =
    await db()`select name, unit, description, rollup from metric_defs where name = ${name}`;
  return (rows[0] as any) ?? null;
}

export async function listMetricDefs(): Promise<
  { name: string; unit: string | null; agg_sql: string | null; rollup: MetricRollup }[]
> {
  return db()`select name, unit, agg_sql, rollup from metric_defs order by name` as any;
}

// Agent-facing metric catalog (I2): name/unit/description/rollup only — agg_sql never crosses
// the MCP boundary. listMetricDefs() above stays owner/dream-only; do not reuse it here.
export async function listMetricDefsPublic(): Promise<
  { name: string; unit: string | null; description: string | null; rollup: MetricRollup }[]
> {
  return db()`select name, unit, description, rollup from metric_defs order by name` as any;
}

// The single door to whitelisted aggregate SQL (incl. tier-0 sources): the timezone-explicit
// security-definer function in 026. Metric name and timezone are checked before execution.
export async function runMetricAgg(
  name: string,
  from: string,
  to: string,
  timeZone: string,
): Promise<{ period_start: string; value: number; label: string | null }[]> {
  const def = await metricDef(name);
  if (!def) throw Object.assign(new Error(`unknown metric: ${name}`), { code: "UNKNOWN_METRIC" });
  const rows = await db()`select period_start, value::float, label
    from metric_agg(${name}, ${from}, ${to}, ${timeZone})`;
  return rows.map((r: any) => ({
    period_start: metricDateString(r.period_start),
    value: Number(r.value),
    label: r.label ?? null,
  }));
}

export async function upsertMetricValue(
  name: string,
  periodStart: string,
  granularity: string,
  value: number,
  source: string,
): Promise<void> {
  await db()`
    insert into metric_values (metric, period_start, granularity, value, source, computed_at)
    values (${name}, ${periodStart}, ${granularity}, ${value}, ${source}, ${now()})
    on conflict (metric, granularity, period_start)
      do update set value = excluded.value, source = excluded.source, computed_at = excluded.computed_at
      where metric_values.source = 'dream'`;
}

/**
 * Remove only Dream-owned values that an ordinary source-backed refresh is about to replace.
 * Mutable inputs can move or disappear, so upserts alone cannot reconcile an empty bucket.
 * The surrounding owner transaction keeps readers on either the old or new complete windows.
 */
export async function clearDreamMetricRefreshWindow(input: {
  name: string;
  dayFrom: string;
  dayTo: string;
  weekFrom: string;
  weekTo: string;
  monthFrom: string;
  monthTo: string;
}): Promise<void> {
  if (!hasDbTransaction()) throw new Error("metric_cache_transaction_required");
  await db()`delete from metric_values
    where metric = ${input.name} and source = 'dream' and (
      (granularity = 'day'
        and period_start between ${input.dayFrom}::date and ${input.dayTo}::date)
      or (granularity = 'week'
        and period_start between ${input.weekFrom}::date and ${input.weekTo}::date)
      or (granularity = 'month'
        and period_start between ${input.monthFrom}::date and ${input.monthTo}::date)
    )`;
}

/**
 * Lock the canonical Dream cache and switch its timezone identity when needed. The caller wraps
 * this and the subsequent full rebuild in one owner transaction, so readers see either the old
 * complete cache or the new complete cache. Stored-only definitions and non-Dream rows survive.
 */
export async function prepareMetricCache(timeZone: string): Promise<boolean> {
  if (!hasDbTransaction()) throw new Error("metric_cache_transaction_required");
  const effectiveTimeZone = configuredTimeZone(timeZone);
  await db()`lock table metric_cache_state in exclusive mode`;
  const [current] = await db()`select time_zone from metric_cache_state where singleton`;
  if (current?.time_zone === effectiveTimeZone) return false;
  await db()`delete from metric_values mv
    using metric_defs def
    where mv.metric = def.name and def.agg_sql is not null
      and mv.source in ('dream', 'query')`;
  await db()`insert into metric_cache_state (singleton, time_zone, updated_at)
    values (true, ${effectiveTimeZone}, ${now()})
    on conflict (singleton) do update
      set time_zone = excluded.time_zone, updated_at = excluded.updated_at`;
  return true;
}

// ---------------------------------------------------------------- context

export async function getRow(
  type: ParentType,
  id: string,
  actor?: AccessActor,
): Promise<any | null> {
  const allowed = await allowedTier(actor);
  const { table } = parentTable(type);
  const rows =
    await db()`select * from ${db()(table)} where id = ${id} and tier >= 1 and tier <= ${allowed}`;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- content correction (minime_correct, W2-4)
//
// Migration 028 (correction_supersede) added superseded_by/superseded_at to every PARENTS table
// and granted minime_app UPDATE on exactly those two columns for the six tables that had no
// broader UPDATE grant (021_runtime_app_role.sql already covers the other six via full table
// UPDATE). Every one of those tables' tier_update RLS policies carries the `tier >= 1 and
// tier <= app_allowed_tier()` bound (028's ALTER POLICY loop), so an UPDATE through either
// helper below can only ever touch a row the calling session could also SELECT — a locked
// (tier-1) session's attempt to correct a tier-2 row matches 0 rows, indistinguishable from a
// missing id, which the caller (correct.ts) turns into the same NOT_FOUND either way. The
// `superseded_at is null` guard makes both helpers idempotent-safe: a row that is already
// amended or retracted cannot be re-stamped, protecting its one backward pointer from being
// overwritten by an unrelated second write (including a concurrent racing correction).
export class CorrectionTargetNotFoundError extends Error {
  constructor() {
    super("correction target not found");
  }
}

/** Stamp the OLD row as superseded by NEW once the successor row already exists (I5 backward
 * pointer; the successor's own forward `supersedes_id` is stamped at insert time). Throws
 * CorrectionTargetNotFoundError when the row is missing, already superseded, or above the
 * caller's tier. */
export async function supersedeRow(type: ParentType, oldId: string, newId: string): Promise<void> {
  const { table } = parentTable(type);
  const rows = await db()`
    update ${db()(table)}
    set superseded_by = ${newId}, superseded_at = ${now()}
    where id = ${oldId} and superseded_at is null
    returning id`;
  if (rows.length === 0) throw new CorrectionTargetNotFoundError();
}

/** Retract (soft-withdraw) a row: stamp superseded_at with no successor, and drop its chunks so
 * it stops matching search. The row itself is never edited or deleted (I5) and stays readable by
 * id. Throws CorrectionTargetNotFoundError on the same three cases as supersedeRow. */
export async function retractRow(type: ParentType, id: string): Promise<void> {
  const { table } = parentTable(type);
  await withDbTransaction(async (tx) => {
    const rows = await tx`
      update ${tx(table)}
      set superseded_at = ${now()}
      where id = ${id} and superseded_at is null
      returning id`;
    if (rows.length === 0) throw new CorrectionTargetNotFoundError();
    await tx`delete from chunks where parent_type = ${type} and parent_id = ${id}`;
  });
}

export async function edgesAround(
  type: string,
  id: string,
  limit = 20,
  actor?: AccessActor,
): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return db()`
    select * from edges
    where ((src_type = ${type} and src_id = ${id}) or (dst_type = ${type} and dst_id = ${id}))
      and tier >= 1 and tier <= ${allowed}
    order by created_at desc limit ${limit}`;
}

export async function recentInteractionsFor(
  personId: string,
  limit = 20,
  actor?: AccessActor,
): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return db()`select id, kind, summary, occurred_at, created_by from interactions
             where person_id = ${personId} and tier >= 1 and tier <= ${allowed}
             order by occurred_at desc limit ${limit}`;
}

// Org-keyed interactions (vendors/institutions). Mirrors recentInteractionsFor but
// keyed on org_id — enabled by 013_interactions_org.sql.
export async function recentInteractionsForOrg(
  orgId: string,
  limit = 20,
  actor?: AccessActor,
): Promise<any[]> {
  const allowed = await allowedTier(actor);
  return db()`select id, kind, summary, occurred_at, created_by from interactions
             where org_id = ${orgId} and tier >= 1 and tier <= ${allowed}
             order by occurred_at desc limit ${limit}`;
}

export async function openItemsFor(
  personName: string,
  actor?: AccessActor,
): Promise<{ commitments: any[]; tasks: any[] }> {
  const allowed = await allowedTier(actor);
  const commitments = await db()`
    select id, what, to_whom, due, status from commitments
    where status = 'open' and superseded_at is null and lower(to_whom) = lower(${personName})
      and tier >= 1 and tier <= ${allowed}`;
  const tasks = await db()`
    select id, title, status, due from tasks
    where status in ('inbox','active','waiting') and title ilike '%' || ${personName} || '%'
      and tier >= 1 and tier <= ${allowed}`;
  return { commitments, tasks };
}

export async function journalCountSince(since: Date): Promise<number> {
  const [r] = await db()`select count(*)::int as n from journal_entries where at >= ${since}`;
  return r!.n;
}

// Resolve page rows by path, e.g. mapping benchmark haystack ids (encoded in paths) to
// page UUIDs for scoped search.
export async function pagesByPaths(paths: string[]): Promise<{ id: string; path: string }[]> {
  if (paths.length === 0) return [];
  return db()`select id, path from pages where path = any(${paths})` as any;
}

// ---------------------------------------------------------------- timeline (minime_timeline, W3-3)

export type TimelineKind = "calendar" | "journal" | "interaction" | "task" | "decision";

const TIMELINE_KINDS: readonly TimelineKind[] = [
  "calendar",
  "journal",
  "interaction",
  "task",
  "decision",
];

export interface TimelineRow {
  kind: TimelineKind;
  id: string;
  at: Date;
  title: string;
}

export interface TimelineLockedCounts {
  journal: number;
  interaction: number;
}

export interface TimelineResult {
  rows: TimelineRow[];
  locked: TimelineLockedCounts;
}

// Tier-gated date-range read across every life source (spec W3-3). Each branch of the UNION
// carries its OWN `tier >= 1 and tier <= allowed` predicate (never a shared post-filter, so a
// bug in one branch can never leak another's rows) and its own `superseded_at is null` guard --
// EXCEPT calendar_events, which is a write-only importer mirror (005_mirrors.sql) outside the
// PARENTS/correction system and never received that column (028_correction_supersede.sql's
// twelve-table loop does not include it). journal_entries/interactions default to tier 2, so
// their branches structurally return nothing for a locked session — the UNION's own predicate
// IS the enforcement, not a filter applied after the fact. tasks/decisions anchor on a CLOSURE
// timestamp, not a creation time: a done task on completed_at, a dropped one on updated_at
// (dropping has no dedicated timestamp column); a decision on decided_at, falling back to
// created_at for one that was logged but never resolved. Every branch's `at` column is
// timestamptz, so the five-way UNION ALL is a single consistent type and the trailing
// `order by at, id` / `limit/offset` is exact SQL pagination — no branch is ever pulled in full
// just to be sorted in application code. Tier-0 sources (transactions, health_samples) are
// structurally absent: neither table is named anywhere in this function (I3).
export async function timelineRows(
  from: string,
  to: string,
  kinds: TimelineKind[] | undefined,
  limit: number,
  offset: number,
  actor?: AccessActor,
  timeZone?: string,
): Promise<TimelineResult> {
  const allowed = await allowedTier(actor);
  const tz = configuredTimeZone(timeZone);
  const wanted = kinds && kinds.length > 0 ? kinds : TIMELINE_KINDS;
  const want = (k: TimelineKind) => wanted.includes(k);

  // `want(...)` interpolates a plain JS boolean directly into the WHERE clause — the same
  // short-circuit pattern tasksInRange uses for includeUndated above — so an excluded kind
  // contributes zero rows without the SQL text itself ever changing shape per call.
  const rows = (await db()`
    select 'calendar'::text as kind, id, occurrence_start as at, left(title, 120) as title
    from calendar_events
    where ${want("calendar")}
      and (occurrence_start at time zone ${tz})::date between ${from}::date and ${to}::date
      and tier >= 1 and tier <= ${allowed}

    union all

    select 'journal'::text as kind, id, at, left(entry_md, 120) as title
    from journal_entries
    where ${want("journal")}
      and (at at time zone ${tz})::date between ${from}::date and ${to}::date
      and tier >= 1 and tier <= ${allowed}
      and superseded_at is null

    union all

    select 'interaction'::text as kind, id, occurred_at as at, left(summary, 120) as title
    from interactions
    where ${want("interaction")}
      and (occurred_at at time zone ${tz})::date between ${from}::date and ${to}::date
      and tier >= 1 and tier <= ${allowed}
      and superseded_at is null

    union all

    select 'task'::text as kind, id,
           case when status = 'done' then completed_at else updated_at end as at,
           left(title, 120) as title
    from tasks
    where ${want("task")}
      and status in ('done', 'dropped')
      and ((case when status = 'done' then completed_at else updated_at end)
             at time zone ${tz})::date between ${from}::date and ${to}::date
      and tier >= 1 and tier <= ${allowed}
      and superseded_at is null

    union all

    select 'decision'::text as kind, id, coalesce(decided_at, created_at) as at,
           left(question, 120) as title
    from decisions
    where ${want("decision")}
      and (coalesce(decided_at, created_at) at time zone ${tz})::date
            between ${from}::date and ${to}::date
      and tier >= 1 and tier <= ${allowed}
      and superseded_at is null

    order by at asc, id asc
    limit ${limit} offset ${offset}`) as unknown as TimelineRow[];

  // Locked counts are a deliberate, narrow exception to "never disclose what a locked session
  // cannot read": a bare count (never a title or id) of the tier-2 rows this call's date window
  // matched but this session cannot see, so the caller knows there is more here rather than
  // silently reading an empty range as "nothing happened". Only journal/interactions default to
  // tier 2 — calendar/task/decision are tier 1 on every product write path today — so counting
  // is limited to those two sources, matching the spec exactly; tier-0 sources are never queried
  // here at all (I3). Skipped whenever the session is already unlocked (those rows are already in
  // `rows` above, so a separate "locked" count would double-count them) or the caller never asked
  // for that kind via `types` (a caller scoped to types:['calendar'] gets no journal/interaction
  // accounting, locked or not).
  //
  // The count MUST run through timeline_locked_count() (032_timeline_locked_count.sql), a
  // SECURITY DEFINER function — never a plain db() SELECT — because db() in the real resident
  // deployment is always the restricted minime_app role (src/serve.ts pins both DATABASE_URL and
  // MINIME_APP_DATABASE_URL to it), and journal_entries/interactions carry the standard
  // tier_read RLS policy `USING (tier >= 1 and tier <= app_allowed_tier())`. Postgres intersects
  // that policy with a plain query's own WHERE clause, so `select count(*) where tier = 2` under
  // a genuinely locked session (app_allowed_tier() = 1) would be narrowed to
  // `tier <= 1 AND tier = 2` — never satisfiable — and silently return 0 no matter how many
  // tier-2 rows exist in range (review finding, 2026-08-08: verified against a live restricted
  // role, not just inferred). timeline_locked_count() runs as the migration owner, so it is not
  // subject to the caller's own RLS, and — like metric_agg() — returns only a bare integer,
  // never row content. See test/timeline-restricted-role.test.ts for the regression coverage
  // through the real restricted role that this bug had no test for.
  const needsLockedCounts = allowed < 2;
  let journalLocked = 0;
  let interactionLocked = 0;
  if (needsLockedCounts && want("journal")) {
    const [row] = await db()`select timeline_locked_count('journal', ${from}, ${to}, ${tz}) as n`;
    journalLocked = Number(row?.n ?? 0);
  }
  if (needsLockedCounts && want("interaction")) {
    const [row] =
      await db()`select timeline_locked_count('interaction', ${from}, ${to}, ${tz}) as n`;
    interactionLocked = Number(row?.n ?? 0);
  }

  return { rows, locked: { journal: journalLocked, interaction: interactionLocked } };
}

// ---------------------------------------------------------------- dream support

// Parents never touched by the extractor (no system:extract edges yet). Parents whose
// text yields zero entities are re-scanned each night — bounded by `limit`, regex-cheap.
export async function parentsNeedingExtraction(
  limit: number,
): Promise<
  { parent_type: string; parent_id: string; text: string; tier: 1 | 2; derived_from: string }[]
> {
  return db()`
    select c.parent_type, c.parent_id, string_agg(c.text, e'\n\n' order by c.ord) as text,
           max(c.tier)::int as tier, c.parent_id as derived_from
    from chunks c
    where c.tier >= 1 and not exists (
      select 1 from edges e
      where e.src_type = c.parent_type and e.src_id = c.parent_id
        and e.extracted_by = 'system:extract'
    )
    group by c.parent_type, c.parent_id
    order by max(c.updated_at) desc limit ${limit}` as any;
}

export async function allPeopleWithAliases(): Promise<{ id: string; names: string[] }[]> {
  const rows = await db()`
    select p.id, array_agg(distinct x.name) as names
    from people p
    cross join lateral (
      select p.canonical_name as name
      union select a.alias from person_aliases a
        where a.person_id = p.id and a.tier in (1,2)
    ) x
    where p.tier in (1,2)
    group by p.id`;
  return rows.map((r: any) => ({ id: r.id, names: r.names }));
}

// Untouched-AND-referenced conjunction: a row only surfaces as stale if it is BOTH old
// (the untouchedDays predicate below) AND was referenced again recently (either signal):
//   - a released minime_get_context drill-in naming it as the primary result, mirroring the
//     accessCounts join shape (repo.ts accessCounts) over the append-only events log — ids
//     only, never content (I8); or
//   - a fresh edge touching it in either direction (it mentioned something, or something
//     mentions it) within referencedSinceDays (edges.created_at, 003_graph_audit.sql).
// Existing row-level `tier >= 1` floor is unchanged — staleItems output flows through the
// tier-masking review-queue tool, so this is a boolean existence gate, not a content read.
export async function staleItems(
  referencedSinceDays: number,
  untouchedDays: number,
): Promise<any[]> {
  const t = now();
  return db()`
    select 'page' as type, id, title as label, updated_at from pages
    where status = 'active' and tier >= 1
      and updated_at < ${t}::timestamptz - make_interval(days => ${untouchedDays})
      and (
        exists (
          select 1
          from events r
          join events d
            on d.verb = 'tool:minime_get_context:disposition'
           and d.payload->>'result_event_id' = r.id::text
           and d.payload->>'status' = 'released'
          where r.verb = 'tool:minime_get_context'
            and r.payload->>'delivery' = 'transport'
            and r.at >= ${t}::timestamptz - make_interval(days => ${referencedSinceDays})
            and r.payload->'returned_ids'->>0 = pages.id::text
        )
        or exists (
          select 1 from edges e
          where ((e.dst_type = 'page' and e.dst_id = pages.id)
              or (e.src_type = 'page' and e.src_id = pages.id))
            and e.created_at >= ${t}::timestamptz - make_interval(days => ${referencedSinceDays})
        )
      )
    union all
    select 'person' as type, id, canonical_name as label, updated_at from people
    where tier >= 1
      and coalesce(last_contact_at, updated_at) < ${t}::timestamptz - make_interval(days => ${untouchedDays})
      and (
        exists (
          select 1
          from events r
          join events d
            on d.verb = 'tool:minime_get_context:disposition'
           and d.payload->>'result_event_id' = r.id::text
           and d.payload->>'status' = 'released'
          where r.verb = 'tool:minime_get_context'
            and r.payload->>'delivery' = 'transport'
            and r.at >= ${t}::timestamptz - make_interval(days => ${referencedSinceDays})
            and r.payload->'returned_ids'->>0 = people.id::text
        )
        or exists (
          select 1 from edges e
          where ((e.dst_type = 'person' and e.dst_id = people.id)
              or (e.src_type = 'person' and e.src_id = people.id))
            and e.created_at >= ${t}::timestamptz - make_interval(days => ${referencedSinceDays})
        )
      )`;
}

// Phantom-person watchdog candidates (dream step 3b). Surfaces person rows that actually
// look like an organisation, so a human can retype them (retypePersonToOrg-style) or dismiss:
//   - name_match: the person's canonical name or an alias equals an existing, non-retired
//     org's canonical name or alias (case-insensitive). Strong signal it's really that org.
//   - the caller (dream) additionally applies a company-cue heuristic to the name and only
//     flags cue matches that ALSO have zero human signal (no relation, no interactions),
//     using has_human_signal below. Both paths flag only — never auto-retype.
// Returns one row per candidate person with the columns the dream step needs to decide.
export async function phantomPersonCandidates(): Promise<
  {
    id: string;
    canonical_name: string;
    name_match: boolean;
    has_human_signal: boolean;
  }[]
> {
  return db()`
    with p as (
      select pe.id, pe.canonical_name, pe.relation,
             array_agg(distinct lower(x.name)) as names
      from people pe
      cross join lateral (
        select pe.canonical_name as name
        union select pa.alias from person_aliases pa
          where pa.person_id = pe.id and pa.tier in (1,2)
      ) x
      where pe.tier in (1,2) and pe.superseded_at is null
      group by pe.id, pe.canonical_name, pe.relation
    ),
    org_names as (
      select lower(o.canonical_name) as name from orgs o
      where o.tier in (1,2) and o.retired_at is null
      union
      select lower(oa.alias) from org_aliases oa
      join orgs o on o.id = oa.org_id
      where o.tier in (1,2) and oa.tier in (1,2) and o.retired_at is null
    )
    select p.id, p.canonical_name,
           exists (select 1 from org_names n where n.name = any(p.names)) as name_match,
           (p.relation is not null
            or exists (select 1 from interactions i where i.person_id = p.id)) as has_human_signal
    from p` as any;
}

// -- W1 extractor re-validation (system-internal; NOT tier-gated — see personById precedent:
// the dream job reads locally, egress is gated by per-tier routing at the provider layer) ----

export interface EdgeToValidate {
  id: string;
  src_type: string;
  src_id: string;
  rel: string;
  dst_type: string;
  dst_id: string;
  confidence: number;
  tier: number;
  source_table: string | null;
  source_id: string | null;
  src_name: string | null;
  dst_name: string | null;
  src_tier: number | null;
  dst_tier: number | null;
}

/** system:extract edges needing a verdict: the recent window first (born-yesterday edges get
 * checked the next night), then the oldest backlog, so the whole graph is eventually swept.
 * Settled verdicts (confirm/deny) exclude an edge; a single 'unsure' leaves it eligible for
 * exactly the resample pass (validate-edges flags on the second unsure). */
export async function edgesForValidation(
  recentHours: number,
  limit: number,
): Promise<EdgeToValidate[]> {
  return (await db()`
    select e.id, e.src_type, e.src_id, e.rel, e.dst_type, e.dst_id, e.confidence, e.tier,
           e.source_table, e.source_id,
           coalesce(sp.canonical_name, so.canonical_name) as src_name,
           coalesce(dp.canonical_name, do_.canonical_name) as dst_name,
           coalesce(sp.tier, so.tier)::int as src_tier,
           coalesce(dp.tier, do_.tier)::int as dst_tier
    from edges e
    left join people sp on e.src_type = 'person' and sp.id = e.src_id
    left join orgs   so on e.src_type = 'org'    and so.id = e.src_id
    left join people dp on e.dst_type = 'person' and dp.id = e.dst_id
    left join orgs   do_ on e.dst_type = 'org'   and do_.id = e.dst_id
    where e.extracted_by = 'system:extract' and e.tier >= 1
      and (e.src_type not in ('person', 'org') or coalesce(sp.tier, so.tier) >= 1)
      and (e.dst_type not in ('person', 'org') or coalesce(dp.tier, do_.tier) >= 1)
      and not exists (select 1 from edge_validations v
                      where v.edge_id = e.id and v.verdict <> 'unsure')
      and (select count(*) from edge_validations v2
           where v2.edge_id = e.id and v2.verdict = 'unsure') < 2
    order by (e.created_at >= now() - make_interval(hours => ${recentHours})) desc,
             e.created_at asc
    limit ${limit}`) as unknown as EdgeToValidate[];
}

/** Chunks of the edge's SOURCE PARENT containing the needle. Chunk-anchored edges DO exist
 * elsewhere (the dream entity-link pass writes mentions edges with source_table='chunks');
 * the parent-anchored claim (source_table = real table name, source_id = parent row id)
 * holds for the system:extract works_at/mentions edges written by extract-edges — which is
 * what edgesForValidation filters on, so those are the only edges reaching this function
 * from the validation sweep. Falls back to the parent's first chunk when the needle is
 * absent (and to [] for a source_table with no PARENTS mapping, e.g. 'chunks'). */
export async function edgeAnchorTexts(
  e: Pick<EdgeToValidate, "source_table" | "source_id">,
  needle: string,
): Promise<{ text: string; tier: number }[]> {
  if (!e.source_table || !e.source_id) return [];
  const shortType = Object.entries(PARENTS).find(([, v]) => v.table === e.source_table)?.[0];
  if (!shortType) return [];
  const hits = (await db()`
    select text, tier from chunks
    where parent_type = ${shortType} and parent_id = ${e.source_id} and tier >= 1
      and text ilike ${`%${needle}%`}
    order by ord limit 3`) as unknown as { text: string; tier: number }[];
  if (hits.length > 0) return hits;
  return (await db()`
    select text, tier from chunks
    where parent_type = ${shortType} and parent_id = ${e.source_id} and tier >= 1
    order by ord limit 1`) as unknown as { text: string; tier: number }[];
}

export async function insertEdgeValidation(v: {
  edgeId: string;
  verdict: "confirm" | "deny" | "unsure";
  entityType?: "person" | "org" | "neither";
  reason?: string;
  model: string;
  ruleKey: string;
}): Promise<void> {
  await db()`insert into edge_validations (edge_id, verdict, entity_type, reason, model, rule_key)
    values (${v.edgeId}, ${v.verdict}, ${v.entityType ?? null}, ${v.reason ?? null}, ${v.model}, ${v.ruleKey})`;
}

export async function edgeUnsureCount(edgeId: string): Promise<number> {
  const [r] = await db()`select count(*)::int as n from edge_validations
    where edge_id = ${edgeId} and verdict = 'unsure'`;
  return (r as { n: number }).n;
}

// Read-surface tier gate for extract_suspect review items: the dream job captured the edge
// triple (rel + endpoint names) without a tier predicate (system context), so the MCP tool
// must decide per caller whether that triple may surface. Edges inherit their source parent's
// tier (set_edge_tier trigger), making edges.tier the one check needed here.
export async function edgeVisibleAtTier(edgeId: string, actor?: AccessActor): Promise<boolean> {
  const allowed = await allowedTier(actor);
  const rows =
    await db()`select 1 from edges where id = ${edgeId} and tier >= 1 and tier <= ${allowed} limit 1`;
  return rows.length > 0;
}

export async function decisionsNeedingReview(asOfDate: string): Promise<any[]> {
  return db()`select id, question, review_at from decisions
             where tier >= 1 and review_at is not null
               and review_at <= ${asOfDate}::date and reviewed_at is null`;
}

// Stale-goal re-check window (dream step 6b, W3-12): an active goal is due for a "still true?"
// review once BOTH it and every task linked to it have gone untouched for this long -- an
// untouched-only bound would flag a goal the owner is actively working through via its tasks
// even though the goal ROW itself hasn't been edited recently. Mirrors staleItems' own
// untouched-AND-referenced shape (repo.ts above), just with the second signal inverted (no
// recent activity, rather than "has" recent activity).
const GOAL_REVIEW_STALE_DAYS = 90;

export async function goalsNeedingReview(): Promise<{ id: string; statement: string }[]> {
  const t = now();
  return db()`
    select g.id, g.statement
    from goals g
    where g.status = 'active' and g.superseded_at is null and g.tier >= 1
      and g.updated_at < ${t}::timestamptz - make_interval(days => ${GOAL_REVIEW_STALE_DAYS})
      and not exists (
        select 1 from tasks tk
        where tk.goal_id = g.id
          and tk.updated_at >= ${t}::timestamptz - make_interval(days => ${GOAL_REVIEW_STALE_DAYS})
      )
    order by g.updated_at`;
}

// Search backfill (dream step 2d, W3-12): insertGoal never indexes itself -- every caller
// (minime_upsert_goal, onboard.ts) owns calling indexParent, the same contract upsertTask's
// callers already follow. This catches whatever a caller missed anyway (chiefly onboarding-era
// rows written before this task, and demo/fixture seed data), so a goal eventually becomes
// searchable even when its own write path forgot. Bounded and idempotent via the
// not-exists-chunks check -- a goal drops out of this list as soon as indexParent runs for it.
export async function goalsWithoutChunks(
  limit = 200,
): Promise<{ id: string; statement: string; why: string | null; tier: number }[]> {
  return db()`
    select g.id, g.statement, g.why, g.tier
    from goals g
    where g.superseded_at is null and g.tier >= 1
      and not exists (
        select 1 from chunks c where c.parent_type = 'goal' and c.parent_id = g.id
      )
    order by g.created_at
    limit ${limit}` as any;
}

const COMPILED_NOTE_SOURCES_DELIMITER = "\n## Sources\n";
const COMPILED_NOTE_UUID_BULLET_SQL_RE =
  "(^|\n)- [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}($|\n)";

export interface ContradictionChunkPair {
  person_id: string;
  a_id: string;
  a_text: string;
  a_tier: number;
  b_id: string;
  b_text: string;
  b_tier: number;
}

export async function chunkPairsSharingPerson(limit: number): Promise<ContradictionChunkPair[]> {
  return (await db()`
    with canonical_parent_tiers(parent_type, parent_id, parent_tier) as (
      select 'page'::text, id, tier from pages
      union all
      select 'journal', id, tier from journal_entries
      union all
      select 'interaction', id, tier from interactions
      union all
      select 'decision', id, tier from decisions
      union all
      select 'decision_branch', id, tier from decision_branches
      union all
      select 'task', id, tier from tasks
      union all
      select 'goal', id, tier from goals
      union all
      select 'value', id, tier from values_items
      union all
      select 'principle', id, tier from principles
      union all
      select 'person', id, tier from people
      union all
      select 'org', id, tier from orgs
      union all
      select 'commitment', id, tier from commitments
    ),
    normalized_pages as (
      select pg.id, pg.source, pg.path,
             E'\n' ||
               replace(replace(coalesce(pg.body_md, ''), E'\r\n', E'\n'), E'\r', E'\n')
               as normalized_body
      from pages pg
    ),
    page_shape_parts as (
      select np.*,
             string_to_array(
               np.normalized_body,
               ${COMPILED_NOTE_SOURCES_DELIMITER}
             ) as sources_parts
      from normalized_pages np
    ),
    excluded_page_parents as (
      select ps.id
      from page_shape_parts ps
      where ps.source in ('dream:notes', 'dream:decision-digest')
         or ps.path ~ ${COMPILED_NOTE_UUID_PATH_SQL_RE}
         or (
           ${COMPILED_NOTE_MARKER} =
             any(string_to_array(ps.normalized_body, E'\n'))
           and cardinality(ps.sources_parts) > 1
           and ps.sources_parts[cardinality(ps.sources_parts)]
             ~* ${COMPILED_NOTE_UUID_BULLET_SQL_RE}
         )
    ),
    mention_chunks as (
      select distinct e.dst_id as person_id, e.src_type, e.src_id,
             c.id as chunk_id, c.text,
             greatest(
               e.tier, p.tier, c.tier, cp.parent_tier,
               coalesce(alias_match.matched_tier, 1)
             )::int as tier,
             c.updated_at
      from edges e
      join people p on p.id = e.dst_id
      join chunks c on c.parent_type = e.src_type and c.parent_id = e.src_id
      join canonical_parent_tiers cp
        on cp.parent_type = e.src_type and cp.parent_id = e.src_id
      left join lateral (
        select max(a.tier)::int as matched_tier
        from person_aliases a
        where a.person_id = p.id and a.tier in (1,2)
          and btrim(a.alias) <> ''
          and strpos(lower(c.text), lower(a.alias)) > 0
      ) alias_match on true
      where e.rel = 'mentions' and e.dst_type = 'person'
        and e.tier >= 1
        and p.tier >= 1
        and c.tier >= 1
        and cp.parent_tier >= 1
        and (
          c.parent_type <> 'page'
          or exists (
            select 1 from pages live_page
            where live_page.id = c.parent_id and live_page.status = 'active'
          )
        )
        and (
          (
            btrim(p.canonical_name) <> ''
            and strpos(lower(c.text), lower(p.canonical_name)) > 0
          )
          or alias_match.matched_tier is not null
        )
        and not (
          e.src_type = 'page' and exists (
            select 1 from excluded_page_parents excluded
            where excluded.id = e.src_id
          )
        )
    ),
    raw_pairs as (
      select x.person_id,
             case when x.chunk_id < y.chunk_id then x.chunk_id else y.chunk_id end as a_id,
             case when x.chunk_id < y.chunk_id then x.text else y.text end as a_text,
             case when x.chunk_id < y.chunk_id then x.tier else y.tier end as a_tier,
             case when x.chunk_id < y.chunk_id then y.chunk_id else x.chunk_id end as b_id,
             case when x.chunk_id < y.chunk_id then y.text else x.text end as b_text,
             case when x.chunk_id < y.chunk_id then y.tier else x.tier end as b_tier,
             greatest(x.updated_at, y.updated_at) as newest_at
      from mention_chunks x
      join mention_chunks y on y.person_id = x.person_id
       and (
         x.src_type < y.src_type
         or (x.src_type = y.src_type and x.src_id < y.src_id)
       )
    ),
    deduplicated as (
      select distinct on (person_id, a_id, b_id)
             person_id, a_id, a_text, a_tier, b_id, b_text, b_tier, newest_at
      from raw_pairs
      order by person_id, a_id, b_id, newest_at desc
    )
    select person_id, a_id, a_text, a_tier, b_id, b_text, b_tier
    from deduplicated
    order by newest_at desc, a_id asc, b_id asc, person_id asc
    limit ${limit}`) as unknown as ContradictionChunkPair[];
}

export async function reviewItemExists(
  kind: string,
  payloadKey: string,
  payloadValue: string,
): Promise<boolean> {
  const rows = await db()`select 1 from review_queue where kind = ${kind} and status = 'open'
    and payload ->> ${payloadKey} = ${payloadValue} limit 1`;
  return rows.length > 0;
}

// Stale-item re-flag suppression window (review-triage.md: "dismissed means dismissed").
// Conservative and trivially tunable — see W1-7 spec risk note.
const STALE_SUPPRESSION_DAYS = 90;

/** True if a stale item for this payload id is currently open (never duplicate an open flag)
 * OR was created within the suppression window regardless of status (a dismissal stays quiet
 * for a bounded time rather than forever — it can legitimately resurface later). Dream step 4
 * uses this in place of reviewItemExists, which only checked status = 'open' and so re-flagged
 * a dismissed item the very next night. */
export async function staleRecentlyFlagged(id: string): Promise<boolean> {
  const rows = await db()`
    select 1 from review_queue
    where kind = 'stale' and payload ->> 'id' = ${id}
      and (status = 'open'
        or created_at >= ${now()}::timestamptz - make_interval(days => ${STALE_SUPPRESSION_DAYS}))
    limit 1`;
  return rows.length > 0;
}

// ---------------------------------------------------------------- compiled notes (dream step)
// System-job reads (like chunkPairsSharingPerson): chunk text stays on-box and the resulting
// note page carries the inherited tier, so agent reads are tier-gated at the page. No
// allowedTier predicate here — the dream job is not an agent context. Production mention
// edges are parent-anchored at (src_type, src_id); noteSourceChunks() resolves the chunks
// through that typed parent and ignores historical source_table/source_id metadata.

export interface NoteCandidate {
  kind: "person";
  id: string;
  name: string;
  chunk_count: number;
  min_tier: number;
  max_tier: number;
  evidence_unresolved: boolean;
  latest_mention_at: Date;
}

// People with at least `minChunks` chunks that mention them. `max_tier` drives the note tier;
// `latest_mention_at` is the cheap staleness signal (vs. the note page's updated_at). Mention
// edges are PARENT-anchored (src = the mentioning row, M7 extraction shape), so the chunks
// are joined via the edge's src parent. Note pages themselves are excluded so a note never
// feeds itself.
export async function noteCandidates(minChunks: number): Promise<NoteCandidate[]> {
  const excluded = await excludedDerivedPageIdsForCompiledNoteSources();
  const rows = (await db()`
    select 'person'::text as kind, e.dst_id as id, p.canonical_name as name,
           count(distinct c.id)::int as chunk_count,
           min(least(c.tier, e.tier, p.tier, ${COMPILED_PARENT_TIER(db())}))::int as min_tier,
           max(greatest(c.tier, e.tier, p.tier, ${COMPILED_PARENT_TIER(db())}))::int as max_tier,
           bool_or(${COMPILED_PARENT_TIER(db())} is null) as evidence_unresolved,
           max(e.created_at) as latest_mention_at
    from edges e
    join chunks c on c.parent_type = e.src_type and c.parent_id = e.src_id
    join people p on p.id = e.dst_id
    where e.rel = 'mentions' and e.dst_type = 'person'
      and e.tier in (1,2) and c.tier in (1,2) and p.tier in (1,2)
      and ${COMPILED_PARENT_TIER(db())} in (1,2)
      and not (e.src_type = 'page' and e.src_id = any(${excluded}::uuid[]))
      and (c.parent_type <> 'page' or exists (
        select 1 from pages pg where pg.id = c.parent_id and pg.status = 'active'))
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
): Promise<
  {
    id: string;
    parent_type: string;
    parent_id: string;
    text: string;
    tier: number;
    edge_tier: number;
    min_tier: number;
    max_tier: number;
    evidence_unresolved: boolean;
  }[]
> {
  const excluded = await excludedDerivedPageIdsForCompiledNoteSources();
  const names = (
    await db()`
    select p.canonical_name as name, p.tier::int as tier
    from people p where p.id = ${id} and p.tier in (1,2)
    union all
    select a.alias as name, a.tier::int as tier
    from person_aliases a
    join people p on p.id = a.person_id
    where a.person_id = ${id} and p.tier in (1,2) and a.tier in (1,2)`
  )
    .filter(
      (row): row is { name: string; tier: number } =>
        typeof row.name === "string" &&
        row.name.length > 0 &&
        (Number(row.tier) === 1 || Number(row.tier) === 2),
    )
    .map((row) => ({ name: row.name, tier: Number(row.tier) }));
  const rows = (await db()`
    select distinct c.id, c.parent_type, c.parent_id, c.text, c.tier, e.tier as edge_tier,
      least(c.tier, e.tier, p.tier, ${COMPILED_PARENT_TIER(db())})::int as min_tier,
      greatest(c.tier, e.tier, p.tier, ${COMPILED_PARENT_TIER(db())})::int as max_tier,
      (${COMPILED_PARENT_TIER(db())} is null) as evidence_unresolved,
      c.updated_at, c.ord
    from edges e
    join chunks c on c.parent_type = e.src_type and c.parent_id = e.src_id
    join people p on p.id = e.dst_id
    where e.rel = 'mentions' and e.dst_type = 'person' and e.dst_id = ${id}
      and e.tier in (1,2) and c.tier in (1,2) and p.tier in (1,2)
      and ${COMPILED_PARENT_TIER(db())} in (1,2)
      and not (e.src_type = 'page' and e.src_id = any(${excluded}::uuid[]))
      and (c.parent_type <> 'page' or exists (
        select 1 from pages pg where pg.id = c.parent_id and pg.status = 'active'))
    order by c.updated_at, c.ord, c.id`) as any[];
  return rows.flatMap((row) => {
    const matchedNameTiers = names
      .filter(({ name }) => ownershipNameMatches(row.text, name))
      .map(({ tier }) => tier);
    if (matchedNameTiers.length === 0) return [];
    return [
      {
        ...row,
        min_tier: Math.min(Number(row.min_tier), ...matchedNameTiers),
        max_tier: Math.max(Number(row.max_tier), ...matchedNameTiers),
      },
    ];
  }) as any;
}

// The note page's last-compiled marker. updated_at advances only when the body changed
// (upsertPage no-ops on identical content_hash), so a mention newer than this means stale.
export async function notePageFreshness(
  path: string,
): Promise<{ id: string; updated_at: Date } | null> {
  const rows =
    await db()`select id, updated_at from pages where path = ${path} and status = 'active'`;
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
  const rows = await db()`select * from decisions where id = ${id}`;
  const d = rows[0] as any;
  if (!d) return null;
  const transcript = (await db()`
    select id, question_key, prompt, answer, tier
    from decision_transcripts
    where decision_id = ${id}
    order by ord`) as any[];
  const branches = (await db()`
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
  const rows = (await db()`
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
