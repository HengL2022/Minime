// M5 acceptance e2e: log a decision with review_in_days=1, advance the (fake) clock,
// state shows the review due, dream enqueues it, review with a lesson creates a
// searchable principle linked back to the decision.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { insertDecision } from "../src/db/repo";
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

  test("full six-question interview round-trips through log and get_context", async () => {
    const transcript = [
      {
        question_key: "fork",
        prompt: "What were you actually choosing between — and what did you almost do instead?",
        answer: "Choose CoreWeave now or wait for the next AWS quota window.",
      },
      {
        question_key: "falsifier",
        prompt: "What would have to be true for the option you rejected to be the right one?",
        answer: "Waiting would be right if AWS can guarantee H100 capacity before July.",
      },
      {
        question_key: "tension",
        prompt: "Where's the tension — what's making this hard?",
        answer: "CoreWeave is faster but adds vendor complexity.",
      },
      {
        question_key: "prediction",
        prompt: "What do you predict happens, and how sure are you?",
        answer: "The prototype ships two weeks earlier; confidence 75.",
      },
      {
        question_key: "stakes",
        prompt: "What are the stakes, and how reversible is it?",
        answer: "Medium stakes and costly to reverse after data migration.",
      },
      {
        question_key: "review",
        prompt: "When should we check whether you were right?",
        answer: "Review on 2026-08-01.",
      },
    ];

    const logged = await call("minime_log_decision", {
      question: "Use CoreWeave for the prototype GPU run?",
      options: ["use CoreWeave", "wait for AWS"],
      choice: "use CoreWeave",
      reasoning: "Capacity matters more than vendor simplicity this month.",
      expected_outcome: "Prototype ships two weeks earlier",
      falsifier: "AWS guarantees H100 capacity before July",
      stakes: "Medium delivery risk; costly migration if wrong",
      reversibility: "costly",
      confidence: 75,
      decided_at: "2026-06-10",
      review_at: "2026-08-01",
      transcript,
      branches: [
        {
          label: "use CoreWeave",
          status: "chosen",
          note: "Fastest path to capacity",
        },
        {
          label: "wait for AWS",
          status: "rejected",
          would_be_right_if: "AWS guarantees H100 capacity before July",
        },
      ],
    });
    const decisionId = (logged.data as any).decision_id;
    expect((logged.data as any).review_at).toBe("2026-08-01");

    const [decision] = await sql`
      select falsifier, stakes, reversibility, confidence, decided_at::date as decided_at, review_at
      from decisions where id = ${decisionId}`;
    expect(decision!.falsifier).toBe("AWS guarantees H100 capacity before July");
    expect(decision!.stakes).toContain("Medium delivery risk");
    expect(decision!.reversibility).toBe("costly");
    expect(decision!.confidence).toBe(75);
    expect(new Date(decision!.decided_at).toISOString().slice(0, 10)).toBe("2026-06-10");
    expect(new Date(decision!.review_at).toISOString().slice(0, 10)).toBe("2026-08-01");

    const context = await call("minime_get_context", { type: "decision", id: decisionId });
    const data = context.data as any;
    expect(data.transcript.map((t: any) => t.question_key)).toEqual([
      "fork",
      "falsifier",
      "tension",
      "prediction",
      "stakes",
      "review",
    ]);
    expect(data.transcript[0].answer).toContain("CoreWeave");
    expect(data.branches.map((b: any) => [b.label, b.status]).sort()).toEqual(
      [
        ["use CoreWeave", "chosen"],
        ["wait for AWS", "rejected"],
      ].sort(),
    );

    const [edgeCount] = await sql`
      select count(*)::int as n from edges
      where src_type = 'decision' and src_id = ${decisionId}
        and dst_type = 'decision_branch'
        and rel in ('chose','rejected')`;
    expect(edgeCount!.n).toBe(2);
  });

  test("date-only decided_at stores local noon in the caller timezone", async () => {
    const logged = await call("minime_log_decision", {
      question: "Backfill a Los Angeles decision?",
      options: ["yes", "no"],
      choice: "yes",
      decided_at: "2026-06-10",
      time_zone: "America/Los_Angeles",
    });
    const [decision] =
      await sql`select decided_at from decisions where id = ${(logged.data as any).decision_id}`;
    expect(decision!.decided_at.toISOString()).toBe("2026-06-10T19:00:00.000Z");
  });

  test("decision interview schema rejects invalid tool input", async () => {
    const badConfidence = await invokeTool(
      toolByName("minime_log_decision"),
      {
        question: "Bad confidence?",
        options: ["yes"],
        confidence: 150,
      },
      ctx,
    );
    expect(badConfidence.ok).toBe(false);

    const badReversibility = await invokeTool(
      toolByName("minime_log_decision"),
      {
        question: "Bad reversibility?",
        options: ["yes"],
        reversibility: "forever-ish",
      },
      ctx,
    );
    expect(badReversibility.ok).toBe(false);

    const badQuestionKey = await invokeTool(
      toolByName("minime_log_decision"),
      {
        question: "Bad question key?",
        options: ["yes"],
        transcript: [{ question_key: "oops", prompt: "Q", answer: "A" }],
      },
      ctx,
    );
    expect(badQuestionKey.ok).toBe(false);

    const badDecidedAt = await invokeTool(
      toolByName("minime_log_decision"),
      {
        question: "Bad decided_at?",
        options: ["yes"],
        decided_at: "not-a-date",
      },
      ctx,
    );
    expect(badDecidedAt.ok).toBe(false);
    if (!badDecidedAt.ok) expect(badDecidedAt.error.code).toBe("BAD_INPUT");

    const nonIsoDecidedAt = await invokeTool(
      toolByName("minime_log_decision"),
      {
        question: "Non-ISO decided_at?",
        options: ["yes"],
        decided_at: "06/10/2026",
      },
      ctx,
    );
    expect(nonIsoDecidedAt.ok).toBe(false);
    if (!nonIsoDecidedAt.ok) expect(nonIsoDecidedAt.error.code).toBe("BAD_INPUT");

    const impossibleReviewAt = await invokeTool(
      toolByName("minime_log_decision"),
      {
        question: "Impossible review_at?",
        options: ["yes"],
        review_at: "2026-99-99",
      },
      ctx,
    );
    expect(impossibleReviewAt.ok).toBe(false);
    if (!impossibleReviewAt.ok) expect(impossibleReviewAt.error.code).toBe("BAD_INPUT");

    const badBranch = await invokeTool(
      toolByName("minime_log_decision"),
      {
        question: "Bad branch?",
        options: ["yes"],
        branches: [{ label: "yes", status: "maybe" }],
      },
      ctx,
    );
    expect(badBranch.ok).toBe(false);
  });

  test("repo rejects tier-0 decisions before writing projections", async () => {
    await expect(
      insertDecision({
        question: "Can a decision be tier zero?",
        options: ["no"],
        tier: 0,
      }),
    ).rejects.toThrow(/decision tier must be 1 or 2/);
    const [count] =
      await sql`select count(*)::int as n from decisions where question = 'Can a decision be tier zero?'`;
    expect(count!.n).toBe(0);
  });

  test("review stores outcome score and branch rows are searchable", async () => {
    const logged = await call("minime_log_decision", {
      question: "Switch analytics warehouse to DuckDB first?",
      options: ["switch to DuckDB", "stay on Postgres"],
      choice: "stay on Postgres",
      branches: [
        {
          label: "switch to DuckDB",
          status: "rejected",
          would_be_right_if: "local laptop queries are the bottleneck",
        },
        { label: "stay on Postgres", status: "chosen", note: "Operational simplicity wins" },
      ],
    });
    const decisionId = (logged.data as any).decision_id;

    await call("minime_review_decision", {
      decision_id: decisionId,
      actual_outcome: "Postgres stayed boring and fast enough",
      outcome_score: 80,
    });
    const [decision] = await sql`select outcome_score from decisions where id = ${decisionId}`;
    expect(decision!.outcome_score).toBe(80);

    const hits = await hybridSearch({
      query: "local laptop queries bottleneck",
      types: ["decision_branch"],
      limit: 5,
    });
    expect(hits.some((h) => h.type === "decision_branch" && h.title === "switch to DuckDB")).toBe(
      true,
    );
  });
});
