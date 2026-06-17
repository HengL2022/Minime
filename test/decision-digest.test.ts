import { beforeEach, describe, expect, test } from "bun:test";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { brainSync } from "../src/pipeline/brain-sync";
import { compileDecisionDigests } from "../src/pipeline/decision-digest";
import { hybridSearch } from "../src/search/hybrid";
import { resetDb, testSql as sql } from "./helpers";

const ctx = { actor: "agent:decision-digest-test" };
const call = async (name: string, params: any) => {
  const r = await invokeTool(toolByName(name), params, ctx);
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message}`);
  return r.envelope;
};

async function digestPage(decisionId: string): Promise<any | null> {
  const [row] = await sql`select * from pages where path = ${`derived/decisions/${decisionId}.md`}`;
  return row ?? null;
}

beforeEach(async () => {
  await resetDb();
});

describe("decision digest pages", () => {
  test("log writes an inline draft digest; dream replaces it with a dream digest", async () => {
    const logged = await call("minime_log_decision", {
      question: "Use the Osaka residency for a writing sprint?",
      options: ["take residency", "stay home"],
      choice: "take residency",
      reasoning: "The residency removes meetings for two weeks.",
      expected_outcome: "Finish the first manuscript draft",
      falsifier: "Remote meetings stay heavy during the residency",
      confidence: 70,
      transcript: [
        {
          question_key: "fork",
          prompt: "What were the options?",
          answer: "Take the residency or stay home.",
        },
      ],
    });
    const decisionId = (logged.data as any).decision_id;

    const draft = await digestPage(decisionId);
    expect(draft).not.toBeNull();
    expect(draft.source).toBe("dream:decision-digest");
    expect(draft.created_by).toBe("system:dream");
    expect(draft.derived_from).toBe(decisionId);
    expect(draft.body_md).toContain("compiler: inline-draft");
    expect(draft.body_md).toContain("## Source\n- decision:");
    const [draftChunks] =
      await sql`select count(*)::int as n from chunks where parent_type = 'page' and parent_id = ${draft.id}`;
    expect(draftChunks!.n).toBeGreaterThan(0);

    const result = await compileDecisionDigests();
    expect(result.compiled).toBe(1);
    const dream = await digestPage(decisionId);
    expect(dream.body_md).toContain("compiler: dream");
    expect(dream.body_md).toContain("## Situation");
    expect(dream.body_md).toContain("## Past-me decided");
    expect(dream.body_md).toContain("## Takeaway");
  });

  test("review marks a dream digest stale and recompiles with the outcome", async () => {
    const logged = await call("minime_log_decision", {
      question: "Keep the launch scope small?",
      options: ["small launch", "full launch"],
      choice: "small launch",
      expected_outcome: "Fewer bugs and faster release",
    });
    const decisionId = (logged.data as any).decision_id;
    await compileDecisionDigests();
    const before = await digestPage(decisionId);
    expect(before.body_md).toContain("compiler: dream");

    await new Promise((r) => setTimeout(r, 10));
    await call("minime_review_decision", {
      decision_id: decisionId,
      actual_outcome: "Small launch shipped on time with only one support issue",
      outcome_score: 90,
    });
    const result = await compileDecisionDigests();
    expect(result.compiled).toBe(1);
    const after = await digestPage(decisionId);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.body_md).toContain("Small launch shipped on time");
    expect(after.body_md).toContain("90/100");
  });

  test("digest inherits tier and ranks above raw decision for situation-shaped query", async () => {
    const logged = await call("minime_log_decision", {
      question: "Use a short vendor trial before committing to annual billing?",
      options: ["short vendor trial", "annual billing now"],
      choice: "short vendor trial",
      reasoning: "Unknown support quality makes annual billing risky.",
      expected_outcome: "Learn support quality before spending the annual budget",
      tier: 2,
    });
    const decisionId = (logged.data as any).decision_id;
    await compileDecisionDigests();
    const digest = await digestPage(decisionId);
    expect(digest.tier).toBe(2);
    await brainSync();
    const afterSync = await digestPage(decisionId);
    expect(afterSync.tier).toBe(2);

    const locked = await hybridSearch({
      query: "uncertain vendor support quality before annual billing",
      types: ["page", "decision"],
      includeDerived: true,
      limit: 5,
      actor: "agent:locked",
    });
    expect(locked.some((h) => h.id === digest.id || h.id === decisionId)).toBe(false);

    await invokeTool(toolByName("minime_unlock"), { minutes: 5 }, ctx);
    const hits = await hybridSearch({
      query: "uncertain vendor support quality before annual billing",
      types: ["page", "decision"],
      includeDerived: true,
      limit: 5,
      actor: ctx.actor,
    });
    const digestRank = hits.findIndex((h) => h.id === digest.id);
    const rawRank = hits.findIndex((h) => h.id === decisionId);
    expect(digestRank).toBeGreaterThanOrEqual(0);
    expect(rawRank).toBeGreaterThanOrEqual(0);
    expect(digestRank).toBeLessThan(rawRank);
  });

  test("digest tier is the max of decision, transcript, and branch sources", async () => {
    const logged = await call("minime_log_decision", {
      question: "Use the private appendix in the public strategy memo?",
      options: ["include appendix", "omit appendix"],
      choice: "omit appendix",
      tier: 1,
    });
    const decisionId = (logged.data as any).decision_id;
    await sql`
      insert into decision_transcripts (decision_id, ord, question_key, prompt, answer, tier)
      values (${decisionId}, 1, 'stakes', 'What is sensitive?', 'Private appendix details', 2)`;
    await compileDecisionDigests();
    const digest = await digestPage(decisionId);
    expect(digest.tier).toBe(2);
    expect(digest.body_md).toContain("decision_transcript:");
  });

  test("digest and chunks re-tier when a source tier changes without changing digest text", async () => {
    const logged = await call("minime_log_decision", {
      question: "Publish the internal launch appendix?",
      options: ["publish appendix", "keep appendix private"],
      choice: "keep appendix private",
      branches: [
        {
          label: "publish appendix",
          status: "rejected",
          note: "Could help explain the launch.",
        },
        { label: "keep appendix private", status: "chosen" },
      ],
      tier: 1,
    });
    const decisionId = (logged.data as any).decision_id;
    await compileDecisionDigests();
    const first = await digestPage(decisionId);
    expect(first.tier).toBe(1);

    const [branch] =
      await sql`select id from decision_branches where decision_id = ${decisionId} and status = 'rejected'`;
    await sql`update decision_branches set tier = 2 where id = ${branch!.id}`;
    const result = await compileDecisionDigests();
    expect(result.compiled).toBe(1);

    const retiered = await digestPage(decisionId);
    expect(retiered.body_md).toBe(first.body_md);
    expect(retiered.tier).toBe(2);
    const [chunks] =
      await sql`select min(tier)::int as min_tier, max(tier)::int as max_tier from chunks where parent_type = 'page' and parent_id = ${retiered.id}`;
    expect(chunks!.min_tier).toBe(2);
    expect(chunks!.max_tier).toBe(2);

    const locked = await hybridSearch({
      query: "internal launch appendix",
      types: ["page", "decision"],
      includeDerived: true,
      limit: 5,
      actor: "agent:locked",
    });
    expect(locked.some((h) => h.id === retiered.id)).toBe(false);
  });
});
