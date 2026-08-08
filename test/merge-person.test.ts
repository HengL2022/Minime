// W2-7 — person merge repair (mergePersonIntoPerson + committed repair script merge-person).
// Ten years of "Sarha"/"Sarah" capture-typo fragmentation is repairable with one owner-run
// command: aliases/interactions/edges move to the target, the source is superseded (never
// deleted, I5), and every people-resolution path stops surfacing the merged husk. Modeled on
// test/m11.entity-retype.test.ts's coverage of the sibling retypeOrgToPerson repair.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __safeRepairSummaryForTest, runRepair } from "../scripts/repair";
import mergePersonRepairModule from "../scripts/repairs/merge-person";
import {
  ensurePerson,
  entitiesNamedIn,
  getRow,
  insertReviewItem,
  mergePersonIntoPerson,
  resolvePerson,
} from "../src/db/repo";
import { resetDb, testSql as sql } from "./helpers";

describe("mergePersonIntoPerson", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("moves aliases: the source's old spellings resolve to the target afterwards", async () => {
    const { id: fromId } = await ensurePerson("Sarha Delgado", "human");
    const { id: intoId } = await ensurePerson("Sarah Delgado", "human");
    await sql`insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${fromId}, 'Sar', 1, 'manual', 'human')`;

    const res = await mergePersonIntoPerson(fromId, intoId);

    expect(res).toMatchObject({ fromId, intoId, aliasesMoved: 2 }); // own canonical alias + 'Sar'
    expect((await resolvePerson("Sarha Delgado"))?.id).toBe(intoId);
    expect((await resolvePerson("Sar"))?.id).toBe(intoId);
    expect((await resolvePerson("Sarah Delgado"))?.id).toBe(intoId);
    const remaining =
      await sql`select count(*)::int n from person_aliases where person_id = ${fromId}`;
    expect(remaining[0]!.n).toBe(0); // source's alias rows are moved, not duplicated
    const targetAliases =
      await sql`select alias from person_aliases where person_id = ${intoId} order by alias`;
    expect(targetAliases.map((r) => r.alias)).toEqual(["Sar", "Sarah Delgado", "Sarha Delgado"]);
  });

  test("repoints interactions and edges; drops self-edges; de-dupes collisions", async () => {
    const { id: fromId } = await ensurePerson("Dup Contact", "human");
    const { id: intoId } = await ensurePerson("Real Contact", "human");
    const { id: otherId } = await ensurePerson("Third Party", "human");
    const interactionId = (
      await sql`insert into interactions (person_id, kind, summary, occurred_at, created_by)
        values (${fromId}, 'note', 'chat', now(), 'human') returning id`
    )[0]!.id;
    // becomes self-referential once repointed
    await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
      values ('person',${fromId},'knows','person',${intoId},'system:extract')`;
    // collides after repoint with a pre-existing otherId -> intoId edge
    await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
      values ('person',${otherId},'knows','person',${fromId},'system:extract')`;
    await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
      values ('person',${otherId},'knows','person',${intoId},'system:extract')`;
    // no collision — survives repointed
    await sql`insert into edges (src_type,src_id,rel,dst_type,dst_id,extracted_by)
      values ('person',${fromId},'works_with','person',${otherId},'system:extract')`;

    const res = await mergePersonIntoPerson(fromId, intoId);

    expect(res.interactionsRepointed).toBe(1);
    expect(res.edgesRepointed).toBe(3); // self-loop edge + collision edge + survivor edge
    const [interaction] = await sql`select person_id from interactions where id = ${interactionId}`;
    expect(interaction!.person_id).toBe(intoId);
    const dangling =
      await sql`select count(*)::int n from edges where src_id=${fromId} or dst_id=${fromId}`;
    expect(dangling[0]!.n).toBe(0);
    const selfRef =
      await sql`select count(*)::int n from edges where src_id=${intoId} and dst_id=${intoId}`;
    expect(selfRef[0]!.n).toBe(0);
    const collided = await sql`select count(*)::int n from edges
      where src_id=${otherId} and dst_id=${intoId} and rel='knows'`;
    expect(collided[0]!.n).toBe(1);
    const survived = await sql`select count(*)::int n from edges
      where src_id=${intoId} and dst_id=${otherId} and rel='works_with'`;
    expect(survived[0]!.n).toBe(1);
  });

  test("last_contact_at becomes the greatest of source and target", async () => {
    const { id: fromId } = await ensurePerson("Earlier Contact", "human");
    const { id: intoId } = await ensurePerson("Later Contact", "human");
    await sql`update people set last_contact_at = ${new Date("2026-01-01T00:00:00Z")}
      where id = ${fromId}`;
    await sql`update people set last_contact_at = ${new Date("2025-06-01T00:00:00Z")}
      where id = ${intoId}`;

    await mergePersonIntoPerson(fromId, intoId);

    const [row] = await sql`select last_contact_at from people where id = ${intoId}`;
    expect(new Date(row!.last_contact_at).getTime()).toBe(
      new Date("2026-01-01T00:00:00Z").getTime(),
    );
  });

  test("last_contact_at falls back to whichever side actually has a value", async () => {
    const { id: fromId } = await ensurePerson("Has Contact", "human");
    const { id: intoId } = await ensurePerson("No Contact Yet", "human");
    await sql`update people set last_contact_at = ${new Date("2026-02-02T00:00:00Z")}
      where id = ${fromId}`;

    await mergePersonIntoPerson(fromId, intoId);

    const [row] = await sql`select last_contact_at from people where id = ${intoId}`;
    expect(new Date(row!.last_contact_at).getTime()).toBe(
      new Date("2026-02-02T00:00:00Z").getTime(),
    );
  });

  test("relation/context: target's existing value wins, source only fills a gap", async () => {
    const { id: fromId } = await ensurePerson("Source Person", "human");
    const { id: intoId } = await ensurePerson("Target Person", "human");
    await sql`update people set relation = 'friend', context = 'met at a conference'
      where id = ${fromId}`;
    await sql`update people set relation = 'colleague' where id = ${intoId}`; // context left null

    await mergePersonIntoPerson(fromId, intoId);

    const [row] = await sql`select relation, context from people where id = ${intoId}`;
    expect(row!.relation).toBe("colleague"); // target's own value preserved
    expect(row!.context).toBe("met at a conference"); // filled from source since target had none
  });

  test("target absorbs the source's tier (greatest of 1/2)", async () => {
    const { id: fromId } = await ensurePerson("Private Source", "human", "manual", { tier: 2 });
    const { id: intoId } = await ensurePerson("Public Target", "human", "manual", { tier: 1 });

    await mergePersonIntoPerson(fromId, intoId);

    const [row] = await sql`select tier from people where id = ${intoId}`;
    expect(row!.tier).toBe(2);
  });

  test("supersedes_id records only the first ancestor across repeated merges", async () => {
    const { id: firstSource } = await ensurePerson("First Dup", "human");
    const { id: secondSource } = await ensurePerson("Second Dup", "human");
    const { id: intoId } = await ensurePerson("Final Survivor", "human");

    await mergePersonIntoPerson(firstSource, intoId);
    await mergePersonIntoPerson(secondSource, intoId);

    const [row] = await sql`select supersedes_id from people where id = ${intoId}`;
    expect(row!.supersedes_id).toBe(firstSource);
  });

  test("source becomes invisible to resolvePerson/entitiesNamedIn but stays readable by id (W2-5 gap)", async () => {
    const { id: fromId } = await ensurePerson("Priya Fragmented", "human");
    const { id: intoId } = await ensurePerson("Priya Raghunathan", "human");

    await mergePersonIntoPerson(fromId, intoId);

    const bySourceName = await resolvePerson("Priya Fragmented");
    expect(bySourceName?.id).toBe(intoId); // fragmented spelling resolves to the survivor
    const named = await entitiesNamedIn("catching up with Priya Fragmented next week");
    expect(named).toContainEqual({ type: "person", id: intoId });
    expect(named.some((r) => r.id === fromId)).toBe(false);

    const husk = await getRow("person", fromId); // still directly inspectable by id (I5)
    expect(husk).toBeTruthy();
    expect(husk.superseded_by).toBe(intoId);
    expect(husk.superseded_at).not.toBeNull();
    expect(husk.canonical_name).toBe("Priya Fragmented"); // original spelling kept, never edited
  });

  test("auto-resolves an open phantom_person review item for the merged-away source", async () => {
    const { id: fromId } = await ensurePerson("Flagged Person", "system:extract");
    const { id: intoId } = await ensurePerson("Real Person", "human");
    const { id: reviewId } = await insertReviewItem("phantom_person", {
      person_id: fromId,
      canonical_name: "Flagged Person",
      reason: "person shares a name with an existing organisation",
      suggestion: "retype to org, or dismiss if this really is a person",
    });

    await mergePersonIntoPerson(fromId, intoId);

    const [item] = await sql`select status, resolved_at from review_queue where id = ${reviewId}`;
    expect(item!.status).toBe("resolved");
    expect(item!.resolved_at).not.toBeNull();
  });

  test("does not touch an unrelated open phantom_person item", async () => {
    const { id: fromId } = await ensurePerson("Merged Away", "human");
    const { id: intoId } = await ensurePerson("Survivor", "human");
    const { id: unrelatedPersonId } = await ensurePerson("Someone Else Flagged", "system:extract");
    const { id: unrelatedReviewId } = await insertReviewItem("phantom_person", {
      person_id: unrelatedPersonId,
      canonical_name: "Someone Else Flagged",
      reason: "name looks like a company and has no human interaction/relation signal",
      suggestion: "retype to org, or dismiss if this really is a person",
    });

    await mergePersonIntoPerson(fromId, intoId);

    const [item] = await sql`select status from review_queue where id = ${unrelatedReviewId}`;
    expect(item!.status).toBe("open");
  });

  test("refuses to merge a person into itself", async () => {
    const { id } = await ensurePerson("Solo Person", "human");
    await expect(mergePersonIntoPerson(id, id)).rejects.toThrow(/itself/);
  });

  test("rejects unknown person ids on either side", async () => {
    const { id } = await ensurePerson("Known Person", "human");
    const fake = "00000000-0000-0000-0000-000000000000";
    await expect(mergePersonIntoPerson(fake, id)).rejects.toThrow(/not found/i);
    await expect(mergePersonIntoPerson(id, fake)).rejects.toThrow(/not found/i);
  });

  test("refuses to merge across the tier-0 quarantine boundary", async () => {
    const { id: intoId } = await ensurePerson("Visible Person", "human");
    const [hidden] = await sql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Hidden Person', 0, 'quarantine', 'owner:test') returning id`;
    const fromId = hidden!.id;

    await expect(mergePersonIntoPerson(fromId, intoId)).rejects.toThrow(/tier-0 quarantine/);
    await expect(mergePersonIntoPerson(intoId, fromId)).rejects.toThrow(/tier-0 quarantine/);
  });

  test("permits a tier-0 to tier-0 merge within the same quarantine namespace", async () => {
    const [fromRow] = await sql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Quarantined Dup', 0, 'quarantine', 'owner:test') returning id`;
    const [intoRow] = await sql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Quarantined Survivor', 0, 'quarantine', 'owner:test') returning id`;

    const res = await mergePersonIntoPerson(fromRow!.id, intoRow!.id);

    expect(res.fromId).toBe(fromRow!.id);
    const [target] = await sql`select tier from people where id = ${intoRow!.id}`;
    expect(target!.tier).toBe(0);
  });

  test("refuses to merge an already-merged source a second time", async () => {
    const { id: fromId } = await ensurePerson("Twice Merged", "human");
    const { id: firstTarget } = await ensurePerson("Target One", "human");
    const { id: secondTarget } = await ensurePerson("Target Two", "human");
    await mergePersonIntoPerson(fromId, firstTarget);

    await expect(mergePersonIntoPerson(fromId, secondTarget)).rejects.toThrow(/already merged/);
  });

  test("refuses to merge into an already-merged target", async () => {
    const { id: firstSource } = await ensurePerson("First Source", "human");
    const { id: secondSource } = await ensurePerson("Second Source", "human");
    const { id: survivor } = await ensurePerson("Eventual Survivor", "human");
    await mergePersonIntoPerson(firstSource, survivor); // firstSource is now a superseded husk

    await expect(mergePersonIntoPerson(secondSource, firstSource)).rejects.toThrow(
      /already-merged/,
    );
  });
});

