// Phase-2 compiled-notes layer (search-uplift; spec §15 early adoption, owner-approved
// 2026-06-12). A dream step distills a ≤300-word factual note page per person with ≥3
// mentioning chunks: source='dream:notes', created_by='system:dream', derived_from = a
// representative source row, tier = max(source-chunk tier). Recompiled only on new mentions;
// idempotent otherwise. Fully offline — MINIME_MOCK_OLLAMA=1 uses a deterministic heuristic.
// Fixtures are fictional (not the owner's data).

import { beforeEach, describe, expect, test } from "bun:test";
import { ensurePerson, upsertPage } from "../src/db/repo";
import { entityLinkPass } from "../src/pipeline/dream";
import { compileNotes, heuristicDistill } from "../src/pipeline/notes";
import { indexParent } from "../src/search/index-parent";
import { setNow } from "../src/util/clock";
import { resetDb, testSql as sql } from "./helpers";

// Create a page + chunks + (chunk-anchored) mention edges for `person`.
async function pageMentioning(
  path: string,
  title: string,
  body: string,
  tier = 1,
): Promise<string> {
  const { id } = await upsertPage({
    path,
    title,
    bodyMd: body,
    contentHash: `h:${path}:${body.length}`,
    tier,
  });
  await indexParent("page", id, body, title, tier);
  return id;
}

async function notePage(personSlug: string): Promise<any | null> {
  const [row] =
    await sql`select * from pages where path = ${`derived/notes/person/${personSlug}.md`}`;
  return row ?? null;
}

beforeEach(async () => {
  setNow(null);
  await resetDb();
});

describe("heuristicDistill (offline, no invention)", () => {
  test("uses only the leading sentence of each source chunk, capped", () => {
    const out = heuristicDistill("Ingrid Solberg", [
      {
        id: "a",
        parent_type: "page",
        parent_id: "p1",
        text: "Ingrid Solberg is a marine biologist. She dislikes coffee.",
        tier: 1,
      },
      {
        id: "b",
        parent_type: "page",
        parent_id: "p2",
        text: "Ingrid Solberg leads the kelp survey at Bjørnøya.",
        tier: 1,
      },
    ]);
    expect(out).toContain("Ingrid Solberg is a marine biologist.");
    expect(out).toContain("Ingrid Solberg leads the kelp survey at Bjørnøya.");
    // second sentence of chunk 1 (after the first period) is NOT pulled in
    expect(out).not.toContain("dislikes coffee");
  });
});

describe("compileNotes provenance and tier", () => {
  test("creates a note with correct provenance, derived_from, and inherited tier", async () => {
    const { id: personId } = await ensurePerson("Ingrid Solberg", "test");
    const first = await pageMentioning(
      "journal/2026-01-trip.md",
      "Bjørnøya trip",
      "Met Ingrid Solberg at the dock. Ingrid Solberg runs the kelp survey.",
    );
    await pageMentioning(
      "journal/2026-02-lab.md",
      "Lab visit",
      "Ingrid Solberg showed me the samples. The lab smelled of brine.",
    );
    await pageMentioning(
      "journal/2026-03-talk.md",
      "Public talk",
      "Ingrid Solberg gave a talk on kelp forests to the local school.",
    );
    const linked = await entityLinkPass();
    expect(linked).toBeGreaterThanOrEqual(3);

    const res = await compileNotes();
    expect(res.compiled).toBe(1);
    expect(res.results[0]!.status).toBe("created");

    const note = await notePage("ingrid-solberg");
    expect(note).not.toBeNull();
    expect(note.source).toBe("dream:notes");
    expect(note.created_by).toBe("system:dream");
    expect(note.tier).toBe(1);
    // derived_from points at the earliest mentioning source row (the first page)
    expect(note.derived_from).toBe(first);
    expect(note.body_md).toContain("# Ingrid Solberg");
    // cites source row IDs so agents can verify claims (I5/I7)
    expect(note.body_md).toContain("## Sources");
    const [chunkCount] =
      await sql`select count(*)::int as n from chunks where parent_id = ${note.id}`;
    expect(chunkCount!.n).toBeGreaterThan(0); // indexed like any other page

    // person used in the note is not invented — it exists
    const [people] = await sql`select (count(*) > 0) as ok from people where id = ${personId}`;
    expect(people!.ok).toBe(true);
  });

  test("tier-2 sources never produce a tier-1 note", async () => {
    await ensurePerson("Marek Dvorak", "test");
    await pageMentioning("journal/a.md", "A", "Marek Dvorak fixed the rig.", 1);
    await pageMentioning("journal/b.md", "B", "Marek Dvorak called about the audit.", 2);
    await pageMentioning("journal/c.md", "C", "Marek Dvorak is travelling next week.", 2);
    await entityLinkPass();

    const res = await compileNotes();
    expect(res.compiled).toBe(1);
    const note = await notePage("marek-dvorak");
    expect(note.tier).toBe(2); // max(1,2,2)
  });
});

describe("staleness", () => {
  test("idempotent: a second run with no new mentions makes no change", async () => {
    await ensurePerson("Sofia Reyes", "test");
    await pageMentioning("journal/1.md", "1", "Sofia Reyes joined the choir.", 1);
    await pageMentioning("journal/2.md", "2", "Sofia Reyes baked the bread.", 1);
    await pageMentioning("journal/3.md", "3", "Sofia Reyes ran the half marathon.", 1);
    await entityLinkPass();

    const first = await compileNotes();
    expect(first.compiled).toBe(1);
    const before = await notePage("sofia-reyes");

    const second = await compileNotes();
    expect(second.compiled).toBe(0);
    expect(second.results[0]!.status).toBe("skipped");
    const after = await notePage("sofia-reyes");
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });

  test("recompiles when the entity gains a new mention", async () => {
    await ensurePerson("Yuki Tanaka", "test");
    await pageMentioning("journal/x.md", "X", "Yuki Tanaka planted the garden.", 1);
    await pageMentioning("journal/y.md", "Y", "Yuki Tanaka tuned the piano.", 1);
    await pageMentioning("journal/z.md", "Z", "Yuki Tanaka cycled to work.", 1);
    await entityLinkPass();
    const first = await compileNotes();
    expect(first.compiled).toBe(1);
    const before = await notePage("yuki-tanaka");

    // a new mention arrives later — edges.created_at uses DB now(), so advancing the app
    // clock keeps the assertion meaningful; the new edge is newer than the note.
    await new Promise((r) => setTimeout(r, 10));
    await pageMentioning("journal/w.md", "W", "Yuki Tanaka adopted a cat named Mochi.", 1);
    await entityLinkPass();

    const second = await compileNotes();
    expect(second.compiled).toBe(1);
    expect(second.results.find((r) => r.path.includes("yuki-tanaka"))!.status).toBe("updated");
    const after = await notePage("yuki-tanaka");
    expect(after.body_md).toContain("Mochi"); // the new claim is now distilled in
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  test("fewer than 3 mentioning chunks → no note", async () => {
    await ensurePerson("Lone Source", "test");
    await pageMentioning("journal/only.md", "Only", "Lone Source appeared once.", 1);
    await pageMentioning("journal/twice.md", "Twice", "Lone Source appeared again.", 1);
    await entityLinkPass();
    const res = await compileNotes();
    expect(res.candidates).toBe(0);
    expect(await notePage("lone-source")).toBeNull();
  });
});
