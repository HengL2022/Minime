declare const auditPayloadBrand: unique symbol;

export type AuditPayload = Readonly<Record<string, unknown>> & {
  readonly [auditPayloadBrand]: true;
};

type AuditPayloadKind =
  | "cliHealthList"
  | "cliMetricAdd"
  | "cliTxList"
  | "correctAmend"
  | "correctRetier"
  | "correctRetract"
  | "dreamSummary"
  | "entityTierRestored"
  | "importMalformed"
  | "importSummary"
  | "inboxClosedExistingTask"
  | "inboxDuplicate"
  | "inboxFiled"
  | "inboxLegacyDuplicate"
  | "inboxOrphaned"
  | "inboxRefiled"
  | "inboxSplitDecision"
  | "inboxSplitDoneTask"
  | "inboxSplitEntities"
  | "inboxUnfiled"
  | "llmClassifyEgress"
  | "llmClassifyOutcome"
  | "llmEmbedEgress"
  | "llmEmbedOutcome"
  | "onboardComplete"
  | "personUpsert"
  | "pushBrief"
  | "repair"
  | "resticCheck"
  | "tier2Unlock"
  | "toolAttempt"
  | "toolDisposition"
  | "toolResult";

const payloadKinds = new WeakMap<object, AuditPayloadKind>();

type AuditDelivery = "transport" | "direct";
type AuditImporter = "calendar" | "email_meta" | "health" | "transactions";
type AuditProvider = "ollama" | "anthropic" | "openai" | "openrouter" | "bedrock";
type AuditEgressKind = "embed" | "classify";
type ClassifierKind = "task" | "journal" | "interaction" | "note" | "decision_note" | "unknown";
type FiledTable = "tasks" | "journal_entries" | "interactions" | "pages" | "decisions";
// minime_correct's own type vocabulary (W2-4) — "note" not "page", matching ClassifierKind's
// convention of naming the owner-facing type rather than the raw PARENTS table/ParentType.
type CorrectType = "journal" | "interaction" | "decision" | "note";
// minime_upsert_person (W2-6).
type PersonUpsertEntityType = "person" | "org";
type PersonUpsertAction = "add_alias" | "set_relation" | "set_context" | "rename";
type RepairCode =
  | "repair_not_committed"
  | "repair_module_failed"
  | "repair_cleanup_failed"
  | "repair_audit_failed"
  | "repair_backup_failed"
  | "repair_invalid_summary"
  | "repair_complete";
type RepairScript =
  | "retype-org-to-person"
  | "merge-person"
  | "recategorize-transactions"
  | "unknown";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL_EVENT_ID = /^[1-9]\d*$/;
const METRIC_ID = /^[a-z][a-z0-9_]{0,63}$/;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,199}$/;
const HASH = /^[a-f0-9]{16}$/;
const YEAR_MONTH = /^\d{4}-\d{2}$/;

function invalidPayload(): never {
  throw new Error("invalid_audit_payload");
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidPayload();
  return value as number;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidPayload();
  return value as number;
}

function unlockMinutes(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_440)
    invalidPayload();
  return value as number;
}

function ratio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    invalidPayload();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalidPayload();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalidPayload();
  return value;
}

function returnedId(value: unknown): string {
  if (typeof value !== "string" || (!UUID.test(value) && !METRIC_ID.test(value))) invalidPayload();
  return value;
}

function returnedIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) invalidPayload();
  return Object.freeze(value.slice(0, 100).map(returnedId));
}

function uuids(value: unknown): readonly string[] {
  if (!Array.isArray(value)) invalidPayload();
  return Object.freeze(value.slice(0, 100).map(uuid));
}

function eventId(value: unknown): string {
  if (typeof value !== "string" || !DECIMAL_EVENT_ID.test(value)) invalidPayload();
  return value;
}

function paramsHash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) invalidPayload();
  return value;
}

function errorCode(value: unknown): string {
  return fixed(value, [
    "AUDIT_UNAVAILABLE",
    "BAD_INPUT",
    "DUPLICATE_REQUEST_ID",
    "INTERNAL",
    "NOT_FOUND",
    "SDK_REFUSAL",
    "UNKNOWN_METRIC",
    "UNKNOWN_TOOL",
    "UNLOCK_TOO_LONG",
  ]);
}

