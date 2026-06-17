// Regression tests for MCP-visible tier leaks found during the database review.
// Locked tier-2 metadata must not escape through convenience fanouts, graph edges,
// or review-queue payloads.

import { beforeEach, describe, expect, test } from "bun:test";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { resetDb, testSql as sql } from "./helpers";

const ctx = { actor: "agent:privacy-test" };
const ctxAlice = { actor: "agent:alice" };
const ctxBob = { actor: "agent:bob" };

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
    await sql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
      values ('journal', ${journal!.id}, 'mentions', 'person', ${person!.id},
              'journal_entries', ${journal!.id}, 'system:test')`;
    await sql`
      insert into tasks (title, status, due, tier)
      values (${`${taskTitle} for Alex Privacy`}, 'active', '2000-01-01', 2)`;
    await sql`
      insert into commitments (what, to_whom, status, tier)
      values (${commitmentTitle}, 'Alex Privacy', 'open', 2)`;

    const result = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "Alex Privacy" },
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(taskTitle);
    expect(JSON.stringify(result)).not.toContain(commitmentTitle);
    expect(JSON.stringify(result)).not.toContain(String(journal!.id));
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

    await invokeTool(toolByName("minime_unlock"), { minutes: 5 }, ctxAlice);

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
});
