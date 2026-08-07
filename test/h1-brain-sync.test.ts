import { beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activePagesForCompiledNoteReconciliation,
  compiledEntityClusterEvidence,
  compiledRepresentationTierEvidence,
  compiledSourceEvidence,
  noteSourceChunks,
  pageByPath,
  pageChunkSnapshot,
  replaceChunks,
  retierPageEdges,
  setPageChunkTiers,
  setPageTier,
  softDeletePagesNotIn,
  upsertPage,
  withCompiledNotesLease,
} from "../src/db/repo";
import { brainSync, parseFrontmatter } from "../src/pipeline/brain-sync";
import { indexParent } from "../src/search/index-parent";
import { UNSAFE_PRIVATE_ROOT } from "../src/util/atomic-file";
import {
  COMPILED_NOTE_MARKER,
  COMPILED_NOTE_SOURCE,
  classifyFrontmatterTier,
  compiledNotePath,
  normalizeCompiledNoteBody,
  parseCompiledNoteArchive,
  renderCompiledNoteArchive,
} from "../src/util/compiled-note-archive";
import { config } from "../src/util/config";
import { resetDb, testSql } from "./helpers";

async function withPrivateDataDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "minime-h1-sync-"));
  await chmod(root, 0o700);
  const previous = config.dataDir;
  config.dataDir = root;
  try {
    return await fn(root);
  } finally {
    config.dataDir = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function writeBrainFile(root: string, relativePath: string, text: string): Promise<void> {
  const target = join(root, "brain", relativePath);
  await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { mode: 0o600 });
}

function noteBody(sourceId: string, detail = "A factual compiled note."): string {
  return `${COMPILED_NOTE_MARKER}\n\n${detail}\n\n## Sources\n- ${sourceId}`;
}

async function pageChunks(pageId: string): Promise<any[]> {
  return testSql`
    select id, parent_id, ord, text, tier
    from chunks where parent_type = 'page' and parent_id = ${pageId} order by ord`;
}

beforeEach(async () => {
  await resetDb();
});