function routeTier(value: unknown): 1 | 2 {
  if (value !== 1 && value !== 2) invalidPayload();
  return value;
}

function modelIdentifier(value: unknown): string {
  if (typeof value !== "string" || !MODEL_IDENTIFIER.test(value)) invalidPayload();
  return value;
}

// cli:tx:list's month filter — "YYYY-MM", the exact shape src/db/repo.ts's listTransactions
// itself validates before ever building a date range from it.
function yearMonth(value: unknown): string {
  if (typeof value !== "string" || !YEAR_MONTH.test(value)) invalidPayload();
  return value;
}

// cli:health:list's kind filter. health_samples.kind uses the identical lowercase-snake-case
// shape metric ids already validate against (METRIC_ID) — named separately here so the field's
// own meaning (a health sample kind, not a metric id) is clear at call sites.
function healthKind(value: unknown): string {
  if (typeof value !== "string" || !METRIC_ID.test(value)) invalidPayload();
  return value;
}

// cli:metric:add's own metric name field. src/db/repo.ts's insertMetricDef validates the name
// against a stricter shape (/^[a-z][a-z0-9_]{1,63}$/ — at least two characters) before it can
// ever reach this payload, so METRIC_ID's slightly looser 1-64-char class is never actually
// exercised at its lower bound here; reusing it keeps one lowercase-snake-case identifier shape
// across every payload that names a metric, matching healthKind's own precedent above.
function metricId(value: unknown): string {
  if (typeof value !== "string" || !METRIC_ID.test(value)) invalidPayload();
  return value;
}

// cli:metric:add's template field — the closed vocabulary src/util/metric-templates.ts defines.
function metricTemplateId(value: unknown): string {
  return fixed(value, [
    "health-sum",
    "health-avg",
    "health-count",
    "spend-by-category",
    "spend-by-merchant",
  ]);
}

