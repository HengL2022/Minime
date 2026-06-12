// First-run onboarding interview (src/onboard.ts): driven in-process with stream
// fixtures (fictional persona). Asserts the seeded rows, their source='onboard'
// provenance, the audit event, and that an all-skip run writes nothing.

import { beforeAll, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { onboard } from "../src/onboard";
import { resetDb, testSql as sql } from "./helpers";

function run(answers: string[]) {
  const input = Readable.from([`${answers.join("\n")}\n`]);
  let text = "";
  const output = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString();
      cb();
    },
  });
  return onboard(input, output).then((counts) => ({ counts, out: () => text }));
}

beforeAll(async () => {
  await resetDb();
});

describe("onboarding interview", () => {
  test("seeds profile, values, goals, principles, people, tasks, journal", async () => {
    const { counts, out } = await run([
      "Mira Tan", // about: name
      "marine biologist", // work
      "Quezon City", // where
      "", // extra
      "Family over everything", // value 1
      "Honest work", // value 2
      "", // values done
      "See the coral reefs recover", // life goal 1
      "", // life goals done
      "Publish the seagrass paper", // year goal 1
      "", // year goals done
      "Sleep before deciding", // principle 1
      "", // principles done
      "Diego Tan", // person 1
      "my brother", //   relation
      "lives in Cebu, calls on Sundays", //   context
      "", // people done
      "Finish the grant report", // task 1
      "2026-07-01", //   due
      "", // tasks done
      "Settling into the new lab; tired but hopeful.", // snapshot
    ]);

    expect(counts).toEqual({
      profile: 1,
      values: 2,
      goals: 2,
      principles: 1,
      people: 1,
      tasks: 1,
      journal: 1,
    });

    const [v1] = await sql`select statement, priority, source, created_by
                           from values_items order by priority limit 1`;
    expect(v1).toMatchObject({
      statement: "Family over everything",
      priority: 1,
      source: "onboard",
      created_by: "human",
    });

    const goals = await sql`select horizon, statement from goals order by horizon`;
    expect(goals.map((g: any) => g.horizon).sort()).toEqual(["life", "year"]);

    const [person] = await sql`select canonical_name, relation, context from people
                               where canonical_name = 'Diego Tan'`;
    expect(person!.relation).toBe("my brother");
    expect(person!.context).toContain("Cebu");

    const [task] = await sql`select title, due::text, source from tasks`;
    expect(task).toMatchObject({
      title: "Finish the grant report",
      due: "2026-07-01",
      source: "onboard",
    });

    const [page] = await sql`select title, tier, source from pages where path = 'me/about.md'`;
    expect(page).toMatchObject({ title: "About Mira Tan", tier: 1, source: "onboard" });
    const [chunks] = await sql`select count(*)::int as n from chunks c
                               join pages p on p.id = c.parent_id where p.path = 'me/about.md'`;
    expect(chunks!.n).toBeGreaterThan(0); // profile is searchable immediately

    const [journal] = await sql`select tier, source from journal_entries`;
    expect(journal).toMatchObject({ tier: 2, source: "onboard" }); // snapshot stays private

    const [ev] = await sql`select payload from events where verb = 'onboard:complete'`;
    expect(ev!.payload.values).toBe(2);

    expect(out()).toContain("Done — 9 entries seeded");
  });

  test("re-run warns and adds; all-skip run writes nothing new", async () => {
    const before = await sql`select count(*)::int as n from values_items`;
    const { counts, out } = await run(["", "", "", "", "", "", "", "", "", "", ""]);
    expect(out()).toContain("already has values/goals");
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0);
    const after = await sql`select count(*)::int as n from values_items`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