// The RepairModule itself, exercised directly (bypassing scripts/repair.ts's committed-script
// gate entirely — see the note on the next describe block) so its argument validation and exact
// return shape get real coverage regardless of this task's own commit timing.
describe("scripts/repairs/merge-person.ts (module)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("validates --from/--into before touching the DB", async () => {
    expect(mergePersonRepairModule.name).toBe("merge-person");
    await expect(mergePersonRepairModule.run([])).rejects.toThrow(/usage:/);
    await expect(
      mergePersonRepairModule.run(["--from=not-a-uuid", "--into=also-not-a-uuid"]),
    ).rejects.toThrow(/usage:/);
  });

  test("run() drives a real merge and returns the fixed {counts, ids} shape", async () => {
    const { id: fromId } = await ensurePerson("Module Source", "human");
    const { id: intoId } = await ensurePerson("Module Target", "human");

    const summary = await mergePersonRepairModule.run([`--from=${fromId}`, `--into=${intoId}`]);
    const expected = {
      counts: { edges_repointed: 0, aliases_moved: 1, interactions_repointed: 0 },
      ids: [fromId, intoId],
    };

    expect(summary).toEqual(expected);
    expect(__safeRepairSummaryForTest(summary)).toEqual(expected); // exactly what the runner accepts
  });
});