function fixed<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
    invalidPayload();
  return value as T;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function summaryCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function nestedCount(value: unknown, key: string): number {
  return summaryCount(record(value)[key]);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function construct(kind: AuditPayloadKind, fields: Record<string, unknown>): AuditPayload {
  const payload = deepFreeze(fields) as AuditPayload;
  payloadKinds.set(payload, kind);
  return payload;
}

function toolAttempt(input: {
  paramsHash: string;
  requestedNameHash?: string;
}): AuditPayload {
  return construct("toolAttempt", {
    params_hash: paramsHash(input.paramsHash),
    ...(input.requestedNameHash
      ? { requested_name_hash: paramsHash(input.requestedNameHash) }
      : {}),
  });
}

function toolResult(input: {
  paramsHash: string;
  returnedIds: string[];
  returnedCount: number;
  errorCode?: string;
  requestedNameHash?: string;
  delivery: AuditDelivery;
}): AuditPayload {
  return construct("toolResult", {
    params_hash: paramsHash(input.paramsHash),
    returned_ids: returnedIds(input.returnedIds),
    returned_count: nonNegativeInteger(input.returnedCount),
    ...(input.errorCode ? { error: errorCode(input.errorCode) } : {}),
    ...(input.requestedNameHash
      ? { requested_name_hash: paramsHash(input.requestedNameHash) }
      : {}),
    delivery: fixed(input.delivery, ["transport", "direct"]),
  });
}

type ToolDispositionInput =
  | {
      resultEventId: string;
      status: "suppressed";
      outcome?:
        | "cancelled_before_execution"
        | "transport_closed_before_execution"
        | "completed_not_released"
        | "completed_after_disconnect";
    }
  | { resultEventId: string; status: "released" | "send_uncertain" };

function toolDisposition(input: ToolDispositionInput): AuditPayload {
  const base = {
    result_event_id: eventId(input.resultEventId),
    status: fixed(input.status, ["suppressed", "released", "send_uncertain"]),
  };
  if (input.status !== "suppressed") return construct("toolDisposition", base);
  return construct("toolDisposition", {
    ...base,
    returned_ids: Object.freeze([]),
    returned_count: 0,
    ...(input.outcome
      ? {
          outcome: fixed(input.outcome, [
            "cancelled_before_execution",
            "transport_closed_before_execution",
            "completed_not_released",
            "completed_after_disconnect",
          ]),
        }
      : {}),
  });
}

function tier2Unlock(input: { requestId: string; minutes: number }): AuditPayload {
  return construct("tier2Unlock", {
    request_id: uuid(input.requestId),
    minutes: unlockMinutes(input.minutes),
  });
}

type LlmEgressInput = {
  kind: AuditEgressKind;
  provider: AuditProvider;
  model: string;
  items: number;
  routeTier?: 1 | 2;
};

function llmEgress(input: LlmEgressInput): AuditPayload {
  const kind = fixed(input.kind, ["embed", "classify"]);
  if (kind === "embed") {
    if ("routeTier" in input && input.routeTier !== undefined) invalidPayload();
    return construct("llmEmbedEgress", {
      provider: fixed(input.provider, ["openai", "openrouter"]),
      model: modelIdentifier(input.model),
      items: positiveInteger(input.items),
    });
  }
  if (input.items !== 1) invalidPayload();
  return construct("llmClassifyEgress", {
    provider: fixed(input.provider, ["anthropic", "openai", "openrouter", "bedrock"]),
    model: modelIdentifier(input.model),
    items: 1,
    ...(input.routeTier === undefined ? {} : { route_tier: routeTier(input.routeTier) }),
  });
}

function llmEgressOutcome(input: {
  kind: AuditEgressKind;
  intentEventId: string;
  status: "succeeded" | "failed";
}): AuditPayload {
  const kind = fixed(input.kind, ["embed", "classify"]);
  return construct(kind === "embed" ? "llmEmbedOutcome" : "llmClassifyOutcome", {
    intent_event_id: eventId(input.intentEventId),
    status: fixed(input.status, ["succeeded", "failed"]),
  });
}

type ImportMalformedInput =
  // "unsupported_rrule" backs the calendar importer's separate "import:rrule-unsupported" verb
  // (an event whose RRULE has an unsupported part still imports DTSTART as one row -- not
  // skipped, so this reason is never paired with verb "import:malformed").
  | {
      importer: "calendar";
      reason: "missing_required_fields" | "unsupported_rrule";
      recordNumber: number;
    }
  | { importer: "email_meta"; reason: "missing_required_fields"; recordNumber: number }
  | { importer: "transactions"; reason: "invalid_date_or_amount"; recordNumber: number }
  | {
      importer: "health";
      reason: "invalid_start_date" | "invalid_value";
      recordNumber: number;
    };

function importMalformed(input: ImportMalformedInput): AuditPayload {
  const importer = fixed(input.importer, ["calendar", "email_meta", "health", "transactions"]);
  let reason: ImportMalformedInput["reason"];
  if (importer === "calendar") {
    reason = fixed(input.reason, ["missing_required_fields", "unsupported_rrule"]);
  } else if (importer === "email_meta") {
    reason = fixed(input.reason, ["missing_required_fields"]);
  } else if (importer === "transactions") {
    reason = fixed(input.reason, ["invalid_date_or_amount"]);
  } else {
    reason = fixed(input.reason, ["invalid_start_date", "invalid_value"]);
  }
  const base = {
    importer,
    reason,
    record_number: nonNegativeInteger(input.recordNumber),
  };
  return construct("importMalformed", base);
}

function importSummary(input: {
  importer: AuditImporter;
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
}): AuditPayload {
  return construct("importSummary", {
    importer: fixed(input.importer, ["calendar", "email_meta", "health", "transactions"]),
    total: nonNegativeInteger(input.total),
    inserted: nonNegativeInteger(input.inserted),
    updated: nonNegativeInteger(input.updated),
    skipped: nonNegativeInteger(input.skipped),
  });
}

function onboardComplete(input: {
  profile: number;
  values: number;
  goals: number;
  principles: number;
  people: number;
  tasks: number;
  journal: number;
}): AuditPayload {
  return construct("onboardComplete", {
    profile: nonNegativeInteger(input.profile),
    values: nonNegativeInteger(input.values),
    goals: nonNegativeInteger(input.goals),
    principles: nonNegativeInteger(input.principles),
    people: nonNegativeInteger(input.people),
    tasks: nonNegativeInteger(input.tasks),
    journal: nonNegativeInteger(input.journal),
  });
}

const DREAM_STEPS = [
  "1_embed_backlog",
  "2_entity_link",
  "2b_compile_notes",
  "2c_compile_decision_digests",
  "2d_goal_backlog_index",
  "3_contradictions",
  "3b_phantom_persons",
  "3c_validate_edges",
  "4_stale",
  "5b_recurrence",
  "5_rollups",
  "6_decision_reviews",
  "6b_goal_reviews",
  "7_backup",
] as const;

function dreamSummary(input: Record<string, unknown>): AuditPayload {
  const noteFailed = nestedCount(input["2b_compile_notes"], "failed");
  // Step KEYS only, never the string VALUE dream.ts's step() wrapper assigned on failure
  // (currently always the fixed literal "failed" — dream.ts's catch block discards the real
  // error). Filtering on DREAM_STEPS this way means only members of that fixed, closed
  // vocabulary can ever appear here regardless of what a future bug put in the value, so this
  // stays safe to surface through minime_state's ops_health (W3-7) and an ops_failure review
  // item's payload — content never crosses, only fixed dream-step identifiers.
  const failedStepNames = DREAM_STEPS.filter((step) => typeof input[step] === "string");
  const hasFailure = failedStepNames.length > 0 || noteFailed > 0;
  return construct("dreamSummary", {
    status: hasFailure ? "partial_failure" : "complete",
    ...(failedStepNames.length > 0
      ? { error_code: "dream_step_failed" }
      : noteFailed > 0
        ? { error_code: "dream_item_failed" }
        : {}),
    failed_step_count: failedStepNames.length,
    failed_steps: failedStepNames,
    embed_backlog_count: summaryCount(input["1_embed_backlog"]),
    entity_link_count: summaryCount(input["2_entity_link"]),
    note_candidate_count: nestedCount(input["2b_compile_notes"], "candidates"),
    note_created_count: nestedCount(input["2b_compile_notes"], "created"),
    note_updated_count: nestedCount(input["2b_compile_notes"], "updated"),
    note_repaired_count: nestedCount(input["2b_compile_notes"], "repaired"),
    note_unchanged_count: nestedCount(input["2b_compile_notes"], "unchanged"),
    note_failed_count: noteFailed,
    decision_digest_candidate_count: nestedCount(
      input["2c_compile_decision_digests"],
      "candidates",
    ),
    decision_digest_compiled_count: nestedCount(input["2c_compile_decision_digests"], "compiled"),
    decision_digest_skipped_count: nestedCount(input["2c_compile_decision_digests"], "skipped"),
    goal_backlog_indexed_count: summaryCount(input["2d_goal_backlog_index"]),
    contradiction_count: summaryCount(input["3_contradictions"]),
    phantom_person_count: summaryCount(input["3b_phantom_persons"]),
    edge_checked_count: nestedCount(input["3c_validate_edges"], "checked"),
    edge_confirmed_count: nestedCount(input["3c_validate_edges"], "confirmed"),
    edge_denied_count: nestedCount(input["3c_validate_edges"], "denied"),
    edge_unsure_count: nestedCount(input["3c_validate_edges"], "unsure"),
    edge_flagged_count: nestedCount(input["3c_validate_edges"], "flagged"),
    stale_count: summaryCount(input["4_stale"]),
    recurrence_materialized_count: summaryCount(input["5b_recurrence"]),
    metric_rollup_count: summaryCount(input["5_rollups"]),
    decision_review_count: summaryCount(input["6_decision_reviews"]),
    goal_review_count: summaryCount(input["6b_goal_reviews"]),
    backup_ran: record(input["7_backup"]).ran === true,
  });
}

// edges_repointed is a live post-cleanup snapshot — edges still touching the merge/retype
// target after self-referential drops and collision de-dupe run — not a raw count of rows a
// repoint UPDATE touched. retypeOrgToPerson and mergePersonIntoPerson (src/db/repo.ts) both
// compute it the same way so this key means one thing regardless of which repair wrote it.
type RepairCompleteCounts = {
  edges_repointed?: number;
  aliases_moved?: number;
  interactions_repointed?: number;
  transactions_recategorized?: number;
};

type RepairInput =
  | {
      script: "retype-org-to-person" | "merge-person" | "recategorize-transactions";
      phase: "complete";
      code: "repair_complete";
      counts?: RepairCompleteCounts;
      ids?: string[];
    }
  | {
      script: RepairScript;
      phase: "failed";
      code: Exclude<RepairCode, "repair_complete">;
      counts?: never;
      ids?: never;
    };

function repair(input: RepairInput): AuditPayload {
  const phase = fixed(input.phase, ["failed", "complete"]);
  const script = fixed(input.script, [
    "retype-org-to-person",
    "merge-person",
    "recategorize-transactions",
    "unknown",
  ]);
  const code =
    phase === "complete"
      ? fixed(input.code, ["repair_complete"])
      : fixed(input.code, [
          "repair_not_committed",
          "repair_module_failed",
          "repair_cleanup_failed",
          "repair_audit_failed",
          "repair_backup_failed",
          "repair_invalid_summary",
        ]);
  if (
    phase === "complete" &&
    script !== "retype-org-to-person" &&
    script !== "merge-person" &&
    script !== "recategorize-transactions"
  ) {
    invalidPayload();
  }
  if (phase === "failed" && (input.counts !== undefined || input.ids !== undefined)) {
    invalidPayload();
  }
  const counts: Record<string, number> = {};
  if (phase === "complete") {
    if (input.counts?.edges_repointed !== undefined) {
      counts.edges_repointed = nonNegativeInteger(input.counts.edges_repointed);
    }
    if (input.counts?.aliases_moved !== undefined) {
      counts.aliases_moved = nonNegativeInteger(input.counts.aliases_moved);
    }
    if (input.counts?.interactions_repointed !== undefined) {
      counts.interactions_repointed = nonNegativeInteger(input.counts.interactions_repointed);
    }
    if (input.counts?.transactions_recategorized !== undefined) {
      counts.transactions_recategorized = nonNegativeInteger(
        input.counts.transactions_recategorized,
      );
    }
  }
  return construct("repair", {
    script,
    phase,
    code,
    counts,
    ids: phase === "complete" ? uuids(input.ids ?? []) : Object.freeze([]),
  });
}

// W3-9: the weekly `restic check --read-data-subset` audit event. Content-free by construction --
// ok is the only field, so this can never carry a repository path, restic's own stderr, or any
// other detail; doctor.ts reads only this verb's timestamp (lastEventAt), never the payload.
function resticCheck(input: { ok: boolean }): AuditPayload {
  return construct("resticCheck", { ok: boolean(input.ok) });
}

// W3-11: the counts-only morning-brief notification. Every field is a bounded count or a
// boolean -- the exact same numbers buildBriefText (src/ops/push.ts) rendered into the
// delivered notification text, never a row title/question/name. Logged once per delivery
// attempt regardless of whether the delivery itself succeeded (that outcome is local-only,
// src/ops/ops-log.ts's job, not this audited-events row's).
function pushBrief(input: {
  events: number;
  tasksDue: number;
  decisionReviews: number;
  reviewItems: number;
  upcomingDates: number;
  maintenanceOk: boolean;
}): AuditPayload {
  return construct("pushBrief", {
    events: nonNegativeInteger(input.events),
    tasks_due: nonNegativeInteger(input.tasksDue),
    decision_reviews: nonNegativeInteger(input.decisionReviews),
    review_items: nonNegativeInteger(input.reviewItems),
    upcoming_dates: nonNegativeInteger(input.upcomingDates),
    maintenance_ok: boolean(input.maintenanceOk),
  });
}

function classifierKind(value: unknown): ClassifierKind {
  return fixed(value, ["task", "journal", "interaction", "note", "decision_note", "unknown"]);
}

function correctType(value: unknown): CorrectType {
  return fixed(value, ["journal", "interaction", "decision", "note"]);
}

// minime_correct's optional owner-supplied reason (W2-4 spec: "reason goes only into the audit
// payload allowlist, max 200 chars") — never the row's own content, just why it was corrected.
function correctionReason(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) invalidPayload();
  return value;
}