describe("H1 compiled-note repository and brain sync hardening", () => {
  test("canonical archive with unresolved Sources is not imported before its page exists", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const relativePath = compiledNotePath("person", "Ada Lovelace", entityId);
      const archive = renderCompiledNoteArchive({
        title: "Ada Lovelace",
        tier: 1,
        bodyMd: noteBody(sourceId),
      });
      expect(parseCompiledNoteArchive(archive.text)?.contentHash).toBe(archive.contentHash);
      await writeBrainFile(root, relativePath, archive.text);

      const result = await brainSync();
      expect(result.changed).toBe(0);
      expect(result.quarantined).toBe(1);
      expect(result.issues).toEqual([
        {
          target_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
          code: "source_evidence_unverifiable",
        },
      ]);
      const page = await pageByPath(relativePath);
      expect(page).toBeNull();
      expect(await readFile(join(root, "brain", relativePath), "utf8")).toBe(archive.text);
    });
  });

  test("existing compiler-owned page survives a stale tier-1 archive and second sync is a no-op", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const path = compiledNotePath("person", "Grace Hopper", entityId);
      const [sourcePage] = await testSql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('source/grace.md', 'Grace source', 'Grace Hopper source fact.',
                'grace-source', 2, ${COMPILED_NOTE_SOURCE}, 'system:dream')
        returning id`;
      await testSql`
        insert into people (id, canonical_name, tier, source, created_by)
        values (${entityId}, 'Grace Hopper', 2, 'test', 'test')`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${sourceId}, 'page', ${sourcePage!.id}, 0, 'Grace Hopper source fact.', 2)`;
      await testSql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values
          ('page', ${sourcePage!.id}, 'mentions', 'person', ${entityId},
           'chunks', ${sourceId}, 2)`;
      const current = renderCompiledNoteArchive({
        title: "Grace Hopper",
        tier: 2,
        bodyMd: noteBody(sourceId, "Current tier-two note."),
      });
      const stale = renderCompiledNoteArchive({
        title: "Grace Hopper",
        tier: 1,
        bodyMd: noteBody(sourceId, "Stale archive bytes."),
      });
      const seeded = await upsertPage({
        path,
        title: current.title,
        bodyMd: current.bodyMd,
        contentHash: current.contentHash,
        tier: 2,
        source: COMPILED_NOTE_SOURCE,
        createdBy: "system:dream",
        derivedFrom: entityId,
      });
      await replaceChunks("page", seeded.id, [current.bodyMd], 2);
      await writeBrainFile(root, path, stale.text);

      const first = await brainSync();
      const preserved = await pageByPath(path);
      expect(preserved?.id).toBe(seeded.id);
      expect(preserved?.source).toBe(COMPILED_NOTE_SOURCE);
      expect(preserved?.body_md).toBe(current.bodyMd);
      expect(preserved?.content_hash).toBe(current.contentHash);
      expect(preserved?.tier).toBe(2);
      expect((await pageChunks(seeded.id)).every((chunk) => chunk.tier === 2)).toBe(true);

      const second = await brainSync();
      expect(second.changed).toBe(0);
      expect(second.unchanged).toBeGreaterThanOrEqual(1);
      expect(first.deleted).toBe(0);
    });
  });

  test("unresolved compiled Sources quarantine generated mirrors and preserve protected collisions", async () => {
    await withPrivateDataDir(async (root) => {
      const generatedPath = compiledNotePath("person", "Unresolved Generated", crypto.randomUUID());
      const humanPath = compiledNotePath("person", "Unresolved Human", crypto.randomUUID());
      const generatedArchive = renderCompiledNoteArchive({
        title: "Unresolved Generated",
        tier: 1,
        bodyMd: noteBody(crypto.randomUUID(), "Unresolved generated archive."),
      });
      const humanArchive = renderCompiledNoteArchive({
        title: "Unresolved Human",
        tier: 1,
        bodyMd: noteBody(crypto.randomUUID(), "Unresolved incoming archive."),
      });
      const [generated] = await testSql`
        insert into pages
          (path, title, body_md, content_hash, tier, status, source, created_by)
        values
          (${generatedPath}, 'Generated current', '# Generated current',
           'generated-current', 1, 'active', ${COMPILED_NOTE_SOURCE}, 'system:dream')
        returning id`;
      const [generatedChunk] = await testSql`
        insert into chunks
          (parent_type, parent_id, ord, text, tier, embedding, embed_model)
        values
          ('page', ${generated!.id}, 0, 'Generated current', 1,
           array_fill(0.01, array[768])::vector, 'old-model')
        returning id`;
      const humanBody = "# Human current\n\nOwner-authored prose.";
      const [human] = await testSql`
        insert into pages
          (path, title, body_md, content_hash, tier, status, source, created_by)
        values
          (${humanPath}, 'Human current', ${humanBody}, 'human-current', 1, 'active',
           'manual', 'human:owner')
        returning id, xmin::text as version`;
      await writeBrainFile(root, generatedPath, generatedArchive.text);
      await writeBrainFile(root, humanPath, humanArchive.text);
      const generatedBefore = await readFile(join(root, "brain", generatedPath));
      const humanBefore = await readFile(join(root, "brain", humanPath));

      const result = await brainSync();
      expect(result.quarantined).toBe(1);
      expect(
        result.issues.filter((issue) => issue.code === "source_evidence_unverifiable"),
      ).toHaveLength(1);
      expect(
        result.issues.filter((issue) => issue.code === "protected_page_requires_owner"),
      ).toHaveLength(1);
      expect(result.issues.every((issue) => /^[0-9a-f]{16}$/.test(issue.target_hash))).toBe(true);
      const [generatedAfter] = await testSql`
        select tier, status from pages where id = ${generated!.id}`;
      expect(generatedAfter).toEqual({ tier: 0, status: "deleted" });
      const [chunkAfter] = await testSql`
        select tier, embedding, embed_model from chunks where id = ${generatedChunk!.id}`;
      expect(chunkAfter).toEqual({ tier: 0, embedding: null, embed_model: null });
      const [humanAfter] = await testSql`
        select title, body_md, content_hash, tier, status, source, created_by,
               xmin::text as version
        from pages where id = ${human!.id}`;
      expect(humanAfter).toEqual({
        title: "Human current",
        body_md: humanBody,
        content_hash: "human-current",
        tier: 1,
        status: "active",
        source: "manual",
        created_by: "human:owner",
        version: human!.version,
      });
      expect(await readFile(join(root, "brain", generatedPath))).toEqual(generatedBefore);
      expect(await readFile(join(root, "brain", humanPath))).toEqual(humanBefore);
    });
  });

  test("compiled evidence includes page and chunk provenance, excluding dst-only decoys", async () => {
    await withPrivateDataDir(async () => {
      const pageId = crypto.randomUUID();
      const chunkId = crypto.randomUUID();
      const otherId = crypto.randomUUID();
      const [page] = await testSql`
        insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
        values (${pageId}, 'source.md', 'Source', '# Source', repeat('a', 64), 2, 'brain-sync', 'test')
        returning id`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${chunkId}, 'page', ${page!.id}, 0, 'source chunk', 2)`;
      await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values ('page', ${pageId}, 'mentions', 'person', ${otherId}, 'pages', ${pageId}, 2),
               ('page', ${pageId}, 'mentions', 'person', ${otherId}, 'chunks', ${chunkId}, 2),
               ('person', ${otherId}, 'mentions', 'page', ${pageId}, 'people', ${otherId}, 2)`;

      const evidence = await compiledSourceEvidence([chunkId]);
      expect(evidence.resolved).toHaveLength(1);
      expect(evidence.resolved[0]?.tier).toBe(2);
      expect(evidence.resolved[0]?.parent_id).toBe(pageId);
      const representations = await compiledRepresentationTierEvidence(pageId);
      expect(representations.max_tier).toBe(2);
      expect(representations.edge_count).toBe(2);
    });
  });

  test("page and chunks promote monotonically and edges are retiered through both predicates", async () => {
    await withPrivateDataDir(async () => {
      const pageId = crypto.randomUUID();
      const chunkId = crypto.randomUUID();
      const entityId = crypto.randomUUID();
      await testSql`
        insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
        values (${pageId}, 'promote.md', 'Promote', '# Promote', repeat('b', 64), 1, 'brain-sync', 'test')`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${chunkId}, 'page', ${pageId}, 0, 'promote chunk', 1)`;
      await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values ('page', ${pageId}, 'mentions', 'person', ${entityId}, 'pages', ${pageId}, 1),
               ('page', ${pageId}, 'mentions', 'person', ${entityId}, 'chunks', ${chunkId}, 1),
               ('person', ${entityId}, 'mentions', 'page', ${pageId}, 'people', ${entityId}, 2)`;

      expect(await setPageTier(pageId, 2)).toBe(true);
      expect(await setPageChunkTiers(pageId, 2)).toBe(1);
      expect(await retierPageEdges(pageId, 2)).toBe(2);
      expect(await setPageTier(pageId, 1)).toBe(false);
      expect(await setPageChunkTiers(pageId, 1)).toBe(0);
      expect(await retierPageEdges(pageId, 1)).toBe(0);
      const rows = await testSql`
        select tier from edges where (source_table = 'pages' and source_id = ${pageId})
          or (src_type = 'page' and src_id = ${pageId}) order by tier`;
      expect(rows.map((row: any) => row.tier)).toEqual([2, 2]);
    });
  });

  test("soft deletion preserves compiler-owned and positively recognized pages", async () => {
    await withPrivateDataDir(async () => {
      const compiler = await upsertPage({
        path: "derived/notes/person/old--00000000-0000-0000-0000-000000000001.md",
        title: "Old note",
        bodyMd: noteBody(crypto.randomUUID()),
        contentHash: "c".repeat(64),
        tier: 2,
        source: COMPILED_NOTE_SOURCE,
        createdBy: "system:dream",
      });
      const ordinary = await upsertPage({
        path: "ordinary.md",
        title: "Ordinary",
        bodyMd: "# ordinary",
        contentHash: "d".repeat(64),
        tier: 1,
      });
      await replaceChunks("page", compiler.id, ["compiler chunk"], 2);
      await replaceChunks("page", ordinary.id, ["ordinary chunk"], 1);
      const deleted = await softDeletePagesNotIn([], {
        preserveSources: [COMPILED_NOTE_SOURCE],
        preservePageIds: [compiler.id],
      });
      expect(deleted).toEqual([ordinary.id]);
      expect(
        (await pageByPath("derived/notes/person/old--00000000-0000-0000-0000-000000000001.md"))
          ?.status,
      ).toBe("active");
      expect((await pageByPath("ordinary.md"))?.status).toBe("deleted");
    });
  });

  test("active page snapshots expose a non-null Date updated_at", async () => {
    const stored = new Date("2026-07-23T03:04:05.000Z");
    const [fixture] = await testSql`
      insert into pages (path, title, body_md, content_hash, tier, status, source, created_by, updated_at)
      values ('derived/notes/fixture-entity.md', 'Fixture entity', '# Fixture', repeat('a', 64), 2,
        'active', 'dream:notes', 'h1-shape-test', ${stored})
      returning id`;
    const page = (await activePagesForCompiledNoteReconciliation()).find(
      (candidate) => candidate.id === fixture!.id,
    );
    expect(page?.updated_at).toBeInstanceOf(Date);
    expect(page?.updated_at?.getTime()).toBe(stored.getTime());
    expect(page?.updated_at).not.toBeNull();
  });

  test("recognized compiled indexing can skip graph mutation and still promote chunk floor", async () => {
    await withPrivateDataDir(async () => {
      const page = await upsertPage({
        path: "derived/notes/person/index--00000000-0000-0000-0000-000000000002.md",
        title: "Index",
        bodyMd: noteBody(crypto.randomUUID()),
        contentHash: "e".repeat(64),
        tier: 1,
        source: COMPILED_NOTE_SOURCE,
      });
      await indexParent("page", page.id, "# Index\n\ntext", "Index", 2, {
        extractEdges: false,
        tierMode: "promote-page-floor",
      });
      const chunks = await pageChunks(page.id);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((chunk) => chunk.tier === 2)).toBe(true);
      const edgeCount = await testSql`
        select count(*)::int as n from edges where source_table = 'pages' and source_id = ${page.id}`;
      expect(edgeCount[0]!.n).toBe(0);
    });
  });

  test("upsert restores a deleted page by UUID and maps provenance/hash options explicitly", async () => {
    const original = await upsertPage({
      path: "deleted.md",
      title: "Deleted",
      bodyMd: "# old",
      contentHash: "f".repeat(64),
      source: "brain-sync",
    });
    await testSql`update pages set status = 'deleted', source = 'old', created_by = 'old' where id = ${original.id}`;
    const restored = await upsertPage(
      {
        path: "deleted.md",
        title: "Restored",
        bodyMd: "# restored",
        contentHash: "a".repeat(64),
        source: COMPILED_NOTE_SOURCE,
        createdBy: "system:dream",
        derivedFrom: null,
        tier: 2,
      },
      { provenanceMode: "replace" },
    );
    expect(restored.id).toBe(original.id);
    const row = await pageByPath("deleted.md");
    expect(row?.status).toBe("active");
    expect(row?.source).toBe(COMPILED_NOTE_SOURCE);
    expect(row?.created_by).toBe("system:dream");
    expect(row?.derived_from).toBeNull();
  });

  test("symlinked brain root fails before walk, read, or soft deletion", async () => {
    await withPrivateDataDir(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "minime-h1-outside-"));
      const brain = join(root, "brain");
      try {
        await symlink(outside, brain);
        await expect(brainSync()).rejects.toThrow(UNSAFE_PRIVATE_ROOT);
        expect(await readFile(join(outside, "missing.md")).catch(() => null)).toBeNull();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("compiled Sources resolve in chunk chronology, not Sources-list order", async () => {
    const entityId = crypto.randomUUID();
    const earlyId = crypto.randomUUID();
    const lateId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    const early = new Date("2026-01-01T00:00:00.000Z");
    const late = new Date("2026-01-02T00:00:00.000Z");
    await testSql`
      insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
      values (${parentId}, 'chronology.md', 'Chronology', '# Ada', repeat('a', 64), 1, 'brain-sync', 'test')`;
    await testSql`
      insert into people (id, canonical_name, created_by, source, tier)
      values (${entityId}, 'Ada', 'test', 'test', 1)`;
    await testSql`
      insert into chunks (id, parent_type, parent_id, ord, text, tier, updated_at)
      values (${earlyId}, 'page', ${parentId}, 1, 'Ada early', 1, ${early}),
             (${lateId}, 'page', ${parentId}, 0, 'Ada late', 1, ${late})`;
    await testSql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id)
      values ('page', ${parentId}, 'mentions', 'person', ${entityId}, 'chunks', ${earlyId}),
             ('page', ${parentId}, 'mentions', 'person', ${entityId}, 'chunks', ${lateId})`;

    const evidence = await compiledSourceEvidence([lateId, earlyId]);
    expect(evidence.resolved.map((row) => row.id)).toEqual([earlyId, lateId]);
    expect(evidence.representative_parent_id).toBe(parentId);
  });

  test("compiled-notes lease blocks on the fixed two-int advisory key", async () => {
    const held = await (testSql as any).reserve();
    let entered = false;
    try {
      await held`select pg_advisory_lock(1296649541, 1)`;
      const waiting = withCompiledNotesLease(async () => {
        entered = true;
        return "entered";
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(entered).toBe(false);
      await held`select pg_advisory_unlock(1296649541, 1)`;
      await expect(waiting).resolves.toBe("entered");
      expect(entered).toBe(true);
    } finally {
      try {
        await held`select pg_advisory_unlock(1296649541, 1)`;
      } catch {}
      held.release();
    }
  });

  test("max-only tier setters wait for the page row and preserve no-op counts", async () => {
    const pageTierId = crypto.randomUUID();
    const chunkTierId = crypto.randomUUID();
    const edgeTierId = crypto.randomUUID();
    const entityId = crypto.randomUUID();
    await testSql`
      insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
      values (${pageTierId}, 'lock-page.md', 'Lock page', '# lock', repeat('a', 64), 1, 'test', 'test'),
             (${chunkTierId}, 'lock-chunk.md', 'Lock chunk', '# lock', repeat('b', 64), 1, 'test', 'test'),
             (${edgeTierId}, 'lock-edge.md', 'Lock edge', '# lock', repeat('c', 64), 1, 'test', 'test')`;
    await replaceChunks("page", chunkTierId, ["chunk"], 1);
    await testSql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
      values ('page', ${edgeTierId}, 'mentions', 'person', ${entityId}, null, null, 1)`;

    const held = await (testSql as any).reserve();
    const pending: Promise<unknown>[] = [];
    try {
      await held`begin`;
      await held`
        select id from pages
        where id in (${pageTierId}, ${chunkTierId}, ${edgeTierId})
        order by id for update`;
      pending.push(setPageTier(pageTierId, 2));
      pending.push(setPageChunkTiers(chunkTierId, 2));
      pending.push(retierPageEdges(edgeTierId, 2));
      const settledEarly = await Promise.race([
        Promise.all(pending).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 40)),
      ]);
      expect(settledEarly).toBe(false);
      const waitingQueries = await testSql`
        select query from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock' and state = 'active' and query ilike '%pages%'`;
      expect(waitingQueries.length).toBeGreaterThanOrEqual(3);
      expect(
        waitingQueries.every((row: any) =>
          /select id from pages[\s\S]*for update/i.test(row.query),
        ),
      ).toBe(true);
      await held`commit`;
      await expect(Promise.all(pending)).resolves.toEqual([true, 1, 1]);
    } finally {
      try {
        await held`rollback`;
      } catch {}
      held.release();
    }
  });

  test("recognized archive tier is derived from evidence, never frontmatter", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const sourcePageId = crypto.randomUUID();
      const path = compiledNotePath("person", "Tier Source", entityId);
      await testSql`
        insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
        values (${sourcePageId}, 'tier-source.md', 'Tier Source', '# Tier Source', repeat('a', 64), 1, 'brain-sync', 'test')`;
      await testSql`
        insert into people (id, canonical_name, created_by, source, tier)
        values (${entityId}, 'Tier Source', 'test', 'test', 1)`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${sourceId}, 'page', ${sourcePageId}, 0, 'Tier Source mention', 1)`;
      await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id)
        values ('page', ${sourcePageId}, 'mentions', 'person', ${entityId}, 'chunks', ${sourceId})`;
      const archive = renderCompiledNoteArchive({
        title: "Tier Source",
        tier: 2,
        bodyMd: noteBody(sourceId, "Tier-one source."),
      });
      await writeBrainFile(root, path, archive.text);

      await brainSync();
      const page = await pageByPath(path);
      expect(page?.tier).toBe(1);
    });
  });

  test("recognized non-dream pages include existing representation floors but exclude dst-only edges", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const pageId = crypto.randomUUID();
      const representationChunkId = crypto.randomUUID();
      const path = compiledNotePath("person", "Representation", entityId);
      const body = noteBody(sourceId, "Representation source.");
      await testSql`
        insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
        values (${pageId}, ${path}, 'Representation', ${body}, repeat('a', 64), 1, 'brain-sync', 'test')`;
      await testSql`
        insert into people (id, canonical_name, created_by, source, tier)
        values (${entityId}, 'Representation', 'test', 'test', 1)`;
      const [sourcePage] = await testSql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('representation-source.md', 'Source', '# Representation', repeat('b', 64), 1, 'brain-sync', 'test')
        returning id`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${sourceId}, 'page', ${sourcePage!.id}, 0, 'Representation mention', 1),
               (${representationChunkId}, 'page', ${pageId}, 0, 'existing tier two representation', 2)`;
      const [canonical] = await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id)
        values ('page', ${pageId}, 'mentions', 'person', ${entityId}, 'pages', ${pageId})
        returning id`;
      await testSql`update edges set tier = 2 where id = ${canonical!.id}`;
      await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values ('page', ${pageId}, 'mentions', 'person', ${entityId}, 'chunks', ${representationChunkId}, 2),
               ('person', ${entityId}, 'mentions', 'page', ${pageId}, 'people', ${entityId}, 1),
               ('page', ${sourcePage!.id}, 'mentions', 'person', ${entityId}, 'chunks', ${sourceId}, 1)`;
      const archive = renderCompiledNoteArchive({ title: "Representation", tier: 1, bodyMd: body });
      await writeBrainFile(root, path, archive.text);

      await brainSync();
      const page = await pageByPath(path);
      expect(page?.tier).toBe(2);
      const representations = await compiledRepresentationTierEvidence(pageId);
      expect(representations.max_tier).toBe(2);
      const dstOnly = await testSql`
        select tier from edges where dst_type = 'page' and dst_id = ${pageId}`;
      expect(dstOnly[0]!.tier).toBe(1);
    });
  });

  test("target lease rereads and converges a representation floor promoted mid-sync", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const pageId = crypto.randomUUID();
      const pageChunkId = crypto.randomUUID();
      const path = compiledNotePath("person", "Mid-sync", entityId);
      const body = noteBody(sourceId, "Mid-sync source.");
      await testSql`
        insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
        values (${pageId}, ${path}, 'Mid-sync', ${body}, repeat('a', 64), 1, 'brain-sync', 'test')`;
      const [sourcePage] = await testSql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('mid-sync-source.md', 'Source', '# Mid-sync', repeat('b', 64), 1, 'brain-sync', 'test')
        returning id`;
      await testSql`
        insert into people (id, canonical_name, created_by, source, tier)
        values (${entityId}, 'Mid-sync', 'test', 'test', 1)`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${sourceId}, 'page', ${sourcePage!.id}, 0, 'Mid-sync mention', 1),
               (${pageChunkId}, 'page', ${pageId}, 0, 'old compiled page chunk', 1)`;
      await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id)
        values ('page', ${sourcePage!.id}, 'mentions', 'person', ${entityId}, 'chunks', ${sourceId}),
               ('page', ${pageId}, 'mentions', 'person', ${entityId}, 'pages', ${pageId}),
               ('page', ${pageId}, 'mentions', 'person', ${entityId}, 'chunks', ${pageChunkId})`;
      await testSql.unsafe(`
        create or replace function h1_sync_sleep_page_update() returns trigger language plpgsql as $$
        begin perform pg_sleep(0.20); return new; end $$;
        create trigger h1_sync_sleep_page_update before update of body_md on pages
          for each row execute function h1_sync_sleep_page_update()`);
      const archive = renderCompiledNoteArchive({ title: "Mid-sync", tier: 1, bodyMd: body });
      await writeBrainFile(root, path, archive.text);
      try {
        const syncing = brainSync();
        await new Promise((resolve) => setTimeout(resolve, 40));
        await testSql`update chunks set tier = 2 where id = ${pageChunkId}`;
        await testSql`
          update edges set tier = 2
          where ((source_table = 'pages' and source_id = ${pageId})
             or (src_type = 'page' and src_id = ${pageId}))`;
        await syncing;
      } finally {
        await testSql.unsafe("drop trigger if exists h1_sync_sleep_page_update on pages");
        await testSql.unsafe("drop function if exists h1_sync_sleep_page_update()");
      }
      const page = await pageByPath(path);
      expect(page?.tier).toBe(2);
      expect((await pageChunks(pageId)).every((chunk) => chunk.tier === 2)).toBe(true);
    });
  });

  test("archive target symlink components are rejected before bytes are read", async () => {
    await withPrivateDataDir(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "minime-h1-archive-outside-"));
      try {
        await mkdir(join(outside, "nested"), { recursive: true, mode: 0o700 });
        await writeFile(join(outside, "nested", "unsafe.md"), "# outside", { mode: 0o600 });
        await mkdir(join(root, "brain"), { recursive: true, mode: 0o700 });
        await symlink(join(outside, "nested"), join(root, "brain", "nested"));
        await expect(brainSync()).rejects.toThrow(UNSAFE_PRIVATE_ROOT);
        const rows = await testSql`select count(*)::int as n from pages`;
        expect(rows[0]!.n).toBe(0);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("incoming marker/Sources recognition protects a non-UUID tier-two page", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const pageId = crypto.randomUUID();
      const path = "ordinary-note.md";
      const incomingBody = noteBody(sourceId, "Incoming marker body.");
      const archive = renderCompiledNoteArchive({
        title: "Ordinary note",
        tier: 1,
        bodyMd: incomingBody,
      });
      await testSql`
        insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
        values (${pageId}, ${path}, 'Ordinary note', '# old body', repeat('a', 64), 2, 'brain-sync', 'test')`;
      await replaceChunks("page", pageId, ["old body"], 2);
      const [sourcePage] = await testSql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('incoming-source.md', 'Source', '# Incoming', repeat('b', 64), 1, 'brain-sync', 'test')
        returning id`;
      await testSql`
        insert into people (id, canonical_name, created_by, source, tier)
        values (${entityId}, 'Incoming', 'test', 'test', 1)`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${sourceId}, 'page', ${sourcePage!.id}, 0, 'Incoming mention', 1)`;
      await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id)
        values ('page', ${sourcePage!.id}, 'mentions', 'person', ${entityId}, 'chunks', ${sourceId})`;
      await writeBrainFile(root, path, archive.text);
      const beforeEdges =
        await testSql`select count(*)::int as n from edges where src_id = ${pageId}`;

      const result = await brainSync();
      const page = await pageByPath(path);
      expect(result.changed).toBe(1);
      expect(page?.tier).toBe(2);
      expect(page?.body_md).toBe(normalizeCompiledNoteBody(incomingBody));
      const afterEdges =
        await testSql`select count(*)::int as n from edges where src_id = ${pageId}`;
      expect(afterEdges[0]!.n).toBe(beforeEdges[0]!.n);
    });
  });

  test("aligned tier-two pages promote lower chunks and edges, then become no-op", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const pageId = crypto.randomUUID();
      const pageChunkId = crypto.randomUUID();
      const path = "aligned-marker.md";
      const body = noteBody(sourceId, "Aligned body.");
      const archive = renderCompiledNoteArchive({ title: "Aligned", tier: 1, bodyMd: body });
      const rawArchive = archive.text.replace(/\n$/, "");
      const rawHash = new Bun.CryptoHasher("sha256").update(rawArchive).digest("hex");
      await testSql`
        insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
        values (${pageId}, ${path}, 'Aligned', ${body}, ${rawHash}, 2, 'brain-sync', 'test')`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${pageChunkId}, 'page', ${pageId}, 0, 'lower compiled chunk', 1)`;
      await testSql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('aligned-source.md', 'Source', '# Aligned', repeat('b', 64), 1,
                ${COMPILED_NOTE_SOURCE}, 'system:dream')`;
      const [sourcePage] = await testSql`select id from pages where path = 'aligned-source.md'`;
      await testSql`
        insert into people (id, canonical_name, created_by, source, tier)
        values (${entityId}, 'Aligned', 'test', 'test', 1)`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${sourceId}, 'page', ${sourcePage!.id}, 0, 'Aligned mention', 1)`;
      const [canonical] = await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id)
        values ('page', ${pageId}, 'mentions', 'person', ${entityId}, 'pages', ${pageId})
        returning id`;
      await testSql`update edges set tier = 1 where id = ${canonical!.id}`;
      await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values ('page', ${pageId}, 'mentions', 'person', ${entityId}, 'chunks', ${pageChunkId}, 1),
               ('page', ${sourcePage!.id}, 'mentions', 'person', ${entityId}, 'chunks', ${sourceId}, 1)`;
      await writeBrainFile(root, path, rawArchive);

      const first = await brainSync();
      expect(first.changed).toBe(1);
      const firstChunks = await pageChunks(pageId);
      expect(firstChunks.every((chunk) => chunk.tier === 2)).toBe(true);
      const firstEdges = await testSql`
        select tier from edges where (source_table = 'pages' and source_id = ${pageId})
          or (src_type = 'page' and src_id = ${pageId}) order by id`;
      expect(firstEdges.every((edge: any) => edge.tier === 2)).toBe(true);

      const second = await brainSync();
      expect(second.changed).toBe(0);
      expect(second.unchanged).toBe(1);
    });
  });

  test("compiled source ownership requires mentions edges, while exact mentions still resolve", async () => {
    const sourceId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    const entityId = crypto.randomUUID();
    await testSql`
      insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
      values (${parentId}, 'edge-kind-source.md', 'Source', '# Exact', repeat('a', 64), 1, 'brain-sync', 'test')`;
    await testSql`
      insert into people (id, canonical_name, created_by, source, tier)
      values (${entityId}, 'Exact Owner', 'test', 'test', 1)`;
    await testSql`
      insert into chunks (id, parent_type, parent_id, ord, text, tier)
      values (${sourceId}, 'page', ${parentId}, 0, 'Exact Owner mention', 1)`;
    await testSql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id)
      values ('page', ${parentId}, 'supports', 'person', ${entityId}, 'chunks', ${sourceId})`;
    const unrelated = await compiledSourceEvidence([sourceId]);
    expect(unrelated.owner_entities).toEqual([]);
    expect(unrelated.resolved[0]?.mention_created_at).toBeNull();
    await testSql`
      insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id)
      values ('page', ${parentId}, 'mentions', 'person', ${entityId}, 'chunks', ${sourceId})`;
    const exact = await compiledSourceEvidence([sourceId]);
    expect(exact.owner_entities).toEqual([{ kind: "person", entityId }]);
    expect(exact.resolved[0]?.mention_created_at).toBeInstanceOf(Date);
  });

  test("compiled evidence uses readable alias tiers and never matches a tier-zero alias", async () => {
    const [person] = await testSql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Compiled Alias Canonical', 1, 'test', 'test') returning id`;
    const privateAlias = "Compiled Private Alias";
    await testSql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${person!.id}, ${privateAlias}, 2, 'test', 'test')`;
    const [page] = await testSql`
      insert into pages (path, title, body_md, content_hash, tier)
      values ('compiled/private-alias.md', 'Private alias', ${privateAlias},
              'compiled-private-alias', 1) returning id`;
    const [chunk] = await testSql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${page!.id}, 0, ${`${privateAlias} source fact.`}, 1) returning id`;
    await testSql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
      values ('page', ${page!.id}, 'mentions', 'person', ${person!.id},
              'chunks', ${chunk!.id}, 1)`;

    const source = await compiledSourceEvidence([chunk!.id]);
    expect(source.owner_entities).toEqual([{ kind: "person", entityId: person!.id }]);
    expect(source.max_tier).toBe(2);
    const cluster = await compiledEntityClusterEvidence([{ kind: "person", entityId: person!.id }]);
    expect(cluster.source_chunk_ids).toContain(chunk!.id);
    expect(cluster.max_tier).toBe(2);
    const noteChunks = await noteSourceChunks("person", person!.id);
    expect(noteChunks.find((row) => row.id === chunk!.id)?.max_tier).toBe(2);

    const [hiddenPerson] = await testSql`
      insert into people (canonical_name, tier, source, created_by)
      values ('Hidden Alias Canonical', 1, 'test', 'test') returning id`;
    const hiddenAlias = "TIER0-COMPILED-ALIAS-SENTINEL";
    await testSql`
      insert into person_aliases (person_id, alias, tier, source, created_by)
      values (${hiddenPerson!.id}, ${hiddenAlias}, 0, 'quarantine', 'owner:test')`;
    const [hiddenPage] = await testSql`
      insert into pages (path, title, body_md, content_hash, tier)
      values ('compiled/hidden-alias.md', 'Hidden alias', ${hiddenAlias},
              'compiled-hidden-alias', 1) returning id`;
    const [hiddenChunk] = await testSql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${hiddenPage!.id}, 0, ${`${hiddenAlias} source fact.`}, 1) returning id`;
    await testSql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
      values ('page', ${hiddenPage!.id}, 'mentions', 'person', ${hiddenPerson!.id},
              'pages', ${hiddenPage!.id}, 1)`;

    const hiddenSource = await compiledSourceEvidence([hiddenChunk!.id]);
    expect(hiddenSource.owner_entities).toEqual([]);
    const hiddenCluster = await compiledEntityClusterEvidence([
      { kind: "person", entityId: hiddenPerson!.id },
    ]);
    expect(hiddenCluster.source_chunk_ids).not.toContain(hiddenChunk!.id);
    expect(await noteSourceChunks("person", hiddenPerson!.id)).toEqual([]);
  });

  test("new canonical imports persist normalized body and stable chunks", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const path = compiledNotePath("person", "Normalized", entityId);
      const body = noteBody(sourceId, "Normalized body.");
      const archive = renderCompiledNoteArchive({ title: "Normalized", tier: 1, bodyMd: body });
      const [sourcePage] = await testSql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('source/normalized.md', 'Normalized source', 'Normalized source fact.',
                'normalized-source', 1, ${COMPILED_NOTE_SOURCE}, 'system:dream')
        returning id`;
      await testSql`
        insert into people (id, canonical_name, tier, source, created_by)
        values (${entityId}, 'Normalized', 1, 'test', 'test')`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${sourceId}, 'page', ${sourcePage!.id}, 0, 'Normalized source fact.', 1)`;
      await testSql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values
          ('page', ${sourcePage!.id}, 'mentions', 'person', ${entityId},
           'chunks', ${sourceId}, 1)`;
      await writeBrainFile(root, path, archive.text);

      const first = await brainSync();
      const page = await pageByPath(path);
      expect(first.changed).toBe(1);
      expect(page?.body_md).toBe(normalizeCompiledNoteBody(body));
      expect(page?.body_md.endsWith("\n")).toBe(false);
      const firstChunks = await pageChunks(page!.id);
      const second = await brainSync();
      const secondChunks = await pageChunks(page!.id);
      expect(second.changed).toBe(0);
      expect(second.unchanged).toBe(1);
      expect(secondChunks.map((chunk) => chunk.text)).toEqual(
        firstChunks.map((chunk) => chunk.text),
      );
    });
  });

  test("recognized non-dream pages promote representations before page upsert", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const clusterSourceId = crypto.randomUUID();
      const pageId = crypto.randomUUID();
      const pageChunkId = crypto.randomUUID();
      const path = "pre-promote-ordinary.md";
      const incomingBody = noteBody(sourceId, "Pre-promote incoming body.");
      const archive = renderCompiledNoteArchive({
        title: "Pre-promote ordinary",
        tier: 1,
        bodyMd: incomingBody,
      });
      await testSql`
        insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
        values (${pageId}, ${path}, 'Pre-promote ordinary', '# stale body', repeat('a', 64), 1,
          'brain-sync', 'test')`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${pageChunkId}, 'page', ${pageId}, 0, 'stale compiled chunk', 1)`;
      const [sourcePage] = await testSql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('pre-promote-source.md', 'Source', '# Source', repeat('b', 64), 2,
                ${COMPILED_NOTE_SOURCE}, 'system:dream')
        returning id`;
      const [clusterPage] = await testSql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('pre-promote-cluster.md', 'Cluster', '# Cluster', repeat('c', 64), 2,
                ${COMPILED_NOTE_SOURCE}, 'system:dream')
        returning id`;
      await testSql`
        insert into people (id, canonical_name, created_by, source, tier)
        values (${entityId}, 'Pre Promote', 'test', 'test', 2)`;
      await testSql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${sourceId}, 'page', ${sourcePage!.id}, 0, 'Pre Promote source evidence', 2),
               (${clusterSourceId}, 'page', ${clusterPage!.id}, 0, 'Pre Promote cluster evidence', 2)`;
      await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values ('page', ${sourcePage!.id}, 'mentions', 'person', ${entityId}, 'chunks', ${sourceId}, 2),
               ('page', ${clusterPage!.id}, 'mentions', 'person', ${entityId}, 'chunks', ${clusterSourceId}, 2),
               ('page', ${pageId}, 'mentions', 'person', ${entityId}, 'pages', ${pageId}, 1),
               ('page', ${pageId}, 'mentions', 'person', ${entityId}, 'chunks', ${pageChunkId}, 1),
               ('person', ${entityId}, 'mentions', 'page', ${pageId}, null, null, 1)`;
      await writeBrainFile(root, path, archive.text);

      const held = await (testSql as any).reserve();
      let syncing: Promise<unknown> | undefined;
      try {
        await held`begin`;
        await held`select id from pages where id = ${pageId} for update`;
        syncing = brainSync();

        let waitingQueries: any[] = [];
        for (let attempt = 0; attempt < 100; attempt++) {
          waitingQueries = await testSql`
            select query from pg_stat_activity
            where pid <> pg_backend_pid()
              and wait_event_type = 'Lock' and state = 'active'
              and query ilike '%pages%'`;
          if (waitingQueries.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const pageWait = waitingQueries.find((row: any) => /pages/i.test(row.query));
        expect(pageWait?.query).toMatch(/select id from pages[\s\S]*for update/i);
        expect(pageWait?.query).not.toMatch(/update pages set/i);
        await held`commit`;
        await syncing;
      } finally {
        try {
          await held`rollback`;
        } catch {}
        held.release();
        if (syncing) await syncing;
      }

      const page = await pageByPath(path);
      expect(page?.tier).toBe(2);
      expect((await pageChunks(pageId)).every((chunk) => chunk.tier === 2)).toBe(true);
      const targetEdges = await testSql`
        select tier from edges
        where (source_table = 'pages' and source_id = ${pageId})
           or (src_type = 'page' and src_id = ${pageId})
        order by id`;
      expect(targetEdges).toHaveLength(2);
      expect(targetEdges.every((edge: any) => edge.tier === 2)).toBe(true);
      const sourceArm = await testSql`
        select tier from edges where source_table = 'pages' and source_id = ${pageId}`;
      const srcArm = await testSql`
        select tier from edges where src_type = 'page' and src_id = ${pageId}`;
      expect(sourceArm).toHaveLength(1);
      expect(sourceArm.every((edge: any) => edge.tier === 2)).toBe(true);
      expect(srcArm).toHaveLength(2);
      expect(srcArm.every((edge: any) => edge.tier === 2)).toBe(true);
      const dstOnly = await testSql`
        select tier from edges where dst_type = 'page' and dst_id = ${pageId}`;
      expect(dstOnly).toHaveLength(1);
      expect(dstOnly[0]!.tier).toBe(1);

      const second = await brainSync();
      expect(second.changed).toBe(0);
      expect(second.unchanged).toBe(1);
    });
  });

  test("brain sync source gates each archive target with private-component validation", async () => {
    const source = await readFile(
      new URL("../src/pipeline/brain-sync.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("assertNoSymlinkComponents(config.dataDir, archiveTarget)");
  });

  test("compiled evidence reports exact mixed edge alignment", async () => {
    await withPrivateDataDir(async () => {
      const pageId = crypto.randomUUID();
      await testSql`
        insert into pages (id, path, title, body_md, content_hash, tier, source, created_by)
        values (${pageId}, 'mixed-edge-evidence.md', 'Mixed edge evidence', '# Mixed', repeat('a', 64), 1, 'test', 'test')`;
      const [sourceTableEdge] = await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values ('page', ${pageId}, 'mixed-a', 'person', ${crypto.randomUUID()}, 'pages', ${pageId}, 1)
        returning id`;
      await testSql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, tier)
        values ('page', ${pageId}, 'mixed-b', 'person', ${crypto.randomUUID()}, 1)`;
      await testSql`update edges set tier = 2 where id = ${sourceTableEdge!.id}`;
      const evidence = await compiledRepresentationTierEvidence(pageId);
      expect(evidence.edge_count).toBe(2);
      expect(evidence.edge_min_tier).toBe(1);
      expect(evidence.edge_max_tier).toBe(2);
    });
  });

  test("tier-zero Markdown is quarantined before recognition, indexing, or active persistence", async () => {
    await withPrivateDataDir(async (root) => {
      const sentinel = "TIER0-BRAIN-SYNC-SENTINEL";
      await writeBrainFile(
        root,
        "private-zero.md",
        `---\ntitle: Private zero\ntier: 0\n---\n# Private zero\n\n${sentinel}\n`,
      );

      const result = (await brainSync()) as any;
      expect(result.quarantined).toBe(1);
      expect(result.issues).toEqual([
        {
          target_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
          code: "tier0_quarantined",
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("private-zero.md");
      const pages = await testSql`
        select id from pages where path = 'private-zero.md' and status = 'active'`;
      expect(pages).toHaveLength(0);
      const prose = await testSql`
        select text, embedding, embed_model from chunks where text like ${`%${sentinel}%`}`;
      expect(prose).toHaveLength(0);
      const edges = await testSql`
        select id from edges where source_table = 'pages'
          and source_id in (select id from pages where path = 'private-zero.md')`;
      expect(edges).toHaveLength(0);
    });
  });

  test("generated mirrors are transactionally quarantined without mutating archive bytes or reactivation", async () => {
    await withPrivateDataDir(async (root) => {
      const fixtures = [
        {
          path: "ordinary-generated.md",
          source: "brain-sync",
          creator: "brain-sync",
        },
        {
          path: compiledNotePath("person", "Quarantine Mirror", crypto.randomUUID()),
          source: COMPILED_NOTE_SOURCE,
          creator: "system:dream",
        },
      ];
      const pageIds: string[] = [];
      const chunkIds: string[] = [];
      const archived = new Map<string, Uint8Array>();
      for (const [index, fixture] of fixtures.entries()) {
        const body = `# Generated ${index}\n\n${COMPILED_NOTE_MARKER}\n\nGenerated sentinel ${index}.\n\n## Sources\n- ${crypto.randomUUID()}`;
        const [page] = await testSql`
          insert into pages
            (path, title, body_md, content_hash, tier, status, source, created_by)
          values
            (${fixture.path}, ${`Generated ${index}`}, ${body}, ${`generated-${index}`},
             1, 'active', ${fixture.source}, ${fixture.creator})
          returning id`;
        const [chunk] = await testSql`
          insert into chunks
            (parent_type, parent_id, ord, text, tier, embedding, embed_model)
          values
            ('page', ${page!.id}, 0, ${body}, 1, array_fill(0.01, array[768])::vector, 'old-model')
          returning id`;
        await testSql`
          insert into edges
            (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
          values
            ('page', ${page!.id}, 'page-source', 'person', ${crypto.randomUUID()},
             'pages', ${page!.id}, 1),
            ('page', ${page!.id}, 'canonical-parent', 'person', ${crypto.randomUUID()},
             null, null, 1),
            ('page', ${page!.id}, 'chunk-source', 'person', ${crypto.randomUUID()},
             'chunks', ${chunk!.id}, 1)`;
        const bytes = Buffer.from(
          `---\ntitle: Generated ${index}\ntier: 0\n---\n${body}\n`,
          "utf8",
        );
        await writeBrainFile(root, fixture.path, bytes.toString("utf8"));
        archived.set(fixture.path, bytes);
        pageIds.push(page!.id);
        chunkIds.push(chunk!.id);
      }

      const first = (await brainSync()) as any;
      expect(first.quarantined).toBe(2);
      const rows = await testSql`
        select id, tier, status from pages where id = any(${pageIds}::uuid[]) order by id`;
      expect(rows.every((row) => row.tier === 0 && row.status === "deleted")).toBe(true);
      const chunks = await testSql`
        select id, tier, embedding, embed_model from chunks
        where id = any(${chunkIds}::uuid[]) order by id`;
      expect(
        chunks.every(
          (chunk) => chunk.tier === 0 && chunk.embedding === null && chunk.embed_model === null,
        ),
      ).toBe(true);
      const edges = await testSql`
        select tier from edges
        where (source_table = 'pages' and source_id = any(${pageIds}::uuid[]))
           or (src_type = 'page' and src_id = any(${pageIds}::uuid[]))
           or (source_table = 'chunks' and source_id = any(${chunkIds}::uuid[]))`;
      expect(edges).toHaveLength(6);
      expect(edges.every((edge) => edge.tier === 0)).toBe(true);
      for (const fixture of fixtures) {
        expect(
          Buffer.from(await readFile(join(root, "brain", fixture.path))).equals(
            Buffer.from(archived.get(fixture.path)!),
          ),
        ).toBe(true);
      }

      const second = (await brainSync()) as any;
      expect(second.quarantined).toBe(2);
      const after = await testSql`
        select tier, status from pages where id = any(${pageIds}::uuid[])`;
      expect(after.every((row) => row.tier === 0 && row.status === "deleted")).toBe(true);
    });
  });

  test("tier-zero human collisions stay byte-for-byte unchanged and report only an opaque owner issue", async () => {
    await withPrivateDataDir(async (root) => {
      const path = "human-private.md";
      const originalBody = "# Human original\n\nOwner prose.";
      const [page] = await testSql`
        insert into pages
          (path, title, body_md, content_hash, tier, status, source, created_by)
        values
          (${path}, 'Human original', ${originalBody}, 'human-original', 1, 'active',
           'manual', 'human:owner')
        returning id, xmin::text as version`;
      await writeBrainFile(
        root,
        path,
        "---\ntitle: Do not claim\ntier: 0\n---\n# Incoming\n\nPRIVATE-PATH-SENTINEL\n",
      );

      const result = (await brainSync()) as any;
      expect(result.quarantined).toBe(0);
      expect(result.issues).toEqual([
        {
          target_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
          code: "protected_page_requires_owner",
        },
      ]);
      expect(JSON.stringify(result)).not.toContain(path);
      expect(JSON.stringify(result)).not.toContain("PRIVATE-PATH-SENTINEL");
      const [after] = await testSql`
        select title, body_md, content_hash, tier, status, source, created_by, xmin::text as version
        from pages where id = ${page!.id}`;
      expect(after).toEqual({
        title: "Human original",
        body_md: originalBody,
        content_hash: "human-original",
        tier: 1,
        status: "active",
        source: "manual",
        created_by: "human:owner",
        version: page!.version,
      });
    });
  });

  test("invalid tier scalars quarantine instead of defaulting while safe legacy scalars remain compatible", async () => {
    await withPrivateDataDir(async (root) => {
      const invalid = [
        ["negative.md", "-1"],
        ["fractional.md", "1.5"],
        ["large.md", "3"],
        ["word.md", "private"],
      ] as const;
      for (const [path, tier] of invalid) {
        await writeBrainFile(
          root,
          path,
          `---\ntitle: Invalid\ntier: ${tier}\n---\nINVALID-${path}\n`,
        );
      }
      await writeBrainFile(
        root,
        "duplicate.md",
        "---\ntitle: Duplicate\ntier: 1\ntier: invalid-final\n---\nINVALID-DUPLICATE\n",
      );
      await writeBrainFile(
        root,
        "quoted.md",
        "---\ntitle: Quoted\ntier: '2'\n---\n# Quoted\n\nLegacy quoted scalar.\n",
      );
      await writeBrainFile(root, "eof-delimiter.md", "---\ntitle: EOF\ntier: 2\n---");

      expect(parseFrontmatter("---\ntier: '2'\n---\nbody\n").tier).toBe(2);
      expect(parseFrontmatter("---\ntier: 2\n---").tier).toBe(2);
      const result = (await brainSync()) as any;
      expect(
        result.issues.filter((issue: any) => issue.code === "invalid_tier_quarantined"),
      ).toHaveLength(5);
      const invalidPaths: string[] = [...invalid.map(([path]) => path), "duplicate.md"];
      const invalidRows = await testSql`
        select path from pages
        where path = any(${invalidPaths})`;
      expect(invalidRows).toHaveLength(0);
      const compatible = await testSql`
        select path, tier from pages where path in ('quoted.md', 'eof-delimiter.md') order by path`;
      expect(compatible.map((row) => ({ path: row.path, tier: row.tier }))).toEqual([
        { path: "eof-delimiter.md", tier: 2 },
        { path: "quoted.md", tier: 2 },
      ]);
    });
  });

  test("unterminated leading frontmatter is malformed-present and never defaults to tier one", async () => {
    await withPrivateDataDir(async (root) => {
      const fixtures = [
        ["unterminated-zero.md", "---\ntitle: Unterminated zero\ntier: 0\n# private zero"],
        ["unterminated-one.md", "---\ntitle: Unterminated one\ntier: 1\n# private one"],
        ["unterminated-absent.md", "---\ntitle: Unterminated absent\n# private absent"],
      ] as const;
      for (const [path, bytes] of fixtures) {
        expect(classifyFrontmatterTier(bytes)).toEqual({ kind: "invalid" });
        await writeBrainFile(root, path, bytes);
      }

      const result = await brainSync();

      expect(result.quarantined).toBe(3);
      expect(
        result.issues.filter((issue) => issue.code === "invalid_tier_quarantined"),
      ).toHaveLength(3);
      expect(
        await testSql`select path from pages where path = any(${fixtures.map(([path]) => path)})`,
      ).toHaveLength(0);
      expect(
        await testSql`
          select c.id from chunks c join pages p on p.id = c.parent_id
          where c.parent_type = 'page' and p.path = any(${fixtures.map(([path]) => path)})`,
      ).toHaveLength(0);
    });
  });
});
