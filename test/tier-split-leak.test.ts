// W4-3: adversarial tier-leak regression suite for the identity/content split (W4-1, migration
// 037_identity_content_tier_split.sql) plus the demotion/backfill path it left open (W4-2,
// migration 038_entity_promotion_backfill.sql + restoreEntityTier). test/entity-tier-split.test.ts
// and test/entity-tier-restore.test.ts already prove each mechanism in isolation, one narrow
// fixture per scenario. This file is the dedicated end-to-end companion: ONE mixed-tier fixture —
//   (a) a tier-1 owner-known person (Priya) later mentioned in a private tier-2 journal entry,
//       gaining a new tier-2 alias, a tier-2 "mentions" edge, and a tier-2 interaction,
//   (b) a person (Soren) who exists ONLY through that same private mention — never known any
//       other way, and
//   (c) a legacy tier-2 identity (Marit) restored to tier 1 through the real W4-2 owner-CLI path —
// driven through every MCP read door in one never-unlocked session (minime_search,
// minime_get_context by name and by id, minime_state, minime_timeline, minime_agenda,
// minime_review_queue, minime_upsert_person), then re-driven through a freshly unlocked session
// per scenario to prove disclosure is selective, not simply absent. Every leak check walks the
// FULL serialized envelope (JSON.stringify, not just top-level fields), modeled directly on
// test/m6.leak.test.ts's own sentinel-substring technique.
//
// The one disclosure this suite documents as ALLOWED, not a leak: touchLastContact (repo.ts)
// always updates people.last_contact_at regardless of the interaction's own tier, and
// last_contact_at is a column on the tier-1-readable people row — so a still-locked session can
// see WHEN a private contact happened, never WHAT was said. 037's own header comment calls this
// out explicitly ("this discloses at tier 1 that contact happened and roughly when, but never
// what"); test (4) below pins it down with an exact before/after value, not just a presence check,
// so an accidental WIDENING of what gets disclosed (not just a new leak) would also be caught.
//
// Search queries throughout are exact phrases copied verbatim from the fixture text, never
// paraphrases — the risk noted in the task spec is that this suite must stay ranking-stable as
// search itself evolves; presence/absence of an exact phrase's own chunk does not depend on
// ranking, only on the tier predicate that decides which chunks are even candidates.

import { beforeAll, describe, expect, test } from "bun:test";
import { withAdminDbTransaction } from "../src/db/client";
import {
  addAlias,
  ensurePerson,
  insertEdge,
  restoreEntityTier,
  setPersonDetails,
  upsertPage,
} from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { indexParent } from "../src/search/index-parent";
import { resetDb, testSql } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

const PERSON_A_NAME = "Priya Anders";
const PERSON_A_ALIAS = "P. Anders"; // tier-1, added before any private mention
const PERSON_A_NEW_ALIAS = "Priya"; // minted BY the private journal mention below — tier 2
const PERSON_A_RELATION = "college friend";
const PERSON_A_CONTEXT = "met freshman year, now in renewable energy";

const PERSON_B_NAME = "Soren Kastrup"; // exists ONLY through the private journal mention

const PERSON_C_NAME = "Marit Lindqvist"; // legacy tier-2 identity, restored mid-suite
const PERSON_C_RELATION = "old neighbor";
const PERSON_C_CONTEXT = "moved away years ago, still checks in";
const PERSON_C_LEGACY_ALIAS = "Zelara"; // tier-2, genuinely derived, stays tier 2 through restore

const NONEXISTENT_NAME = "Zzyzx Nonexistent Placeholder";

const TIER2_JOURNAL_SENTINEL = "ZQXW43-TIER2-JOURNAL-SNIPPET";
const TIER2_INTERACTION_SENTINEL = "ZQXW43-TIER2-INTERACTION-SUMMARY";
const TIER1_NOTE_SENTINEL = "ZQXW43-TIER1-NOTE-SNIPPET";
const REVIEW_HIDDEN = "[above current tier]";