// minime_correct (W2-4): amend inserts a successor row and stamps the original superseded —
// carries only ids/type/tier, exactly the shape 028's superseded_by/superseded_at columns
// expose, never the row's own content (entry_md/summary/question/body_md).
function correctAmend(input: {
  type: CorrectType;
  oldId: string;
  newId: string;
  tier: 1 | 2;
  reason?: string;
}): AuditPayload {
  return construct("correctAmend", {
    type: correctType(input.type),
    old_id: uuid(input.oldId),
    new_id: uuid(input.newId),
    tier: routeTier(input.tier),
    ...(input.reason !== undefined ? { reason: correctionReason(input.reason) } : {}),
  });
}

// retract stamps superseded_at with no successor (soft withdrawal) — same id/type/tier shape,
// minus new_id since nothing is created.
function correctRetract(input: {
  type: CorrectType;
  id: string;
  tier: 1 | 2;
  reason?: string;
}): AuditPayload {
  return construct("correctRetract", {
    type: correctType(input.type),
    id: uuid(input.id),
    tier: routeTier(input.tier),
    ...(input.reason !== undefined ? { reason: correctionReason(input.reason) } : {}),
  });
}

// retier only ever promotes a note (page) from tier 1 to tier 2 — to_tier is fixed, never a
// caller-supplied value, so the payload itself proves the up-only invariant it audits. reason is
// optional like correctAmend/correctRetract's — minime_correct's schema and docstring accept it
// for every action, not just amend/retract.
function correctRetier(input: { id: string; fromTier: 1 | 2; reason?: string }): AuditPayload {
  return construct("correctRetier", {
    type: "note",
    id: uuid(input.id),
    from_tier: routeTier(input.fromTier),
    to_tier: 2,
    ...(input.reason !== undefined ? { reason: correctionReason(input.reason) } : {}),
  });
}

