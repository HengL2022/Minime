import { beforeAll, describe, expect, test } from "bun:test";
import { logEgressIntent, logEgressOutcome, logEvent } from "../src/db/repo";
import { auditPayload } from "../src/util/audit-payload";
import { resetDb, testSql } from "./helpers";

const SENTINEL = "audit-payload-private-prose-sentinel";

beforeAll(async () => {
  await resetDb();
});

describe("audit payload boundary", () => {
  test("logEvent rejects an arbitrary payload cast through any before inserting it", async () => {
    const [before] = await testSql`select count(*)::int as count from events`;

    await expect(
      logEvent({
        actor: "system:test",
        verb: "test:audit-payload-rejection",
        payload: {
          prose: SENTINEL,
          path: `/private/${SENTINEL}.md`,
        } as any,
      }),
    ).rejects.toThrow("invalid_audit_payload");
    await expect(
      logEvent({
        actor: "system:test",
        verb: "onboard:complete",
        entityType: "" as any,
        payload: auditPayload.onboardComplete({
          profile: 0,
          values: 0,
          goals: 0,
          principles: 0,
          people: 0,
          tasks: 0,
          journal: 0,
        }),
      }),
    ).rejects.toThrow("invalid_audit_payload");

    const [after] = await testSql`select count(*)::int as count from events`;
    expect(after!.count).toBe(before!.count);
  });

  test("logEvent requires a constructor payload bound to the exact event verb", async () => {
    const { auditPayload } = await import("../src/util/audit-payload");
    const calendar = auditPayload.importSummary({
      importer: "calendar",
      total: 1,
      inserted: 1,
      updated: 0,
      skipped: 0,
    });

    await expect(
      logEvent({ actor: "system:test", verb: "import:calendar" } as any),
    ).rejects.toThrow("invalid_audit_payload");
    await expect(
      logEvent({ actor: "system:test", verb: "import:email-meta", payload: calendar }),
    ).rejects.toThrow("invalid_audit_payload");
    await expect(
      logEvent({ actor: "system:test", verb: "dream:summary", payload: calendar }),
    ).rejects.toThrow("invalid_audit_payload");
    await expect(
      logEvent({
        actor: "system:test",
        verb: "tool:not_a_minime_tool",
        payload: auditPayload.toolResult({
          paramsHash: "0".repeat(16),
          returnedIds: [],
          returnedCount: 0,
          delivery: "direct",
        }),
      }),
    ).rejects.toThrow("invalid_audit_payload");
  });

  test("a named constructor persists only its allowlisted operational fields", async () => {
    const module = await import("../src/util/audit-payload");
    const constructors = (module as any).auditPayload;
    expect(typeof constructors?.importSummary).toBe("function");

    const payload = constructors.importSummary({
      importer: "calendar",
      total: 4,
      inserted: 2,
      updated: 1,
      skipped: 1,
      prose: SENTINEL,
      path: `/private/${SENTINEL}.ics`,
      nested: { detail: SENTINEL },
    });
    expect(JSON.stringify(payload)).not.toContain(SENTINEL);

    const eventId = await logEvent({
      actor: "importer:calendar",
      verb: "import:calendar",
      payload,
    });
    const [event] = await testSql`
      select payload from events where id = ${eventId}::bigint`;
    expect(event!.payload).toEqual({
      importer: "calendar",
      total: 4,
      inserted: 2,
      updated: 1,
      skipped: 1,
    });

    const malformedHealth = constructors.importMalformed({
      importer: "health",
      reason: "invalid_value",
      recordNumber: 7,
      kind: SENTINEL,
      prose: SENTINEL,
    });
    expect(malformedHealth).toEqual({
      importer: "health",
      reason: "invalid_value",
      record_number: 7,
    });
    expect(JSON.stringify(malformedHealth)).not.toContain(SENTINEL);

    const malformedEventId = await logEvent({
      actor: "importer:health",
      verb: "import:malformed",
      payload: malformedHealth,
    });
    const [malformedEvent] = await testSql`
      select payload from events where id = ${malformedEventId}::bigint`;
    expect(malformedEvent!.payload).toEqual({
      importer: "health",
      reason: "invalid_value",
      record_number: 7,
    });
  });

  test("the constructor surface is closed and validates identifier and code fields", async () => {
    const { auditPayload } = (await import("../src/util/audit-payload")) as any;
    expect(Object.keys(auditPayload).sort()).toEqual([
      "cliHealthList",
      "cliMetricAdd",
      "cliTxList",
      "correctAmend",
      "correctRetier",
      "correctRetract",
      "dreamSummary",
      "entityTierRestored",
      "importMalformed",
      "importSummary",
      "inboxClosedExistingTask",
      "inboxDuplicate",
      "inboxFiled",
      "inboxLegacyDuplicate",
      "inboxOrphaned",
      "inboxRefiled",
      "inboxSplitDecision",
      "inboxSplitDoneTask",
      "inboxSplitEntities",
      "inboxSplitIntents",
      "inboxUnfiled",
      "llmEgress",
      "llmEgressOutcome",
      "onboardComplete",
      "personUpsert",
      "pushBrief",
      "repair",
      "resticCheck",
      "tier2Unlock",
      "toolAttempt",
      "toolDisposition",
      "toolResult",
    ]);

    expect(() =>
      auditPayload.toolResult({
        paramsHash: "0".repeat(16),
        returnedIds: [`/private/${SENTINEL}.md`],
        returnedCount: 1,
        delivery: "transport",
      }),
    ).toThrow("invalid_audit_payload");
    expect(() =>
      auditPayload.toolResult({
        paramsHash: "0".repeat(16),
        returnedIds: [],
        returnedCount: 0,
        errorCode: `NOT VALID ${SENTINEL}`,
        delivery: "transport",
      }),
    ).toThrow("invalid_audit_payload");
    for (const contentLikeId of ["owner.secret@private.example", "PRIVATE_ACCOUNT_STATEMENT"]) {
      expect(() =>
        auditPayload.toolResult({
          paramsHash: "0".repeat(16),
          returnedIds: [contentLikeId],
          returnedCount: 1,
          delivery: "transport",
        }),
      ).toThrow("invalid_audit_payload");
    }
    expect(() =>
      auditPayload.toolResult({
        paramsHash: "0".repeat(16),
        returnedIds: [],
        returnedCount: 0,
        errorCode: "PRIVATE_ACCOUNT_STATEMENT",
        delivery: "transport",
      }),
    ).toThrow("invalid_audit_payload");
    expect(() =>
      auditPayload.importMalformed({
        importer: "calendar",
        reason: "invalid_date_or_amount",
        recordNumber: 1,
      } as any),
    ).toThrow("invalid_audit_payload");
    expect(() =>
      auditPayload.inboxSplitIntents({
        extraTypes: ["interaction"],
        extraTables: ["interactions", "pages"],
        extraIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).toThrow("invalid_audit_payload");
    const splitIntents = auditPayload.inboxSplitIntents({
      extraTypes: ["interaction", "note"],
      extraTables: ["interactions", "pages"],
      extraIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
      prose: SENTINEL,
    } as any);
    expect(splitIntents).toEqual({
      extra_count: 2,
      extra_types: ["interaction", "note"],
      extra_tables: ["interactions", "pages"],
      extra_ids: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    });
    expect(JSON.stringify(splitIntents)).not.toContain(SENTINEL);
  });

  test("dream summaries flatten fixed counters and omit failure messages and detail arrays", async () => {
    const { auditPayload } = (await import("../src/util/audit-payload")) as any;
    const payload = auditPayload.dreamSummary({
      "1_embed_backlog": 3,
      "2_entity_link": `failed: ${SENTINEL}`,
      "2b_compile_notes": {
        candidates: 2,
        created: 1,
        updated: 0,
        repaired: 0,
        unchanged: 0,
        failed: 1,
        results: [{ message: SENTINEL }],
      },
      "2c_compile_decision_digests": {
        candidates: 2,
        compiled: 1,
        skipped: 1,
        results: [{ path: `/private/${SENTINEL}.md` }],
      },
      "2d_goal_backlog_index": 4,
      "2e_compile_goal_digests": {
        candidates: 2,
        compiled: 1,
        skipped: 1,
        results: [{ path: `/private/${SENTINEL}.md` }],
      },
      "3_contradictions": 1,
      "3b_phantom_persons": 0,
      "3d_high_edge_orgs": 2,
      "3c_validate_edges": {
        checked: 4,
        confirmed: 2,
        denied: 1,
        unsure: 1,
        flagged: 2,
        byRule: { [SENTINEL]: { checked: 4, denied: 1 } },
      },
      "4_stale": 1,
      "5b_recurrence": 2,
      "5_rollups": 5,
      "6_decision_reviews": 1,
      "6b_goal_reviews": 2,
      "7_backup": { ran: false, detail: SENTINEL },
    });

    expect(payload).toEqual({
      status: "partial_failure",
      error_code: "dream_step_failed",
      failed_step_count: 1,
      failed_steps: ["2_entity_link"],
      embed_backlog_count: 3,
      entity_link_count: 0,
      note_candidate_count: 2,
      note_created_count: 1,
      note_updated_count: 0,
      note_repaired_count: 0,
      note_unchanged_count: 0,
      note_failed_count: 1,
      decision_digest_candidate_count: 2,
      decision_digest_compiled_count: 1,
      decision_digest_skipped_count: 1,
      goal_backlog_indexed_count: 4,
      goal_digest_candidate_count: 2,
      goal_digest_compiled_count: 1,
      goal_digest_skipped_count: 1,
      contradiction_count: 1,
      phantom_person_count: 0,
      high_edge_org_count: 2,
      edge_checked_count: 4,
      edge_confirmed_count: 2,
      edge_denied_count: 1,
      edge_unsure_count: 1,
      edge_flagged_count: 2,
      stale_count: 1,
      recurrence_materialized_count: 2,
      metric_rollup_count: 5,
      decision_review_count: 1,
      goal_review_count: 2,
      backup_ran: false,
    });
    expect(JSON.stringify(payload)).not.toContain(SENTINEL);
  });

  test("LLM egress keeps fixed provider metadata without prompt content", async () => {
    const { auditPayload } = (await import("../src/util/audit-payload")) as any;
    const payload = auditPayload.llmEgress({
      kind: "classify",
      provider: "openrouter",
      model: "qwen/qwen3-embedding-8b",
      items: 1,
      routeTier: 1,
      prompt: SENTINEL,
    });
    expect(payload).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3-embedding-8b",
      items: 1,
      route_tier: 1,
    });
    expect(JSON.stringify(payload)).not.toContain(SENTINEL);
  });

  test("LLM egress schemas reject impossible verbs, providers, counts, and intent pairing", async () => {
    const { auditPayload } = (await import("../src/util/audit-payload")) as any;
    for (const input of [
      { kind: "classify", provider: "ollama", model: "local", items: 1 },
      { kind: "classify", provider: "openai", model: "cloud", items: 0 },
      { kind: "embed", provider: "bedrock", model: "cloud", items: 1 },
      { kind: "embed", provider: "openai", model: "cloud", items: 1, routeTier: 1 },
    ]) {
      expect(() => auditPayload.llmEgress(input)).toThrow("invalid_audit_payload");
    }
    await expect(
      logEvent({
        actor: "system:llm",
        verb: "egress:classify:outcome",
        payload: auditPayload.llmEgressOutcome({
          kind: "embed",
          intentEventId: "1",
          status: "failed",
        }),
      }),
    ).rejects.toThrow("invalid_audit_payload");

    const embedIntent = await logEgressIntent({
      kind: "embed",
      provider: "openai",
      model: "text-embedding-3-small",
      items: 1,
    });
    await expect(
      logEgressOutcome({
        kind: "classify",
        intentEventId: embedIntent,
        status: "succeeded",
      }),
    ).rejects.toThrow("egress_outcome_intent_invalid");
    await logEgressOutcome({
      kind: "embed",
      intentEventId: embedIntent,
      status: "failed",
    });
  });

  test("repair audit phase/code pairs are discriminated at runtime", async () => {
    const { auditPayload } = (await import("../src/util/audit-payload")) as any;
    expect(() =>
      auditPayload.repair({
        script: "retype-org-to-person",
        phase: "complete",
        code: "repair_module_failed",
      }),
    ).toThrow("invalid_audit_payload");
    expect(() =>
      auditPayload.repair({
        script: "unknown",
        phase: "complete",
        code: "repair_complete",
      }),
    ).toThrow("invalid_audit_payload");
    expect(() =>
      auditPayload.repair({
        script: "retype-org-to-person",
        phase: "failed",
        code: "repair_module_failed",
        ids: [crypto.randomUUID()],
      }),
    ).toThrow("invalid_audit_payload");
  });

  test("resticCheck (W3-9) carries only {ok} and rejects a non-boolean", async () => {
    const { auditPayload, assertAuditPayloadForVerb } = (await import(
      "../src/util/audit-payload"
    )) as any;
    const payload = auditPayload.resticCheck({
      ok: true,
      prose: SENTINEL,
      path: `/private/${SENTINEL}.log`,
    });
    expect(payload).toEqual({ ok: true });
    expect(JSON.stringify(payload)).not.toContain(SENTINEL);
    expect(() => assertAuditPayloadForVerb("backup:restic-check", payload)).not.toThrow();
    expect(() => auditPayload.resticCheck({ ok: "true" })).toThrow("invalid_audit_payload");
    expect(() =>
      assertAuditPayloadForVerb(
        "backup:restic-check",
        auditPayload.repair({
          script: "unknown",
          phase: "failed",
          code: "repair_module_failed",
        }),
      ),
    ).toThrow("invalid_audit_payload");
  });

  test("entityTierRestored (W4-2) carries only entity_type/entity_id, never a name", async () => {
    const { auditPayload, assertAuditPayloadForVerb } = (await import(
      "../src/util/audit-payload"
    )) as any;
    const entityId = crypto.randomUUID();
    const payload = auditPayload.entityTierRestored({
      entityType: "person",
      entityId,
      canonical_name: SENTINEL,
      name: SENTINEL,
    });
    expect(payload).toEqual({ entity_type: "person", entity_id: entityId });
    expect(JSON.stringify(payload)).not.toContain(SENTINEL);
    expect(() => assertAuditPayloadForVerb("entity:tier:restored", payload)).not.toThrow();
    expect(() => auditPayload.entityTierRestored({ entityType: "team", entityId })).toThrow(
      "invalid_audit_payload",
    );
    expect(() =>
      auditPayload.entityTierRestored({ entityType: "person", entityId: SENTINEL }),
    ).toThrow("invalid_audit_payload");
    expect(() =>
      assertAuditPayloadForVerb(
        "entity:tier:restored",
        auditPayload.personUpsert({ entityType: "person", entityId, action: "rename" }),
      ),
    ).toThrow("invalid_audit_payload");
  });

  test("cliTxList/cliHealthList (W4-5) carry only {month|kind, row_count, match_used}, never a match string or row content", async () => {
    const { auditPayload, assertAuditPayloadForVerb } = (await import(
      "../src/util/audit-payload"
    )) as any;

    const txPayload = auditPayload.cliTxList({
      month: "2026-08",
      rowCount: 3,
      matchUsed: true,
      match: SENTINEL,
      merchant: SENTINEL,
    });
    expect(txPayload).toEqual({ month: "2026-08", row_count: 3, match_used: true });
    expect(JSON.stringify(txPayload)).not.toContain(SENTINEL);
    expect(() => assertAuditPayloadForVerb("cli:tx:list", txPayload)).not.toThrow();
    expect(() =>
      auditPayload.cliTxList({ month: "2026-8", rowCount: 0, matchUsed: false }),
    ).toThrow("invalid_audit_payload");
    expect(() =>
      auditPayload.cliTxList({ month: "2026-08", rowCount: -1, matchUsed: false }),
    ).toThrow("invalid_audit_payload");
    expect(() =>
      auditPayload.cliTxList({ month: "2026-08", rowCount: 0, matchUsed: "yes" }),
    ).toThrow("invalid_audit_payload");

    const healthPayload = auditPayload.cliHealthList({
      kind: "steps",
      rowCount: 0,
      matchUsed: false,
      value: SENTINEL,
    });
    expect(healthPayload).toEqual({ kind: "steps", row_count: 0, match_used: false });
    expect(JSON.stringify(healthPayload)).not.toContain(SENTINEL);
    expect(() => assertAuditPayloadForVerb("cli:health:list", healthPayload)).not.toThrow();
    expect(() =>
      auditPayload.cliHealthList({ kind: "Not Valid Kind", rowCount: 0, matchUsed: false }),
    ).toThrow("invalid_audit_payload");

    // Bound to its own exact verb, same closed-surface guarantee every other constructor has.
    expect(() => assertAuditPayloadForVerb("cli:health:list", txPayload)).toThrow(
      "invalid_audit_payload",
    );
    expect(() => assertAuditPayloadForVerb("cli:tx:list", healthPayload)).toThrow(
      "invalid_audit_payload",
    );
  });

  test("cliMetricAdd (W4-8) carries only {metric, template}, never the --kind/--category/--merchant-pattern value", async () => {
    const { auditPayload, assertAuditPayloadForVerb } = (await import(
      "../src/util/audit-payload"
    )) as any;

    const payload = auditPayload.cliMetricAdd({
      metric: "dining_spend",
      template: "spend-by-merchant",
      merchantPattern: SENTINEL,
      kind: SENTINEL,
    });
    expect(payload).toEqual({ metric: "dining_spend", template: "spend-by-merchant" });
    expect(JSON.stringify(payload)).not.toContain(SENTINEL);
    expect(() => assertAuditPayloadForVerb("cli:metric:add", payload)).not.toThrow();
    expect(() =>
      auditPayload.cliMetricAdd({ metric: "Not Valid Name", template: "health-sum" }),
    ).toThrow("invalid_audit_payload");
    expect(() =>
      auditPayload.cliMetricAdd({ metric: "dining_spend", template: "not-a-template" }),
    ).toThrow("invalid_audit_payload");
    expect(() =>
      assertAuditPayloadForVerb(
        "cli:metric:add",
        auditPayload.cliHealthList({ kind: "steps", rowCount: 0, matchUsed: false }),
      ),
    ).toThrow("invalid_audit_payload");
  });
});

// Every registered MCP tool must be in audit-payload's AUDITED_TOOL_NAMES allowlist, or its
// very first audited call fails as INTERNAL before execution (W1-2 found minime_list_metrics
// bricked this way). This guard makes the required lockstep update a test failure, not a
// runtime surprise for the next tool-adding change.
describe("audited tool-name allowlist", () => {
  test("accepts an attempt payload for every registered tool", async () => {
    const { ALL_TOOLS } = await import("../src/mcp/tools/index");
    const { assertAuditPayloadForVerb } = await import("../src/util/audit-payload");
    for (const tool of ALL_TOOLS) {
      const payload = auditPayload.toolAttempt({ paramsHash: "0".repeat(16) });
      expect(() => assertAuditPayloadForVerb(`tool:${tool.name}:attempt`, payload)).not.toThrow();
    }
  });
});