describe("adversarial tier-leak regression: identity/content split across every MCP read door (W4-3)", () => {
  // One session that is NEVER unlocked for the whole file — the stable "locked" baseline every
  // test reads against. Writes below use their own throwaway actors (a writer ≠ a reader is more
  // realistic, and keeps this session's own lock state impossible to confuse with anything else).
  const locked = sessionToolCtx("agent:w4-3-locked");

  let personAId: string;
  let personBId: string;
  let personCId: string;
  let notePageId: string;
  let journalId: string;
  let interactionId: string;
  let cOpenReviewItemId: string;
  let personALastContactBefore: Date | null;
  let personALastContactAfter: Date | null;

  beforeAll(async () => {
    await resetDb();

    // --- (a) Person A: tier-1, owner-known BEFORE any private mention. ---
    const a = await ensurePerson(PERSON_A_NAME, "human", "manual", { tier: 1 });
    personAId = a.id;
    await addAlias(personAId, PERSON_A_ALIAS, { tier: 1, createdBy: "human", source: "manual" });
    await setPersonDetails(personAId, PERSON_A_RELATION, PERSON_A_CONTEXT);
    const [aBefore] = await testSql`select last_contact_at from people where id = ${personAId}`;
    personALastContactBefore = aBefore!.last_contact_at;

    // A tier-1 public note mentioning her by full canonical name — the contrast case: unlike the
    // private journal mention below, THIS one is expected to surface in a locked search/graph read.
    const notePage = await upsertPage({
      path: "w4-3/priya-public-note.md",
      title: "Priya Anders -- public note",
      bodyMd: `Priya Anders is a ${TIER1_NOTE_SENTINEL} college friend I stay in touch with.`,
      contentHash: "w4-3-priya-public-note",
      tier: 1,
      source: "test",
    });
    notePageId = notePage.id;
    await indexParent(
      "page",
      notePageId,
      `Priya Anders is a ${TIER1_NOTE_SENTINEL} college friend I stay in touch with.`,
      "Priya Anders -- public note",
      1,
    );

    // --- Private (tier-2) journal entry, via the real minime_journal production path (insertJournal
    // + indexParent, which runs extraction). Paragraph 1 mentions A by her bare first name only —
    // a NEW, content-derived alias/edge (mirrors entity-tier-split.test.ts's Erik Voss case).
    // Paragraph 2 introduces B, a person who exists ONLY through this private mention.
    const journalText = `Priya -- old friend, coffee again felt like ${TIER2_JOURNAL_SENTINEL} old times.\n\nMy physiotherapist, ${PERSON_B_NAME}, adjusted my shoulder today and it went smoothly.`;
    const journalWrite = await invokeTool(
      toolByName("minime_journal"),
      { entry_md: journalText },
      sessionToolCtx("agent:w4-3-writer"),
    );
    if (!journalWrite.ok) throw new Error(journalWrite.error.message);
    journalId = (journalWrite.envelope.data as any).journal_entry_id as string;

    const [bRow] = await testSql`
      select id from people where lower(canonical_name) = lower(${PERSON_B_NAME})`;
    if (!bRow)
      throw new Error("fixture setup: person B was not extracted from the private journal");
    personBId = bRow.id as string;

    // --- A tier-2 interaction with A, via the real minime_log_interaction production path:
    // subject identity resolves/stays at tier 1 (W4-1); the interaction content and its own edge
    // stay tier 2 (037_identity_content_tier_split.sql).
    const interactionWrite = await invokeTool(
      toolByName("minime_log_interaction"),
      {
        person_name: PERSON_A_NAME,
        kind: "call",
        summary: `Talked about the move and it went well, ${TIER2_INTERACTION_SENTINEL} details omitted here.`,
      },
      sessionToolCtx("agent:w4-3-writer"),
    );
    if (!interactionWrite.ok) throw new Error(interactionWrite.error.message);
    interactionId = (interactionWrite.envelope.data as any).interaction_id as string;

    const [aAfter] = await testSql`select last_contact_at from people where id = ${personAId}`;
    personALastContactAfter = aAfter!.last_contact_at;

    // --- (c) Person C: simulates a pre-037 swallow-bug leftover — minted straight at tier 2, with
    // a tier-2 alias/edge genuinely derived from a private source (which restoreEntityTier
    // deliberately leaves at tier 2 even after the identity itself is restored), then flagged via
    // the real W4-2 ongoing-detection hook and demoted via the real owner-CLI restore path.
    const c = await ensurePerson(PERSON_C_NAME, "human", "manual", { tier: 2 });
    personCId = c.id;
    await setPersonDetails(personCId, PERSON_C_RELATION, PERSON_C_CONTEXT);
    await addAlias(personCId, PERSON_C_LEGACY_ALIAS, {
      tier: 2,
      createdBy: "system:extract",
      source: "extract",
    });
    const cSourcePage = await upsertPage({
      path: "w4-3/marit-legacy-source.md",
      title: "Marit legacy source",
      bodyMd: "fictional private extraction source text about Marit",
      contentHash: "w4-3-marit-legacy-source",
      tier: 2,
      source: "test",
    });
    await insertEdge({
      srcType: "page",
      srcId: cSourcePage.id,
      rel: "mentions",
      dstType: "person",
      dstId: personCId,
      sourceTable: "pages",
      sourceId: cSourcePage.id,
      extractedBy: "system:extract",
      source: "extract",
    });
    // Ongoing-detection hook (W4-2, repo.ts's flagEntityPromotionIfStillTierTwo): a tier-1
    // resolve against an already-tier-2 identity flags entity_promotion — the same trigger
    // minime_log_interaction fires for an owner-known contact still stuck at tier 2.
    await ensurePerson(PERSON_C_NAME, "agent:test", "capture", { tier: 1 });
    const [cReviewRow] = await testSql`
      select id from review_queue
      where kind = 'entity_promotion' and status = 'open' and payload ->> 'entity_id' = ${personCId}`;
    if (!cReviewRow) throw new Error("fixture setup: entity_promotion flag missing for person C");
    cOpenReviewItemId = String(cReviewRow.id);
  });

  test("(1) person A: minime_get_context by name -- locked shows identity only, unlocked reveals every tier-2-derived fact", async () => {
    const lockedResult = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: PERSON_A_NAME },
      locked,
    );
    if (!lockedResult.ok) throw new Error(lockedResult.error.message);
    const lockedJson = JSON.stringify(lockedResult);
    const row = (lockedResult.envelope.data as any).row;
    expect(row.id).toBe(personAId);
    expect(row.canonical_name).toBe(PERSON_A_NAME);
    expect(row.relation).toBe(PERSON_A_RELATION);
    expect(row.context).toBe(PERSON_A_CONTEXT);
    expect(row.last_contact_at).toBeTruthy(); // the ratified disclosure -- see test (4)

    // No tier-2-derived fact anywhere in the envelope.
    expect((lockedResult.envelope.data as any).interactions).toEqual([]);
    const related = (lockedResult.envelope.data as any).related as any[];
    expect(related).toHaveLength(1); // only the tier-1 public-note edge survives locked
    expect(related[0].src.type).toBe("page");
    expect(related[0].src.id).toBe(notePageId);
    expect(lockedJson).not.toContain(TIER2_JOURNAL_SENTINEL);
    expect(lockedJson).not.toContain(TIER2_INTERACTION_SENTINEL);
    expect(lockedJson).not.toContain(interactionId);
    expect(lockedResult.envelope.sources.some((s) => s.type === "interaction")).toBe(false);

    // The alias minted BY the private mention does not resolve her identity at tier 1.
    const byNewAlias = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: PERSON_A_NEW_ALIAS },
      locked,
    );
    expect(byNewAlias.ok).toBe(false);
    if (byNewAlias.ok) throw new Error("unreachable");
    expect(byNewAlias.error.code).toBe("NOT_FOUND");

    // Unlocked: everything appears, including via the new alias.
    const unlockedCtx = sessionToolCtx("agent:w4-3-unlocked-1");
    await requestAndApproveTier2(unlockedCtx);
    const unlockedResult = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: PERSON_A_NAME },
      unlockedCtx,
    );
    if (!unlockedResult.ok) throw new Error(unlockedResult.error.message);
    const unlockedJson = JSON.stringify(unlockedResult);
    expect(unlockedJson).toContain(TIER2_JOURNAL_SENTINEL);
    expect(unlockedJson).toContain(TIER2_INTERACTION_SENTINEL);
    expect((unlockedResult.envelope.data as any).interactions.length).toBeGreaterThanOrEqual(1);
    const unlockedRelated = (unlockedResult.envelope.data as any).related as any[];
    expect(unlockedRelated.length).toBeGreaterThan(1);
    expect(unlockedResult.envelope.sources.some((s) => s.type === "interaction")).toBe(true);
    expect(unlockedResult.envelope.sources.some((s) => s.type === "edge")).toBe(true);

    const unlockedByNewAlias = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: PERSON_A_NEW_ALIAS },
      unlockedCtx,
    );
    if (!unlockedByNewAlias.ok) throw new Error(unlockedByNewAlias.error.message);
    expect((unlockedByNewAlias.envelope.data as any).row.id).toBe(personAId);
  });

  test("(2) person A: minime_get_context by type+id -- identical identity, identical non-leak guarantees", async () => {
    const lockedResult = await invokeTool(
      toolByName("minime_get_context"),
      { type: "person", id: personAId },
      locked,
    );
    if (!lockedResult.ok) throw new Error(lockedResult.error.message);
    const row = (lockedResult.envelope.data as any).row;
    expect(row.canonical_name).toBe(PERSON_A_NAME);
    expect(row.relation).toBe(PERSON_A_RELATION);
    const lockedJson = JSON.stringify(lockedResult);
    expect(lockedJson).not.toContain(TIER2_JOURNAL_SENTINEL);
    expect(lockedJson).not.toContain(TIER2_INTERACTION_SENTINEL);
    expect((lockedResult.envelope.data as any).interactions).toEqual([]);

    const unlockedCtx = sessionToolCtx("agent:w4-3-unlocked-2");
    await requestAndApproveTier2(unlockedCtx);
    const unlockedResult = await invokeTool(
      toolByName("minime_get_context"),
      { type: "person", id: personAId },
      unlockedCtx,
    );
    if (!unlockedResult.ok) throw new Error(unlockedResult.error.message);
    const unlockedJson = JSON.stringify(unlockedResult);
    expect(unlockedJson).toContain(TIER2_JOURNAL_SENTINEL);
    expect(unlockedJson).toContain(TIER2_INTERACTION_SENTINEL);
  });

  test("(3) minime_search: exact-match queries disclose tier-1 content but never tier-2, even for the same person", async () => {
    const search = toolByName("minime_search");
    // With tier-2 chunks excluded, a locked session's ONLY candidate document is the tier-1 note
    // page -- so it can legitimately surface as hybrid search's best (only) available match even
    // for an unrelated query (mock embeddings do not discriminate well against a near-empty
    // corpus). The invariant under test is narrower and still exact: the specific tier-2 chunk
    // never appears and its sentinel text never appears, not "there are no hits at all".
    const hitIds = (result: any): string[] =>
      ((result.envelope.data as any).hits as any[]).map((h) => h.id);

    // Query text unique to the PRIVATE journal mention -- its own chunk must vanish while locked.
    const journalLocked = await invokeTool(search, { query: "coffee again felt like" }, locked);
    if (!journalLocked.ok) throw new Error(journalLocked.error.message);
    expect(hitIds(journalLocked)).not.toContain(journalId);
    expect(JSON.stringify(journalLocked)).not.toContain(TIER2_JOURNAL_SENTINEL);

    const journalUnlockedCtx = sessionToolCtx("agent:w4-3-unlocked-search-journal");
    await requestAndApproveTier2(journalUnlockedCtx);
    const journalUnlocked = await invokeTool(
      search,
      { query: "coffee again felt like" },
      journalUnlockedCtx,
    );
    if (!journalUnlocked.ok) throw new Error(journalUnlocked.error.message);
    expect(hitIds(journalUnlocked)).toContain(journalId);
    expect(JSON.stringify(journalUnlocked)).toContain(TIER2_JOURNAL_SENTINEL);

    // Query text unique to the PRIVATE interaction -- same story.
    const interactionLocked = await invokeTool(
      search,
      { query: "Talked about the move and it went well" },
      locked,
    );
    if (!interactionLocked.ok) throw new Error(interactionLocked.error.message);
    expect(hitIds(interactionLocked)).not.toContain(interactionId);
    expect(JSON.stringify(interactionLocked)).not.toContain(TIER2_INTERACTION_SENTINEL);

    // B's exact full name -- her only footprint anywhere is the private journal chunk.
    const bLocked = await invokeTool(search, { query: PERSON_B_NAME }, locked);
    if (!bLocked.ok) throw new Error(bLocked.error.message);
    expect(hitIds(bLocked)).not.toContain(journalId);
    expect(JSON.stringify(bLocked)).not.toContain(PERSON_B_NAME);
    const bUnlockedCtx = sessionToolCtx("agent:w4-3-unlocked-search-b");
    await requestAndApproveTier2(bUnlockedCtx);
    const bUnlocked = await invokeTool(search, { query: PERSON_B_NAME }, bUnlockedCtx);
    if (!bUnlocked.ok) throw new Error(bUnlocked.error.message);
    expect(hitIds(bUnlocked)).toContain(journalId);

    // Same query, mixed-tier underlying data: A's full canonical name matches BOTH the tier-1
    // public note and the tier-2 private mentions -- locked must show only the former.
    const mixedLocked = await invokeTool(search, { query: PERSON_A_NAME }, locked);
    if (!mixedLocked.ok) throw new Error(mixedLocked.error.message);
    const mixedLockedJson = JSON.stringify(mixedLocked);
    expect(mixedLockedJson).toContain(TIER1_NOTE_SENTINEL);
    expect(mixedLockedJson).not.toContain(TIER2_JOURNAL_SENTINEL);
    expect(mixedLockedJson).not.toContain(TIER2_INTERACTION_SENTINEL);

    const mixedUnlockedCtx = sessionToolCtx("agent:w4-3-unlocked-search-mixed");
    await requestAndApproveTier2(mixedUnlockedCtx);
    const mixedUnlocked = await invokeTool(search, { query: PERSON_A_NAME }, mixedUnlockedCtx);
    if (!mixedUnlocked.ok) throw new Error(mixedUnlocked.error.message);
    const mixedUnlockedJson = JSON.stringify(mixedUnlocked);
    expect(mixedUnlockedJson).toContain(TIER1_NOTE_SENTINEL);
    expect(mixedUnlockedJson).toContain(TIER2_JOURNAL_SENTINEL);
  });

  test("(4) timing oracle: last_contact_at moves and is visible at tier 1 after a still-invisible tier-2 interaction (ratified disclosure)", async () => {
    expect(personALastContactBefore).toBeNull();
    expect(personALastContactAfter).not.toBeNull();

    const lockedResult = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: PERSON_A_NAME },
      locked,
    );
    if (!lockedResult.ok) throw new Error(lockedResult.error.message);
    const row = (lockedResult.envelope.data as any).row;
    // Exact value match, not just presence -- proves this specific tier-2 write is what leaked
    // through, documenting the disclosure precisely enough to catch accidental widening later.
    expect(new Date(row.last_contact_at).toISOString()).toBe(
      new Date(personALastContactAfter!).toISOString(),
    );
    // What was said stays invisible even though when is now visible.
    expect(JSON.stringify(lockedResult)).not.toContain(TIER2_INTERACTION_SENTINEL);
  });

  test("(5) person B (purely journal-born, tier 2 only): clean NOT_FOUND indistinguishable from nonexistent, no search hits, no review-queue trace, no tool-path leak", async () => {
    const getContext = toolByName("minime_get_context");
    const byName = await invokeTool(getContext, { person_name: PERSON_B_NAME }, locked);
    const nonexistent = await invokeTool(getContext, { person_name: NONEXISTENT_NAME }, locked);
    expect(byName.ok).toBe(false);
    expect(nonexistent.ok).toBe(false);
    if (byName.ok || nonexistent.ok) throw new Error("unreachable");
    expect(byName.error.code).toBe("NOT_FOUND");
    // No existence oracle: byte-identical wording whether B exists at tier 2 or not at all.
    expect(byName.error.message).toBe(nonexistent.error.message);

    const byId = await invokeTool(getContext, { type: "person", id: personBId }, locked);
    expect(byId.ok).toBe(false);

    const searchResult = await invokeTool(
      toolByName("minime_search"),
      { query: PERSON_B_NAME },
      locked,
    );
    if (!searchResult.ok) throw new Error(searchResult.error.message);
    // See test (3) for why an unrelated tier-1 document can legitimately still surface as a hit
    // once tier-2 chunks are excluded -- the precise invariant is that HER content never does.
    expect(JSON.stringify(searchResult)).not.toContain(PERSON_B_NAME);

    // B was never resolved at tier 1 by anything (unlike C below), so extraction alone never
    // flags entity_promotion for her -- no trace at all, not even a masked one.
    const rq = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list", kind: "entity_promotion" },
      locked,
    );
    if (!rq.ok) throw new Error(rq.error.message);
    const items = (rq.envelope.data as any).items as any[];
    expect(items.some((i) => i.payload?.entity_id === personBId)).toBe(false);
    expect(JSON.stringify(rq)).not.toContain(PERSON_B_NAME);

    // minime_upsert_person cannot reach or reveal her either.
    const upsertAttempt = await invokeTool(
      toolByName("minime_upsert_person"),
      { type: "person", id: personBId, action: "add_alias", alias: "smuggled alias" },
      locked,
    );
    expect(upsertAttempt.ok).toBe(false);
    const [bAliasCount] = await testSql`
      select count(*)::int as n from person_aliases where person_id = ${personBId}`;
    expect(bAliasCount!.n).toBe(1); // unchanged: only her original auto-minted canonical alias

    // Unlocked: she resolves normally, like any other identity.
    const unlockedCtx = sessionToolCtx("agent:w4-3-unlocked-b");
    await requestAndApproveTier2(unlockedCtx);
    const unlockedResult = await invokeTool(
      getContext,
      { person_name: PERSON_B_NAME },
      unlockedCtx,
    );
    if (!unlockedResult.ok) throw new Error(unlockedResult.error.message);
    expect((unlockedResult.envelope.data as any).row.id).toBe(personBId);
  });

  test("(6) person C: entity_promotion masks her while open, restoreEntityTier resolves it, and afterward she behaves exactly like a tier-1 identity", async () => {
    const getContext = toolByName("minime_get_context");
    const reviewQueue = toolByName("minime_review_queue");

    // Pre-restore: locked cannot reach her at all -- structurally identical to B/nonexistent.
    const preLocked = await invokeTool(getContext, { type: "person", id: personCId }, locked);
    expect(preLocked.ok).toBe(false);
    const preUpsertAttempt = await invokeTool(
      toolByName("minime_upsert_person"),
      { type: "person", id: personCId, action: "add_alias", alias: "smuggled alias" },
      locked,
    );
    expect(preUpsertAttempt.ok).toBe(false);

    // The entity_promotion flag exists, masked at tier 1, real at tier 2 -- and names nothing
    // else about her at tier 1.
    const rqLocked = await invokeTool(
      reviewQueue,
      { action: "list", kind: "entity_promotion" },
      locked,
    );
    if (!rqLocked.ok) throw new Error(rqLocked.error.message);
    const lockedItem = ((rqLocked.envelope.data as any).items as any[]).find(
      (i) => i.payload?.entity_id === personCId,
    );
    expect(lockedItem).toBeTruthy();
    expect(lockedItem.payload.name).toBe(REVIEW_HIDDEN);
    expect(JSON.stringify(rqLocked)).not.toContain(PERSON_C_NAME);

    const cUnlockedPre = sessionToolCtx("agent:w4-3-c-unlocked-pre");
    await requestAndApproveTier2(cUnlockedPre);
    const rqUnlocked = await invokeTool(
      reviewQueue,
      { action: "list", kind: "entity_promotion" },
      cUnlockedPre,
    );
    if (!rqUnlocked.ok) throw new Error(rqUnlocked.error.message);
    const unlockedItem = ((rqUnlocked.envelope.data as any).items as any[]).find(
      (i) => i.payload?.entity_id === personCId,
    );
    expect(unlockedItem.payload.name).toBe(PERSON_C_NAME);

    // Restore: the real W4-2 owner-CLI path (entity:restore-tier wraps this same call).
    const restoreResult = await withAdminDbTransaction(() =>
      restoreEntityTier("person", personCId),
    );
    expect(restoreResult).toEqual({
      entityType: "person",
      entityId: personCId,
      resolvedReviewItemId: cOpenReviewItemId,
    });

    // Post-restore: behaves exactly like a tier-1 identity -- visible locked, with her pre-restore
    // tier-2-derived alias staying hidden (only the identity card moved; content genuinely
    // derived from tier-2 prose about her does not silently follow, same as A's new alias).
    const postLocked = await invokeTool(getContext, { person_name: PERSON_C_NAME }, locked);
    if (!postLocked.ok) throw new Error(postLocked.error.message);
    const row = (postLocked.envelope.data as any).row;
    expect(row.id).toBe(personCId);
    expect(row.relation).toBe(PERSON_C_RELATION);
    expect(JSON.stringify(postLocked)).not.toContain(PERSON_C_LEGACY_ALIAS);

    const byLegacyAlias = await invokeTool(
      getContext,
      { person_name: PERSON_C_LEGACY_ALIAS },
      locked,
    );
    expect(byLegacyAlias.ok).toBe(false); // the legacy alias itself still doesn't resolve at tier 1

    const [aliasTierRow] = await testSql`
      select tier from person_aliases where person_id = ${personCId} and alias = ${PERSON_C_LEGACY_ALIAS}`;
    expect(aliasTierRow!.tier).toBe(2); // stayed tier 2 straight through the restore

    // The review item is resolved -- gone from the open-items list, locked or not.
    const rqAfter = await invokeTool(
      reviewQueue,
      { action: "list", kind: "entity_promotion" },
      locked,
    );
    if (!rqAfter.ok) throw new Error(rqAfter.error.message);
    expect(
      ((rqAfter.envelope.data as any).items as any[]).some(
        (i) => i.payload?.entity_id === personCId,
      ),
    ).toBe(false);
  });

  test("(7) minime_state, minime_timeline, minime_agenda: driven at both tiers, no tier-2 leak", async () => {
    const sentinels = [TIER2_JOURNAL_SENTINEL, TIER2_INTERACTION_SENTINEL, PERSON_C_LEGACY_ALIAS];

    for (const toolName of ["minime_state", "minime_agenda"]) {
      const lockedRes = await invokeTool(toolByName(toolName), {}, locked);
      expect(lockedRes.ok).toBe(true);
      const text = JSON.stringify(lockedRes);
      for (const sentinel of sentinels) expect(text).not.toContain(sentinel);
    }

    const timelineParams = {
      from: "2020-01-01",
      to: "2099-12-31",
      types: ["journal", "interaction"],
    };
    const lockedTimeline = await invokeTool(toolByName("minime_timeline"), timelineParams, locked);
    if (!lockedTimeline.ok) throw new Error(lockedTimeline.error.message);
    const lockedTimelineJson = JSON.stringify(lockedTimeline);
    expect(lockedTimelineJson).not.toContain(TIER2_JOURNAL_SENTINEL);
    expect(lockedTimelineJson).not.toContain(TIER2_INTERACTION_SENTINEL);
    const lockedData = lockedTimeline.envelope.data as any;
    expect(lockedData.rows).toEqual([]);
    // The bare-count disclosure (repo.ts timeline_locked_count): distinguishable from empty.
    expect(lockedData.locked.journal).toBeGreaterThanOrEqual(1);
    expect(lockedData.locked.interaction).toBeGreaterThanOrEqual(1);

    const unlockedCtx = sessionToolCtx("agent:w4-3-unlocked-timeline");
    await requestAndApproveTier2(unlockedCtx);
    const unlockedTimeline = await invokeTool(
      toolByName("minime_timeline"),
      timelineParams,
      unlockedCtx,
    );
    if (!unlockedTimeline.ok) throw new Error(unlockedTimeline.error.message);
    const unlockedTimelineJson = JSON.stringify(unlockedTimeline);
    expect(unlockedTimelineJson).toContain(TIER2_JOURNAL_SENTINEL);
    expect(unlockedTimelineJson).toContain(TIER2_INTERACTION_SENTINEL);
  });

  test("(8) no MCP tool path can demote a person/org's tier -- schema carries no lever, and a locked target cannot even be reached", async () => {
    // Content tools (minime_correct's to_tier, minime_log_decision's tier, minime_refile's tier
    // floor) legitimately carry a tier field for CONTENT rows and are out of scope here -- this
    // checks the two tools that mutate PEOPLE/ORGS specifically, where no tier lever should exist
    // at all.
    const personSchemaKeys = Object.keys(toolByName("minime_upsert_person").schema);
    const interactionSchemaKeys = Object.keys(toolByName("minime_log_interaction").schema);
    expect(personSchemaKeys).not.toContain("tier");
    expect(interactionSchemaKeys).not.toContain("tier");

    // Behavioral: even smuggling a tier field through the wire cannot reach a locked target --
    // the resolve step 404s before any write is attempted, so there is nothing for a smuggled
    // field to act on. B (tier 2, never restored) is the target of record here.
    const smuggled = await invokeTool(
      toolByName("minime_upsert_person"),
      { type: "person", id: personBId, action: "add_alias", alias: "smuggled", tier: 1 } as any,
      locked,
    );
    expect(smuggled.ok).toBe(false);
    const [bTierRow] = await testSql`select tier from people where id = ${personBId}`;
    expect(bTierRow!.tier).toBe(2); // untouched
  });
});