function personUpsertEntityType(value: unknown): PersonUpsertEntityType {
  return fixed(value, ["person", "org"]);
}

function personUpsertAction(value: unknown): PersonUpsertAction {
  return fixed(value, ["add_alias", "set_relation", "set_context", "rename"]);
}

// minime_upsert_person (W2-6): alias/relation/context/rename mutations on a person or org.
// Carries only the target's type/id and which action ran — never the alias text, relation
// label, context prose, or new name, all of which are content (mirrors correctAmend/
// correctRetract's id-only shape above).
function personUpsert(input: {
  entityType: PersonUpsertEntityType;
  entityId: string;
  action: PersonUpsertAction;
}): AuditPayload {
  return construct("personUpsert", {
    entity_type: personUpsertEntityType(input.entityType),
    entity_id: uuid(input.entityId),
    action: personUpsertAction(input.action),
  });
}

// entity:restore-tier (W4-2, src/cli.ts): the owner-CLI-only 2->1 identity demotion. Carries
// only the target's type/id -- never its canonical name, the same id-only shape as personUpsert
// above -- because this verb's own payload could otherwise become the one place a tier-2 name
// leaks into a tier-1-readable audit trail (`minime audit`, no unlock gate).
function entityTierRestored(input: {
  entityType: PersonUpsertEntityType;
  entityId: string;
}): AuditPayload {
  return construct("entityTierRestored", {
    entity_type: personUpsertEntityType(input.entityType),
    entity_id: uuid(input.entityId),
  });
}