// scripts/repair.ts's committed-script gate (DECISIONS.md 2026-07-18 W4) means merge-person
// cannot complete an end-to-end happy-path run through runRepair until this task's own commit
// lands (git cat-file -e HEAD:scripts/repairs/merge-person.ts). These tests instead verify the
// generalized registry itself: the audited verb/script attribution is correct regardless of
// commit timing (both pre- and post-commit runs land in a "failed" phase here, since no valid
// --from/--into args are ever passed), and the summary-counts allowlist accepts the new keys.
describe("repair.ts registry: merge-person", () => {
  let dumpScratch: string;
  let dumpDir: string;

  beforeEach(() => {
    dumpScratch = realpathSync(mkdtempSync(join(tmpdir(), "minime-merge-person-repair-")));
    dumpDir = join(dumpScratch, "db-dump");
  });
  afterEach(() => {
    rmSync(dumpScratch, { recursive: true, force: true });
  });

  test("merge-person is recognized by the registry (distinct from an unregistered name)", async () => {
    const [prev] = await sql`select coalesce(max(id), 0)::int as max_id from events`;
    expect(await runRepair("merge-person", [], { dumpDir })).toBe(1);
    const events = await sql`
      select verb, payload from events where verb like 'repair:%' and id > ${prev!.max_id}
      order by id`;
    expect(events.map((e) => e.verb)).toEqual(["repair:merge-person"]);
    expect(events[0]!.payload).toMatchObject({ script: "merge-person", phase: "failed" });
    expect(JSON.stringify(events)).not.toContain("Sarha"); // ids/codes only, never row contents
  });

  test("an unrelated unknown script name is still refused", async () => {
    const [prev] = await sql`select coalesce(max(id), 0)::int as max_id from events`;
    expect(await runRepair("no-such-repair", [], { dumpDir })).toBe(1);
    const events = await sql`
      select verb, payload from events where verb like 'repair:%' and id > ${prev!.max_id}
      order by id`;
    expect(events.map((e) => e.verb)).toEqual(["repair:unknown"]);
    expect(events[0]!.payload).toMatchObject({ script: "unknown", phase: "failed" });
  });

  test("summary counts allowlist accepts the merge-person module's exact output shape", () => {
    const shape = {
      counts: { edges_repointed: 3, aliases_moved: 2, interactions_repointed: 1 },
      ids: [crypto.randomUUID(), crypto.randomUUID()],
    };
    expect(__safeRepairSummaryForTest(shape)).toEqual(shape);
  });

  test("summary counts allowlist accepts any subset of the three known keys", () => {
    expect(__safeRepairSummaryForTest({ counts: { aliases_moved: 0 }, ids: [] })).toEqual({
      counts: { aliases_moved: 0 },
      ids: [],
    });
    expect(__safeRepairSummaryForTest({ counts: {}, ids: [] })).toEqual({ counts: {}, ids: [] });
  });

  test("summary counts allowlist still rejects a free-form/unknown key", () => {
    expect(
      __safeRepairSummaryForTest({ counts: { edges_repointed: 1, made_up_key: 2 }, ids: [] }),
    ).toBeUndefined();
  });

  test.each([
    ["negative", { aliases_moved: -1 }],
    ["non-integer", { interactions_repointed: 1.5 }],
    ["NaN", { edges_repointed: Number.NaN }],
  ] as const)("summary counts allowlist rejects a %s value", (_label, counts) => {
    expect(__safeRepairSummaryForTest({ counts, ids: [] })).toBeUndefined();
  });
});
