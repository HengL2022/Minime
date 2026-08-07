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
      "dreamSummary",
      "importMalformed",
      "importSummary",
      "inboxClosedExistingTask",
      "inboxDuplicate",
      "inboxFiled",
      "inboxLegacyDuplicate",
      "inboxOrphaned",
      "inboxSplitDecision",
      "inboxSplitDoneTask",
      "inboxUnfiled",
      "llmEgress",
      "llmEgressOutcome",
      "onboardComplete",
      "repair",
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
      "3_contradictions": 1,
      "3b_phantom_persons": 0,
      "3c_validate_edges": {
        checked: 4,
        confirmed: 2,
        denied: 1,
        unsure: 1,
        flagged: 2,
        byRule: { [SENTINEL]: { checked: 4, denied: 1 } },
      },
      "4_stale": 1,
      "5_rollups": 5,
      "6_decision_reviews": 1,
      "7_backup": { ran: false, detail: SENTINEL },
    });

    expect(payload).toEqual({
      status: "partial_failure",
      error_code: "dream_step_failed",
      failed_step_count: 1,
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
      contradiction_count: 1,
      phantom_person_count: 0,
      edge_checked_count: 4,
      edge_confirmed_count: 2,
      edge_denied_count: 1,
      edge_unsure_count: 1,
      edge_flagged_count: 2,
      stale_count: 1,
      metric_rollup_count: 5,
      decision_review_count: 1,
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
});