// cli:tx:list / cli:health:list (W4-5, src/cli.ts `tx list` / `health list`): the owner-terminal
// tier-0 read surface's own audit trail — DECISIONS.md 2026-08-10, a recorded exception to "never
// log, print, or snapshot tier-0 contents" scoped to owner-TTY rendering with count-only audit.
// Every field is a bounded count, a fixed identifier (month/kind — never a merchant, category, or
// sample value), or a boolean; the match/from/to text the owner typed never reaches either
// payload. health list has no --match flag today, so its match_used is always false — kept in the
// shape anyway so both verbs share one vocabulary should health gain a match filter later.
function cliTxList(input: { month: string; rowCount: number; matchUsed: boolean }): AuditPayload {
  return construct("cliTxList", {
    month: yearMonth(input.month),
    row_count: nonNegativeInteger(input.rowCount),
    match_used: boolean(input.matchUsed),
  });
}

function cliHealthList(input: {
  kind: string;
  rowCount: number;
  matchUsed: boolean;
}): AuditPayload {
  return construct("cliHealthList", {
    kind: healthKind(input.kind),
    row_count: nonNegativeInteger(input.rowCount),
    match_used: boolean(input.matchUsed),
  });
}

// cli:metric:add (W4-8, src/cli.ts `metric:add`): the owner-CLI-only vetted-template metric
// creation path's own audit trail. Carries only the fixed template id and the newly minted
// metric name — never the --kind/--category/--merchant-pattern value the owner typed, matching
// cliTxList/cliHealthList's "count/identifier, never the searched-for text" posture above.
function cliMetricAdd(input: { metric: string; template: string }): AuditPayload {
  return construct("cliMetricAdd", {
    metric: metricId(input.metric),
    template: metricTemplateId(input.template),
  });
}

