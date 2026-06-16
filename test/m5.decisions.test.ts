// M5 acceptance e2e: log a decision with review_in_days=1, advance the (fake) clock,
// state shows the review due, dream enqueues it, review with a lesson creates a
// searchable principle linked back to the decision.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { dream } from "../src/pipeline/dream";
import { hybridSearch } from "../src/search/hybrid";
import { setNow } from "../src/util/clock";
import { resetAndSeed, testSql as sql } from "./helpers";

const ctx = { actor: "agent:test-harness" };
const call = async (name: string, params: any) => {
  const r = await invokeTool(toolByName(name), params, ctx);
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message}`);
  return r.envelope;
};

beforeAll(async () => {
  await resetAndSeed();
});

afterAll(() => setNow(null));

describe("decision engine", () => {
  test("full loop: log → clock advance → due in state → dream enqueues → review → principle searchable", async () => {
    const t0 = new Date();
    setNow(t0);

    const logged = await call("minime_log_decision", {
      question: "Should I trial the four-day workweek arrangement?",
      options: ["trial for a quarter", "decline"],
      choice: "trial for a quarter",
      reasoning: "Energy levels suggest compressed weeks could work.",
      expected_outcome: "Same output, better recovery",
      review_in_days: 1,
    });
    const decisionId = (logged.data as any).decision_id;

    // not yet due (review window is review_at <= today+3, so it IS visible at +1d… assert via dream queue instead)
    let state = await call("minime_state", {});
    expect((state.data as any).decision_reviews_due.map((d: any) => d.id)).toContain(decisionId);

    // advance two days: review is now strictly due; dream enqueues exactly once
    setNow(new Date(t0.getTime() + 2 * 86_400_000));
    state = await call("minime_state", {});
    expect((state.data as any).decision_reviews_due.map((d: any) => d.id)).toContain(decisionId);

    const dreamSummary = await dream();
    // B1 regression: step 7 must reach backup() and return its graceful skip — with restic
    // unconfigured it's "restic not configured…", NEVER "failed: backup is not defined"
    // (which is what a bare `export ... from` re-export with no local binding would yield).
    const backupStep = dreamSummary["7_backup"] as { ran: boolean; detail: string } | string;
    expect(backupStep).not.toBeString(); // a "failed: …" string would mean step() caught a throw
    expect((backupStep as { ran: boolean }).ran).toBe(false);
    expect((backupStep as { detail: string }).detail).not.toContain("is not defined");

    await dream(); // dedupe: second run must not double-queue
    const queued = await sql`select count(*)::int as n from review_queue
      where kind = 'decision_review' and payload ->> 'decision_id' = ${decisionId}`;
    expect(queued[0]!.n).toBe(1);

    // review with a lesson
    const reviewed = await call("minime_review_decision", {
      decision_id: decisionId,
      actual_outcome: "Output held steady; Fridays became deep work, not rest",
      lesson: "Guard recovery time explicitly or compressed weeks just compress more work in",
    });
    const principleId = (reviewed.data as any).principle_id;
    expect(principleId).toBeString();

    const [d] =
      await sql`select actual_outcome, reviewed_at, principle_id from decisions where id = ${decisionId}`;
    expect(d!.actual_outcome).toContain("Output held steady");
    expect(d!.reviewed_at).not.toBeNull();
    expect(d!.principle_id).toBe(principleId);

    const [p] =
      await sql`select rule, learned_from_decision, created_by from principles where id = ${principleId}`;
    expect(p!.learned_from_decision).toBe(decisionId);
    expect(p!.created_by).toBe("agent:test-harness");

    const [edge] = await sql`select count(*)::int as n from edges
      where src_type = 'principle' and src_id = ${principleId} and dst_id = ${decisionId}`;
    expect(edge!.n).toBe(1);

    // the lesson is findable via search (M5 AC)
    const hits = await hybridSearch({ query: "guard recovery time compressed weeks", limit: 5 });
    expect(hits.some((h) => h.id === principleId && h.type === "principle")).toBe(true);

    // reviewed decision no longer shows as due
    const after = await call("minime_state", {});
    expect((after.data as any).decision_reviews_due.map((x: any) => x.id)).not.toContain(
      decisionId,
    );
  });

  test("open decision (no choice) appears in state immediately", async () => {
    const logged = await call("minime_log_decision", {
      question: "Open question with no choice yet?",
      options: ["a", "b"],
    });
    expect((logged.data as any).open).toBe(true);
    const state = await call("minime_state", {});
    expect((state.data as any).decision_reviews_due.map((d: any) => d.id)).toContain(
      (logged.data as any).decision_id,
    );
  });

  // Regression: an open decision (choice IS NULL) reviewed via minime_review_decision
  // records actual_outcome + reviewed_at but never sets `choice`. reviewed_at must close
  // the loop on its own — otherwise the `choice is null` branch re-surfaces it forever.
  test("open decision reviewed without a choice drops off state (reviewed_at closes the loop)", async () => {
    const logged = await call("minime_log_decision", {
      question: "Meet Mia at violin class or go with Max?",
      options: ["meet Mia", "go with Max"],
    });
    const decisionId = (logged.data as any).decision_id;

    let state = await call("minime_state", {});
    expect((state.data as any).decision_reviews_due.map((d: any) => d.id)).toContain(decisionId);

    await call("minime_review_decision", {
      decision_id: decisionId,
      actual_outcome: "Went with Max; Mia was out sick",
    });
    const [d] = await sql`select reviewed_at, choice from decisions where id = ${decisionId}`;
    expect(d!.reviewed_at).not.toBeNull();
    expect(d!.choice).toBeNull(); // never set — the exact bug condition

    state = await call("minime_state", {});
    expect((state.data as any).decision_reviews_due.map((x: any) => x.id)).not.toContain(
      decisionId,
    );
  });
});
