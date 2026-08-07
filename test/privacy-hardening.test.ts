// Regression tests for MCP-visible tier leaks found during the database review.
// Locked tier-2 metadata must not escape through convenience fanouts, graph edges,
// or review-queue payloads.

import { beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  chunkPairsSharingPerson,
  chunksMissingEmbedding,
  edgesAround,
  entitiesNamedIn,
  ftsCandidates,
  listActivePages,
  parentsNeedingExtraction,
} from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { expectSqlReject, resetDb, testSql as sql } from "./helpers";
import { dropTestAppRole, mintTestAppRole } from "./support/app-role";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

const ctx = sessionToolCtx("agent:privacy-test");
const ctxAlice = sessionToolCtx("agent:alice");
const ctxBob = sessionToolCtx("agent:bob");

beforeEach(async () => {
  await resetDb();
});

describe("tier-2 privacy hardening", () => {
  test("state and agenda hide tier-2 task, commitment, and decision metadata while locked", async () => {
    await sql`delete from session_unlocks`;
    const taskTitle = "ZQX-TIER2-STATE-TASK";
    const commitmentTitle = "ZQX-TIER2-STATE-COMMITMENT";
    const decisionQuestion = "ZQX-TIER2-STATE-DECISION";

    await sql`
      insert into tasks (title, status, due, tier)
      values (${taskTitle}, 'active', '2000-01-01', 2)`;
    await sql`
      insert into commitments (what, to_whom, status, due, tier)
      values (${commitmentTitle}, 'Alex Privacy', 'open', '2000-01-02', 2)`;
    await sql`
      insert into decisions (question, options, tier)
      values (${decisionQuestion}, ${sql.json(["yes", "no"])}, 2)`;

    const state = await invokeTool(toolByName("minime_state"), {}, ctx);
    const agenda = await invokeTool(
      toolByName("minime_agenda"),
      { from: "2000-01-01", to: "2000-01-03" },
      ctx,
    );

    const text = JSON.stringify({ state, agenda });
    expect(text).not.toContain(taskTitle);
    expect(text).not.toContain(commitmentTitle);
    expect(text).not.toContain(decisionQuestion);
  });

  test("get_context hides tier-2 graph edges and open person items while locked", async () => {
    await sql`delete from session_unlocks`;
    const taskTitle = "ZQX-TIER2-CONTEXT-TASK";
    const commitmentTitle = "ZQX-TIER2-CONTEXT-COMMITMENT";
    const journalText = "ZQX-TIER2-CONTEXT-JOURNAL";

    const [person] = await sql`
      insert into people (canonical_name, tier)
      values ('Alex Privacy', 1)
      returning id`;
    const [journal] = await sql`
      insert into journal_entries (entry_md, tier)
      values (${journalText}, 2)
      returning id`;
    const [edge] = await sql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
      values ('journal', ${journal!.id}, 'mentions', 'person', ${person!.id},
              'journal_entries', ${journal!.id}, 'system:test')
      returning id`;
    const [task] = await sql`
      insert into tasks (title, status, due, tier)
      values (${`${taskTitle} for Alex Privacy`}, 'active', '2000-01-01', 2)
      returning id`;
    const [commitment] = await sql`
      insert into commitments (what, to_whom, status, tier)
      values (${commitmentTitle}, 'Alex Privacy', 'open', 2)
      returning id`;
    const [marker] = await sql`select coalesce(max(id), 0)::bigint as id from events`;

    const result = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "Alex Privacy" },
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(taskTitle);
    expect(JSON.stringify(result)).not.toContain(commitmentTitle);
    expect(JSON.stringify(result)).not.toContain(String(journal!.id));
    if (!result.ok) throw new Error(result.error.message);
    const returnedIds = result.envelope.sources.map((source) => source.id);
    expect(returnedIds).not.toContain(edge!.id);
    expect(returnedIds).not.toContain(task!.id);
    expect(returnedIds).not.toContain(commitment!.id);

    const [resultEvent] = await sql`
      select payload
      from events
      where id > ${marker!.id}::bigint
        and actor = ${ctx.actor}
        and verb = 'tool:minime_get_context'
      order by id desc
      limit 1`;
    expect(resultEvent!.payload.returned_ids).toEqual(returnedIds);
    expect(resultEvent!.payload.returned_count).toBe(returnedIds.length);
    expect(resultEvent!.payload.returned_ids).not.toContain(edge!.id);
    expect(resultEvent!.payload.returned_ids).not.toContain(task!.id);
    expect(resultEvent!.payload.returned_ids).not.toContain(commitment!.id);
  });

  test("review queue masks legacy tier-2 titles and questions while locked", async () => {
    await sql`delete from session_unlocks`;
    const taskTitle = "ZQX-TIER2-QUEUE-TASK";
    const candidateTitle = "ZQX-TIER2-QUEUE-CANDIDATE";
    const decisionQuestion = "ZQX-TIER2-QUEUE-DECISION";

    const [task] = await sql`
      insert into tasks (title, status, tier)
      values (${taskTitle}, 'active', 2)
      returning id`;
    const [decision] = await sql`
      insert into decisions (question, options, tier)
      values (${decisionQuestion}, ${sql.json(["yes", "no"])}, 2)
      returning id`;
    await sql`
      insert into review_queue (kind, payload)
      values
        ('duplicate', ${sql.json({
          existing_task_id: task!.id,
          existing_title: taskTitle,
          candidate_title: candidateTitle,
        })}),
        ('decision_review', ${sql.json({
          decision_id: decision!.id,
          question: decisionQuestion,
        })})`;

    const result = await invokeTool(toolByName("minime_review_queue"), { action: "list" }, ctx);

    const text = JSON.stringify(result);
    expect(text).not.toContain(taskTitle);
    expect(text).not.toContain(candidateTitle);
    expect(text).not.toContain(decisionQuestion);
  });

  test("tier-2 unlocks are scoped to the requesting actor", async () => {
    await sql`delete from session_unlocks`;
    const taskTitle = "ZQX-ACTOR-SCOPED-TASK";
    const pageTitle = "ZQX-ACTOR-SCOPED-PAGE";
    const pageText = "ZQX-ACTOR-SCOPED-SEARCH needle";
    const journalText = "ZQX-ACTOR-SCOPED-JOURNAL";

    const [task] = await sql`
      insert into tasks (title, status, due, tier)
      values (${taskTitle}, 'active', '2000-01-01', 2)
      returning id`;
    const [page] = await sql`
      insert into pages (path, title, body_md, content_hash, tier)
      values ('actor-scoped.md', ${pageTitle}, ${pageText}, 'actor-scoped', 2)
      returning id`;
    await sql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${page!.id}, 0, ${pageText}, 2)`;
    const [person] = await sql`
      insert into people (canonical_name, tier)
      values ('Actor Scoped Person', 1)
      returning id`;
    const [journal] = await sql`
      insert into journal_entries (entry_md, tier)
      values (${journalText}, 2)
      returning id`;
    await sql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
      values ('journal', ${journal!.id}, 'mentions', 'person', ${person!.id},
              'journal_entries', ${journal!.id}, 'system:test')`;
    await sql`
      insert into review_queue (kind, payload)
      values ('duplicate', ${sql.json({
        existing_task_id: task!.id,
        existing_title: taskTitle,
      })})`;

    await requestAndApproveTier2(ctxAlice);

    const aliceState = await invokeTool(toolByName("minime_state"), {}, ctxAlice);
    const bobState = await invokeTool(toolByName("minime_state"), {}, ctxBob);
    const aliceSearch = await invokeTool(
      toolByName("minime_search"),
      { query: "ACTOR SCOPED SEARCH needle", limit: 5 },
      ctxAlice,
    );
    const bobSearch = await invokeTool(
      toolByName("minime_search"),
      { query: "ACTOR SCOPED SEARCH needle", limit: 5 },
      ctxBob,
    );
    const aliceContext = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "Actor Scoped Person" },
      ctxAlice,
    );
    const bobContext = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "Actor Scoped Person" },
      ctxBob,
    );
    const aliceQueue = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list" },
      ctxAlice,
    );
    const bobQueue = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list" },
      ctxBob,
    );

    expect(JSON.stringify(aliceState)).toContain(taskTitle);
    expect(JSON.stringify(aliceSearch)).toContain(pageTitle);
    expect(JSON.stringify(aliceContext)).toContain(String(journal!.id));
    expect(JSON.stringify(aliceQueue)).toContain(taskTitle);

    const bobText = JSON.stringify({ bobState, bobSearch, bobContext, bobQueue });
    expect(bobText).not.toContain(taskTitle);
    expect(bobText).not.toContain(pageTitle);
    expect(bobText).not.toContain(pageText);
    expect(bobText).not.toContain(String(journal!.id));
  });

  test("decision transcripts and branches stay hidden while tier-2 decision is locked", async () => {
    await sql`delete from session_unlocks`;
    const secretTranscript = "ZQX-TIER2-DECISION-TRANSCRIPT";
    const secretBranch = "ZQX-TIER2-DECISION-BRANCH";
    const logged = await invokeTool(
      toolByName("minime_log_decision"),
      {
        question: "Private tier-2 decision?",
        options: [secretBranch, "plain option"],
        choice: secretBranch,
        tier: 2,
        transcript: [{ question_key: "fork", prompt: "Q", answer: secretTranscript }],
        branches: [{ label: secretBranch, status: "chosen" }],
      },
      ctxAlice,
    );
    if (!logged.ok) throw new Error(logged.error.message);
    const decisionId = (logged.envelope.data as any).decision_id;
    const [branchChunks] = await sql`
      select count(*)::int as n
      from chunks c
      join decision_branches b on b.id = c.parent_id
      where c.parent_type = 'decision_branch' and b.decision_id = ${decisionId}`;
    expect(branchChunks!.n).toBeGreaterThan(0);

    const locked = await invokeTool(
      toolByName("minime_get_context"),
      { type: "decision", id: decisionId },
      ctxBob,
    );
    expect(locked.ok).toBe(false);
    expect(JSON.stringify(locked)).not.toContain(secretTranscript);
    expect(JSON.stringify(locked)).not.toContain(secretBranch);

    await requestAndApproveTier2(ctxAlice);
    const unlocked = await invokeTool(
      toolByName("minime_get_context"),
      { type: "decision", id: decisionId },
      ctxAlice,
    );
    expect(unlocked.ok).toBe(true);
    expect(JSON.stringify(unlocked)).toContain(secretTranscript);
    expect(JSON.stringify(unlocked)).toContain(secretBranch);
  });

  test("get_context hides mixed-tier decision branch graph edges while locked", async () => {
    await sql`delete from session_unlocks`;
    const secretBranch = "ZQX-MIXED-TIER-BRANCH";
    const logged = await invokeTool(
      toolByName("minime_log_decision"),
      {
        question: "Can the public decision reference a private branch?",
        options: ["public branch", "private branch"],
        choice: "public branch",
        branches: [
          { label: "public branch", status: "chosen" },
          { label: secretBranch, status: "rejected" },
        ],
        tier: 1,
      },
      ctxAlice,
    );
    if (!logged.ok) throw new Error(logged.error.message);
    const decisionId = (logged.envelope.data as any).decision_id;
    const [branch] =
      await sql`select id from decision_branches where decision_id = ${decisionId} and label = ${secretBranch}`;
    await sql`update decision_branches set tier = 2 where id = ${branch!.id}`;

    const locked = await invokeTool(
      toolByName("minime_get_context"),
      { type: "decision", id: decisionId },
      ctxBob,
    );
    expect(locked.ok).toBe(true);
    const text = JSON.stringify(locked);
    expect(text).not.toContain(secretBranch);
    expect(text).not.toContain(String(branch!.id));
  });

  test("owner-role search, list, graph, extraction, embedding, and contradiction reads exclude tier-zero prose", async () => {
    const sentinel = "OWNER-TIER0-PROSE-SENTINEL";
    const [person] = await sql`
      insert into people (canonical_name, tier) values ('Owner Zero Person', 0) returning id`;
    const [page] = await sql`
      insert into pages (path, title, body_md, content_hash, tier, status)
      values ('owner-zero.md', 'Owner Zero', ${sentinel}, 'owner-zero', 0, 'active')
      returning id`;
    const chunks = await sql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values
        ('page', ${page!.id}, 0, ${`${sentinel} first`}, 0),
        ('page', ${page!.id}, 1, ${`${sentinel} second`}, 0)
      returning id`;
    for (const chunk of chunks) {
      await sql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by)
        values
          ('page', ${page!.id}, 'mentions', 'person', ${person!.id},
           'chunks', ${chunk.id}, 0, 'test:owner-tier-zero')`;
    }

    expect((await ftsCandidates(sentinel, null)).some((row) => row.text.includes(sentinel))).toBe(
      false,
    );
    expect((await listActivePages()).some((row) => row.id === page!.id)).toBe(false);
    expect((await entitiesNamedIn("Owner Zero Person")).some((row) => row.id === person!.id)).toBe(
      false,
    );
    expect((await edgesAround("person", person!.id)).some((row) => row.tier === 0)).toBe(false);
    expect((await chunksMissingEmbedding(100, 2)).some((row) => row.text.includes(sentinel))).toBe(
      false,
    );
    expect((await parentsNeedingExtraction(100)).some((row) => row.text.includes(sentinel))).toBe(
      false,
    );
    expect(
      (await chunkPairsSharingPerson(100)).some(
        (row) => row.a_text.includes(sentinel) || row.b_text.includes(sentinel),
      ),
    ).toBe(false);
  });

  // W2-1: migration 028 grants minime_app UPDATE on exactly (superseded_by, superseded_at) for
  // the six content tables that previously had no UPDATE grant at all. This is the real runtime
  // `minime_app` role (SET ROLE, not the independently-cloned test app-role boundary), so it
  // exercises the actual production grant + the existing tier_update RLS policy together.
  test("minime_app can stamp superseded_by/at only under its own approved tier-2 unlock, and only on those two columns", async () => {
    await sql`delete from session_unlocks`;
    const [original] = await sql`
      insert into journal_entries (entry_md, tier) values ('ZQX-SUPERSEDE-ORIGINAL', 2) returning id`;
    const [successor] = await sql`
      insert into journal_entries (entry_md, tier, supersedes_id)
      values ('ZQX-SUPERSEDE-SUCCESSOR', 2, ${original!.id}) returning id`;

    const appRole = await mintTestAppRole(process.env.DATABASE_URL!);
    await sql.unsafe(`grant minime_app to "${appRole.roleName}"`);
    const app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });
    const probeCtx = sessionToolCtx("agent:supersede-grant-probe");
    const stamp = () =>
      app.begin(async (tx) => {
        await tx`set local role minime_app`;
        await tx`select set_config('minime.actor', ${probeCtx.actor}, true)`;
        await tx`select set_config('minime.session_id', ${probeCtx.sessionId as string}, true)`;
        return tx`
          update journal_entries set superseded_by = ${successor!.id}, superseded_at = now()
          where id = ${original!.id}`;
      });

    try {
      // Locked (tier 1 default): the tier_update RLS policy filters the tier-2 row out, so the
      // grant succeeds at the privilege check but the statement touches zero rows.
      const locked = await stamp();
      expect(locked.count).toBe(0);
      const [stillLive] = await sql`
        select superseded_by, superseded_at from journal_entries where id = ${original!.id}`;
      expect(stillLive).toEqual({ superseded_by: null, superseded_at: null });

      await requestAndApproveTier2(probeCtx);

      // Unlocked: the same statement now stamps the row through the column-limited grant.
      const unlocked = await stamp();
      expect(unlocked.count).toBe(1);
      const [superseded] = await sql`
        select superseded_by, superseded_at from journal_entries where id = ${original!.id}`;
      expect(superseded!.superseded_by).toBe(successor!.id);
      expect(superseded!.superseded_at).not.toBeNull();

      // The grant is column-limited: minime_app still cannot touch entry_md directly, even
      // unlocked and even on the very same row.
      await expectSqlReject(
        app.begin(async (tx) => {
          await tx`set local role minime_app`;
          await tx`select set_config('minime.actor', ${probeCtx.actor}, true)`;
          await tx`select set_config('minime.session_id', ${probeCtx.sessionId as string}, true)`;
          return tx`update journal_entries set entry_md = 'tampered' where id = ${original!.id}`;
        }),
        /permission denied/,
      );
    } finally {
      await app.end({ timeout: 2 });
      await dropTestAppRole(appRole);
    }
  });

  // W2-1 review finding (2026-08-08): the tier_update RLS policies on these tables carried only
  // the upper bound (`tier <= app_allowed_tier()`); unlike tier_read
  // (019_tier0_prose_quarantine.sql/021_runtime_app_role.sql) and tier_delete
  // (021_runtime_app_role.sql), they never got the `tier >= 1` lower bound. A WHERE-less or
  // constant-predicate UPDATE from a LOCKED session could therefore still stamp a tier-0
  // quarantined row -- one that same session could never discover via any tier_read-gated SELECT.
  // This is the real runtime minime_app role and the actual tier_update policy from the
  // migrations, not the independently-cloned test app-role boundary.
  test("minime_app cannot stamp superseded_at on a tier-0 quarantined row via a WHERE-less update, even locked", async () => {
    await sql`delete from session_unlocks`;
    const [quarantined] = await sql`
      insert into journal_entries (entry_md, tier) values ('ZQX-TIER0-QUARANTINE-SUPERSEDE', 0)
      returning id`;

    const appRole = await mintTestAppRole(process.env.DATABASE_URL!);
    await sql.unsafe(`grant minime_app to "${appRole.roleName}"`);
    const app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });
    const probeCtx = sessionToolCtx("agent:supersede-tier0-probe");

    try {
      // Locked (tier 1 default) and no WHERE clause at all: before the lower-bound fix, this
      // bulk statement matched every row the UPDATE policy's upper bound alone didn't exclude --
      // including tier 0, since 0 <= 1. It must now touch zero rows.
      const bulk = await app.begin(async (tx) => {
        await tx`set local role minime_app`;
        await tx`select set_config('minime.actor', ${probeCtx.actor}, true)`;
        await tx`select set_config('minime.session_id', ${probeCtx.sessionId as string}, true)`;
        return tx`update journal_entries set superseded_at = now()`;
      });
      expect(bulk.count).toBe(0);

      const [stillLive] = await sql`
        select superseded_by, superseded_at from journal_entries where id = ${quarantined!.id}`;
      expect(stillLive).toEqual({ superseded_by: null, superseded_at: null });
    } finally {
      await app.end({ timeout: 2 });
      await dropTestAppRole(appRole);
    }
  });

  test("minime_app can neither re-promote a tier-0 chunk nor demote any row to tier 0", async () => {
    await sql`delete from session_unlocks`;
    // Quarantined tier-0 page prose physically lives in chunks.text (019). Before 028's
    // tier_update lower bound covered chunks, a WHERE-less `update chunks set tier = 1` from a
    // locked minime_app session re-promoted it to the agent-readable tier (invariant review,
    // 2026-08-08). Both directions must now fail closed: no re-promotion out of tier 0, and no
    // demotion into it (the replaced USING clause is also the implicit WITH CHECK).
    const [page] = await sql`
      insert into pages (path, title, body_md, content_hash, tier, source, created_by)
      values ('probe/zqx-quarantined.md', 'ZQX quarantine probe', 'fictional probe body',
              'zqxprobehash0000', 1, 'manual', 'human')
      returning id`;
    const [chunk] = await sql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${page!.id}, 0, 'ZQX-TIER0-QUARANTINED-CHUNK-PROSE', 0)
      returning id`;

    const appRole = await mintTestAppRole(process.env.DATABASE_URL!);
    await sql.unsafe(`grant minime_app to "${appRole.roleName}"`);
    const app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });
    const probeCtx = sessionToolCtx("agent:tier0-chunk-probe");

    try {
      const repromote = await app.begin(async (tx) => {
        await tx`set local role minime_app`;
        await tx`select set_config('minime.actor', ${probeCtx.actor}, true)`;
        await tx`select set_config('minime.session_id', ${probeCtx.sessionId as string}, true)`;
        return tx`update chunks set tier = 1`;
      });
      expect(repromote.count).toBe(0);
      const [still0] = await sql`select tier from chunks where id = ${chunk!.id}`;
      expect(still0!.tier).toBe(0);

      let demoteError = "";
      try {
        await app.begin(async (tx) => {
          await tx`set local role minime_app`;
          await tx`select set_config('minime.actor', ${probeCtx.actor}, true)`;
          await tx`select set_config('minime.session_id', ${probeCtx.sessionId as string}, true)`;
          return tx`update pages set tier = 0 where id = ${page!.id}`;
        });
      } catch (e) {
        demoteError = e instanceof Error ? e.message : String(e);
      }
      expect(demoteError).toContain("row-level security");
      const [still1] = await sql`select tier from pages where id = ${page!.id}`;
      expect(still1!.tier).toBe(1);
    } finally {
      await app.end({ timeout: 2 });
      await dropTestAppRole(appRole);
    }
  });
});