function inboxClosedExistingTask(input: { taskId: string; score: number }): AuditPayload {
  return construct("inboxClosedExistingTask", {
    task_id: uuid(input.taskId),
    score: ratio(input.score),
  });
}

function inboxDuplicate(input: { existingTaskId: string; score: number }): AuditPayload {
  return construct("inboxDuplicate", {
    existing_task_id: uuid(input.existingTaskId),
    score: ratio(input.score),
  });
}

function inboxSplitDecision(input: { taskId: string; decisionId: string }): AuditPayload {
  return construct("inboxSplitDecision", {
    task_id: uuid(input.taskId),
    decision_id: uuid(input.decisionId),
  });
}

function inboxSplitDoneTask(input: { decisionId: string; taskId: string }): AuditPayload {
  return construct("inboxSplitDoneTask", {
    decision_id: uuid(input.decisionId),
    task_id: uuid(input.taskId),
  });
}

function inboxSplitEntities(input: { orgIds: string[]; personIds: string[] }): AuditPayload {
  return construct("inboxSplitEntities", {
    org_ids: uuids(input.orgIds),
    person_ids: uuids(input.personIds),
    org_count: nonNegativeInteger(input.orgIds.length),
    person_count: nonNegativeInteger(input.personIds.length),
  });
}

function inboxFiled(input: {
  kind: ClassifierKind;
  confidence: number;
  filedTable: FiledTable;
  filedId: string;
}): AuditPayload {
  return construct("inboxFiled", {
    type: classifierKind(input.kind),
    confidence: ratio(input.confidence),
    filed_table: fixed(input.filedTable, [
      "tasks",
      "journal_entries",
      "interactions",
      "pages",
      "decisions",
    ]),
    filed_id: uuid(input.filedId),
  });
}

// minime_refile (W2-3): the owner CHOSE this type, so unlike inboxFiled there is no
// classifier confidence to record — confidence is fixed at 1 in the Classification built for
// fileRow and is not evidence worth auditing here.
function inboxRefiled(input: {
  type: ClassifierKind;
  filedTable: FiledTable;
  filedId: string;
}): AuditPayload {
  return construct("inboxRefiled", {
    type: classifierKind(input.type),
    filed_table: fixed(input.filedTable, [
      "tasks",
      "journal_entries",
      "interactions",
      "pages",
      "decisions",
    ]),
    filed_id: uuid(input.filedId),
  });
}

function inboxUnfiled(input: { kind: ClassifierKind; confidence: number }): AuditPayload {
  return construct("inboxUnfiled", {
    type: classifierKind(input.kind),
    confidence: ratio(input.confidence),
  });
}

function inboxOrphaned(): AuditPayload {
  return construct("inboxOrphaned", { reason: "missing_local_source" });
}

function inboxLegacyDuplicate(): AuditPayload {
  return construct("inboxLegacyDuplicate", { reason: "legacy_duplicate_identity" });
}

export const auditPayload = Object.freeze({
  cliHealthList,
  cliMetricAdd,
  cliTxList,
  correctAmend,
  correctRetier,
  correctRetract,
  dreamSummary,
  entityTierRestored,
  importMalformed,
  importSummary,
  inboxClosedExistingTask,
  inboxDuplicate,
  inboxFiled,
  inboxLegacyDuplicate,
  inboxOrphaned,
  inboxRefiled,
  inboxSplitDecision,
  inboxSplitDoneTask,
  inboxSplitEntities,
  inboxUnfiled,
  llmEgress,
  llmEgressOutcome,
  onboardComplete,
  personUpsert,
  pushBrief,
  repair,
  resticCheck,
  tier2Unlock,
  toolAttempt,
  toolDisposition,
  toolResult,
});

const AUDITED_TOOL_NAMES = new Set([
  "minime_agenda",
  "minime_capture",
  "minime_correct",
  "minime_get_context",
  "minime_journal",
  "minime_list_metrics",
  "minime_log_decision",
  "minime_log_expense",
  "minime_log_interaction",
  "minime_query_metric",
  "minime_refile",
  "minime_review_decision",
  "minime_review_queue",
  "minime_search",
  "minime_set_person_date",
  "minime_state",
  "minime_timeline",
  "minime_unlock",
  "minime_upsert_commitment",
  "minime_upsert_goal",
  "minime_upsert_person",
  "minime_upsert_task",
  "unknown",
]);

function expectedPayloadKind(verb: string, payload: AuditPayload): AuditPayloadKind {
  const tool = verb.match(/^tool:([^:]+)(?::(attempt|disposition))?$/);
  if (tool) {
    if (!AUDITED_TOOL_NAMES.has(tool[1]!)) invalidPayload();
    return tool[2] === "attempt"
      ? "toolAttempt"
      : tool[2] === "disposition"
        ? "toolDisposition"
        : "toolResult";
  }

  const fixedKinds: Readonly<Record<string, AuditPayloadKind>> = {
    "backup:restic-check": "resticCheck",
    "cli:health:list": "cliHealthList",
    "cli:metric:add": "cliMetricAdd",
    "cli:tx:list": "cliTxList",
    "correct:amend": "correctAmend",
    "correct:retier": "correctRetier",
    "correct:retract": "correctRetract",
    "dream:summary": "dreamSummary",
    "egress:classify": "llmClassifyEgress",
    "egress:classify:outcome": "llmClassifyOutcome",
    "egress:embed": "llmEmbedEgress",
    "egress:embed:outcome": "llmEmbedOutcome",
    "entity:tier:restored": "entityTierRestored",
    "import:malformed": "importMalformed",
    "import:rrule-unsupported": "importMalformed",
    "inbox:closed-existing-task": "inboxClosedExistingTask",
    "inbox:duplicate": "inboxDuplicate",
    "inbox:filed": "inboxFiled",
    "inbox:legacy-duplicate": "inboxLegacyDuplicate",
    "inbox:orphaned": "inboxOrphaned",
    "inbox:refiled": "inboxRefiled",
    "inbox:split-decision": "inboxSplitDecision",
    "inbox:split-done-task": "inboxSplitDoneTask",
    "inbox:split-entities": "inboxSplitEntities",
    "inbox:unfiled": "inboxUnfiled",
    "onboard:complete": "onboardComplete",
    "person:upsert": "personUpsert",
    "push:brief": "pushBrief",
    "unlock:tier2:approved": "tier2Unlock",
    "unlock:tier2:requested": "tier2Unlock",
    "unlock:tier2:revoked": "tier2Unlock",
  };
  const fixedKind = fixedKinds[verb];
  if (fixedKind) return fixedKind;

  const importerByVerb: Readonly<Record<string, AuditImporter>> = {
    "import:calendar": "calendar",
    "import:email-meta": "email_meta",
    "import:health": "health",
    "import:transactions": "transactions",
  };
  const importer = importerByVerb[verb];
  if (importer) {
    if (payload.importer !== importer) invalidPayload();
    return "importSummary";
  }

  const repairScriptByVerb: Readonly<Record<string, RepairScript>> = {
    "repair:retype-org-to-person": "retype-org-to-person",
    "repair:merge-person": "merge-person",
    "repair:recategorize-transactions": "recategorize-transactions",
    "repair:unknown": "unknown",
  };
  const script = repairScriptByVerb[verb];
  if (script) {
    if (payload.script !== script) invalidPayload();
    return "repair";
  }
  return invalidPayload();
}

export function assertAuditPayload(value: unknown): asserts value is AuditPayload {
  if (!value || typeof value !== "object" || !payloadKinds.has(value as object)) {
    throw new Error("invalid_audit_payload");
  }
}

export function assertAuditPayloadForVerb(
  verb: string,
  value: unknown,
): asserts value is AuditPayload {
  assertAuditPayload(value);
  if (payloadKinds.get(value as object) !== expectedPayloadKind(verb, value)) invalidPayload();
}
