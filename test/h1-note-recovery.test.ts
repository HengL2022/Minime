import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  edgesAround,
  ftsCandidates,
  noteSourceChunks,
  upsertPage as repoUpsertPage,
  retierPageEdges,
  setPageContentHash,
  withActorDbSession,
  withCompiledNoteTargetLease,
  withCompiledNotesLease,
} from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { brainSync } from "../src/pipeline/brain-sync";
import {
  type CompiledNoteRecoveryV1,
  type RecoveryWriteOptions,
  compiledNoteRecoveryDir,
  listCompiledNoteRecoveryRecords,
  removeCompiledNoteRecoveryRecord,
  writeCompiledNoteRecoveryRecord,
} from "../src/pipeline/compiled-note-recovery";
import { dream } from "../src/pipeline/dream";
import { compileNotes } from "../src/pipeline/notes";
import { indexParent } from "../src/search/index-parent";
import { atomicWritePrivate } from "../src/util/atomic-file";
import {
  COMPILED_NOTE_CREATOR,
  COMPILED_NOTE_MARKER,
  COMPILED_NOTE_SOURCE,
  compiledNotePath,
  normalizeCompiledNoteBody,
  opaqueTargetHash,
  parseCompiledNoteArchive,
  parseCompiledNoteSourceIds,
  renderCompiledNoteArchive,
} from "../src/util/compiled-note-archive";
import { config } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

function recoveryFilenameFor(targetPath: string): string {
  const match = targetPath.match(/^derived\/notes\/(person|org)\/[^/]+--([0-9a-f-]+)\.md$/);
  if (!match) throw new Error("expected canonical path");
  return `${match[1]}--${match[2]}.v1.json`;
}

function recoveryGenerationFilenameFor(record: CompiledNoteRecoveryV1, generation: number): string {
  const base = `${record.entity_kind}--${record.entity_id}.v1`;
  return generation === 0
    ? `${base}.json`
    : `${base}.g${generation.toString().padStart(16, "0")}.json`;
}

function recoveryWithFacts(record: CompiledNoteRecoveryV1, facts: string): CompiledNoteRecoveryV1 {
  const body = `# ${record.title}\n\n${COMPILED_NOTE_MARKER}\n\n${facts}\n\n## Sources\n${record.source_chunk_ids.map((id) => `- ${id}`).join("\n")}`;
  const archive = renderCompiledNoteArchive({
    title: record.title,
    tier: record.tier,
    bodyMd: body,
  });
  return { ...record, body_md: body, archive_sha256: archive.contentHash };
}

type RecoveryWriterWithSeam = (
  record: CompiledNoteRecoveryV1,
  options?: RecoveryWriteOptions,
) => ReturnType<typeof writeCompiledNoteRecoveryRecord>;

const writeRecoveryWithSeam = writeCompiledNoteRecoveryRecord as unknown as RecoveryWriterWithSeam;

type TierZeroRecoveryRecord = Omit<CompiledNoteRecoveryV1, "tier"> & { tier: 0 };
type RecoveryBlockWriter = (
  record: CompiledNoteRecoveryV1 | TierZeroRecoveryRecord,
  options?: RecoveryWriteOptions,
) => Promise<
  | Awaited<ReturnType<typeof writeCompiledNoteRecoveryRecord>>
  | {
      valid: false;
      file: string;
      filenameHash: string;
      code: "tier0_recovery_record";
      record: TierZeroRecoveryRecord;
    }
>;

async function recoveryBlockWriter(): Promise<RecoveryBlockWriter> {
  const module = await import("../src/pipeline/compiled-note-recovery");
  const writer = (
    module as typeof module & {
      writeCompiledNoteRecoveryBlockRecord?: RecoveryBlockWriter;
    }
  ).writeCompiledNoteRecoveryBlockRecord;
  expect(writer).toBeFunction();
  if (!writer) throw new Error("expected recovery block writer");
  return writer;
}

async function recoveryFileSnapshot(target: string): Promise<{
  bytes: Buffer;
  inode: number;
  mode: number;
}> {
  const metadata = await stat(target);
  return {
    bytes: Buffer.from(await readFile(target)),
    inode: metadata.ino,
    mode: metadata.mode & 0o777,
  };
}

function recoveryListingEntityId(
  listing: Awaited<ReturnType<typeof listCompiledNoteRecoveryRecords>>[number],
): string | null {
  return "record" in listing ? listing.record.entity_id : null;
}

function tierZeroRecoveryRecord(record: CompiledNoteRecoveryV1): TierZeroRecoveryRecord {
  const archiveText =
    `---\ntitle: ${JSON.stringify(record.title)}\ntier: 0\n---\n` +
    `${normalizeCompiledNoteBody(record.body_md)}\n`;
  return {
    ...record,
    tier: 0,
    archive_sha256: new Bun.CryptoHasher("sha256").update(archiveText).digest("hex"),
  };
}

async function writeTierZeroRecoveryGeneration(
  record: CompiledNoteRecoveryV1,
  generation: number,
): Promise<{ file: string; record: TierZeroRecoveryRecord }> {
  const zero = tierZeroRecoveryRecord(record);
  const file = recoveryGenerationFilenameFor(record, generation);
  await mkdir(compiledNoteRecoveryDir(), { recursive: true, mode: 0o700 });
  await writeFile(join(compiledNoteRecoveryDir(), file), `${JSON.stringify(zero)}\n`, {
    mode: 0o600,
  });
  return { file, record: zero };
}

async function withPrivateDataDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "minime-h1-recovery-"));
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

async function seedCandidate(name: string, tiers: number[] = [1, 1, 1]): Promise<string> {
  const seedKey = crypto.randomUUID();
  const [person] = await sql`
    insert into people (canonical_name, created_by, source, tier)
    values (${name}, 'test:h1-recovery', 'test:h1-recovery', 1)
    returning id`;
  for (const [index, tier] of tiers.entries()) {
    const [page] = await sql`
      insert into pages (path, title, body_md, content_hash, tier, source, created_by)
      values (${`recovery/${seedKey}/${index}.md`}, ${`Recovery ${index}`}, ${`${name} fact ${index}.`},
              ${`recovery-${index}`}, ${tier}, 'test:h1-recovery', 'test:h1-recovery')
      returning id`;
    const [chunk] = await sql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${page!.id}, 0, ${`${name} fact ${index}.`}, ${tier})
      returning id`;
    await sql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
      values ('page', ${page!.id}, 'mentions', 'person', ${person!.id},
              'chunks', ${chunk!.id}, 'test:h1-recovery')`;
  }
  return person!.id;
}

async function seedEvidenceCandidate(
  name: string,
  options: {
    entityTier?: number;
    parentTiers?: number[];
    chunkTiers?: number[];
    edgeTiers?: number[];
  } = {},
): Promise<{
  personId: string;
  sourcePageIds: string[];
  sourceChunkIds: string[];
}> {
  const entityTier = options.entityTier ?? 1;
  const parentTiers = options.parentTiers ?? [1, 1, 1];
  const chunkTiers = options.chunkTiers ?? [1, 1, 1];
  const edgeTiers = options.edgeTiers ?? [1, 1, 1];
  const [person] = await sql`
    insert into people (canonical_name, created_by, source, tier)
    values (${name}, 'test:h1-evidence', 'test:h1-evidence', ${entityTier})
    returning id`;
  const sourcePageIds: string[] = [];
  const sourceChunkIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const [page] = await sql`
      insert into pages (path, title, body_md, content_hash, tier, source, created_by)
      values (${`evidence/${crypto.randomUUID()}/${index}.md`}, ${`Evidence ${index}`},
              ${`${name} independent evidence ${index}.`}, ${crypto.randomUUID()},
              ${parentTiers[index] ?? 1}, 'test:h1-evidence', 'test:h1-evidence')
      returning id`;
    const [chunk] = await sql`
      insert into chunks (parent_type, parent_id, ord, text, tier)
      values ('page', ${page!.id}, 0, ${`${name} independent evidence ${index}.`},
              ${chunkTiers[index] ?? 1})
      returning id`;
    await sql`
      insert into edges
        (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by)
      values ('page', ${page!.id}, 'mentions', 'person', ${person!.id},
              'chunks', ${chunk!.id}, ${edgeTiers[index] ?? 1}, 'test:h1-evidence')`;
    sourcePageIds.push(page!.id);
    sourceChunkIds.push(chunk!.id);
  }
  return { personId: person!.id, sourcePageIds, sourceChunkIds };
}

async function expectCandidateEvidenceExcluded(
  root: string,
  name: string,
  options: Parameters<typeof seedEvidenceCandidate>[1],
): Promise<void> {
  const { personId } = await seedEvidenceCandidate(name, options);
  const targetPath = compiledNotePath("person", name, personId);
  const writes = { model: 0, recovery: 0, page: 0, archive: 0, index: 0 };
  const result = await compileNotes({
    deps: {
      distill: async () => {
        writes.model++;
        return "must not run";
      },
      writeRecovery: async (record) => {
        writes.recovery++;
        return { valid: true, file: "unexpected.json", filenameHash: "unexpected", record };
      },
      upsertPage: async (input, upsertOptions) => {
        writes.page++;
        return repoUpsertPage(input, upsertOptions);
      },
      writeArchive: async () => {
        writes.archive++;
      },
      replaceIndex: async () => {
        writes.index++;
        return 0;
      },
    },
  });

  expect(writes).toEqual({ model: 0, recovery: 0, page: 0, archive: 0, index: 0 });
  expect(result.candidates).toBe(0);
  expect(result.results).toEqual([]);
  expect(await sql`select id from pages where path = ${targetPath}`).toHaveLength(0);
  expect(
    await stat(resolve(root, "brain", targetPath))
      .then(() => true)
      .catch(() => false),
  ).toBe(false);
  expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
  const [egress] = await sql`select count(*)::int as n from events where verb like 'egress:%'`;
  expect(egress!.n).toBe(0);
}

function recoveryFixture(name: string, entityId: string, tier: 1 | 2 = 1): CompiledNoteRecoveryV1 {
  const sourceId = crypto.randomUUID();
  const body = `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\n${name} facts.\n\n## Sources\n- ${sourceId}`;
  const archive = renderCompiledNoteArchive({ title: name, tier, bodyMd: body });
  return {
    version: 1 as const,
    entity_kind: "person" as const,
    entity_id: entityId,
    expected_page_id: null,
    target_path: compiledNotePath("person", name, entityId),
    title: name,
    tier,
    derived_from: sourceId,
    source_chunk_ids: [sourceId],
    source_freshness_at: "2099-01-01T00:00:00.000Z",
    body_md: body,
    archive_sha256: archive.contentHash,
  };
}

function legacyRecoveryFixture(
  name: string,
  entityId: string,
  targetPath: string,
  expectedPageId: string,
  sourceChunkIds: string[],
  tier: 1 | 2 = 1,
) {
  const body = `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\n${name} durable facts.\n\n## Sources\n${sourceChunkIds.map((id) => `- ${id}`).join("\n")}`;
  const archive = renderCompiledNoteArchive({ title: name, tier, bodyMd: body });
  return {
    version: 1 as const,
    entity_kind: "person" as const,
    entity_id: entityId,
    expected_page_id: expectedPageId,
    target_path: targetPath,
    title: name,
    tier,
    derived_from: sourceChunkIds[0]!,
    source_chunk_ids: sourceChunkIds,
    source_freshness_at: "2099-01-01T00:00:00.000Z",
    body_md: body,
    archive_sha256: archive.contentHash,
  } satisfies CompiledNoteRecoveryV1;
}

async function personSourceIds(personId: string): Promise<string[]> {
  const rows = await sql`
    select e.source_id as id
    from edges e
    where e.dst_type = 'person' and e.dst_id = ${personId}
      and e.rel = 'mentions' and e.source_table = 'chunks'
    order by e.created_at, e.id`;
  return rows.map((row) => row.id as string);
}

async function seedSingleMentionSource(
  name: string,
  tier: 1 | 2 = 1,
): Promise<{ personId: string; sourcePageId: string; sourceChunkId: string }> {
  const [person] = await sql`
    insert into people (canonical_name, created_by, source, tier)
    values (${name}, 'test:h1-recovery', 'test:h1-recovery', 1)
    returning id`;
  const [sourcePage] = await sql`
    insert into pages (path, title, body_md, content_hash, tier, source, created_by)
    values (${`post-floor/${crypto.randomUUID()}.md`}, ${name}, ${`${name} source fact.`},
            ${`post-floor-${crypto.randomUUID()}`}, ${tier}, 'test:h1-recovery', 'test:h1-recovery')
    returning id`;
  const [sourceChunk] = await sql`
    insert into chunks (parent_type, parent_id, ord, text, tier)
    values ('page', ${sourcePage!.id}, 0, ${`${name} source fact.`}, ${tier})
    returning id`;
  await sql`
    insert into edges
      (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by)
    values ('page', ${sourcePage!.id}, 'mentions', 'person', ${person!.id},
            'chunks', ${sourceChunk!.id}, ${tier}, 'test:h1-recovery')`;
  return {
    personId: person!.id,
    sourcePageId: sourcePage!.id,
    sourceChunkId: sourceChunk!.id,
  };
}

async function addMentionSource(
  personId: string,
  name: string,
  tier: 1 | 2 = 1,
): Promise<{ sourcePageId: string; sourceChunkId: string }> {
  const [sourcePage] = await sql`
    insert into pages (path, title, body_md, content_hash, tier, source, created_by)
    values (${`correction-3/${crypto.randomUUID()}.md`}, ${name}, ${`${name} source fact.`},
            ${`correction-3-${crypto.randomUUID()}`}, ${tier},
            'test:h1-recovery', 'test:h1-recovery')
    returning id`;
  const [sourceChunk] = await sql`
    insert into chunks (parent_type, parent_id, ord, text, tier)
    values ('page', ${sourcePage!.id}, 0, ${`${name} source fact.`}, ${tier})
    returning id`;
  await sql`
    insert into edges
      (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by)
    values ('page', ${sourcePage!.id}, 'mentions', 'person', ${personId},
            'chunks', ${sourceChunk!.id}, ${tier}, 'test:correction-3')`;
  return { sourcePageId: sourcePage!.id, sourceChunkId: sourceChunk!.id };
}

async function recoveryWithVerifiablePersonSource(
  record: CompiledNoteRecoveryV1,
  personId: string,
  name: string,
): Promise<CompiledNoteRecoveryV1> {
  const source = await addMentionSource(personId, name, record.tier);
  const body = `# ${record.title}\n\n${COMPILED_NOTE_MARKER}\n\n${name} durable facts.\n\n## Sources\n- ${source.sourceChunkId}`;
  const archive = renderCompiledNoteArchive({
    title: record.title,
    tier: record.tier,
    bodyMd: body,
  });
  return {
    ...record,
    derived_from: source.sourcePageId,
    source_chunk_ids: [source.sourceChunkId],
    source_freshness_at: "2099-01-01T00:00:00.000Z",
    body_md: body,
    archive_sha256: archive.contentHash,
  };
}

async function seedPageOnlyBlockedMirror(
  root: string,
  name: string,
  options: {
    block: "tier0" | "unverifiable";
    owner: "generated" | "human";
  },
): Promise<{
  pageId: string;
  chunkId: string;
  targetPath: string;
  archiveTarget: string;
  archiveBytes: Buffer;
}> {
  let personId: string;
  let sourcePageId: string | null = null;
  let sourceChunkId: string;
  if (options.block === "tier0" || options.owner === "human") {
    const source = await seedSingleMentionSource(name);
    personId = source.personId;
    sourcePageId = source.sourcePageId;
    sourceChunkId = source.sourceChunkId;
  } else {
    const [person] = await sql`
      insert into people (canonical_name, tier) values (${name}, 1) returning id`;
    personId = person!.id;
    sourceChunkId = crypto.randomUUID();
  }
  const targetPath = compiledNotePath("person", name, personId);
  const body =
    `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\n${name} page-only mirror.\n\n` +
    `## Sources\n- ${sourceChunkId}`;
  const archive = renderCompiledNoteArchive({ title: name, tier: 1, bodyMd: body });
  const [page] = await sql`
    insert into pages
      (path, title, body_md, content_hash, tier, status, source, created_by, derived_from)
    values (${targetPath}, ${name}, ${archive.bodyMd}, ${archive.contentHash},
            ${options.block === "tier0" ? 0 : 1}, 'active',
            ${options.owner === "generated" ? COMPILED_NOTE_SOURCE : "manual"},
            ${options.owner === "generated" ? COMPILED_NOTE_CREATOR : "human:owner"},
            ${sourcePageId})
    returning id`;
  const [chunk] = await sql`
    insert into chunks (parent_type, parent_id, ord, text, tier, embedding, embed_model)
    values ('page', ${page!.id}, 0, ${archive.bodyMd}, 1,
            array_fill(0.03, array[768])::vector, 'page-only-blocked-model')
    returning id`;
  await sql`
    insert into edges
      (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
    values
      ('page', ${page!.id}, 'page-source', 'person', ${personId},
       'pages', ${page!.id}, 1),
      ('page', ${page!.id}, 'canonical-parent', 'person', ${personId},
       null, null, 1),
      ('person', ${personId}, 'chunk-source', 'person', ${personId},
       'chunks', ${chunk!.id}, 1)`;
  const archiveTarget = resolve(root, "brain", targetPath);
  await atomicWritePrivate(archiveTarget, archive.bytes);
  return {
    pageId: page!.id,
    chunkId: chunk!.id,
    targetPath,
    archiveTarget,
    archiveBytes: await readFile(archiveTarget),
  };
}

async function holdCompiledTargetLease(
  targetPath: string,
): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => {
    release = resolveHeld;
  });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolveEntered) => {
    entered = resolveEntered;
  });
  const done = withCompiledNoteTargetLease(targetPath, async () => {
    entered();
    await held;
  });
  await enteredPromise;
  return { release, done };
}

async function observeTargetLeaseWaiter(targetPath: string, attempts = 50): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [row] = await sql`
      with lease_key as (
        select hashtextextended('minime:compiled-note:' || ${targetPath}, 0) as value
      )
      select count(*)::int as count
      from pg_locks, lease_key
      where locktype = 'advisory' and not granted and objsubid = 1
        and classid::bigint = ((value >> 32) & 4294967295::bigint)
        and objid::bigint = (value & 4294967295::bigint)`;
    if (row!.count > 0) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return false;
}

describe("H1 durable compiled-note recovery", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("compiled promotion covers legacy canonical-page edges without capturing dst-only edges", () =>
    withPrivateDataDir(async () => {
      await sql`delete from session_unlocks`;
      const actor = sessionToolCtx("agent:h1-legacy-edge");
      const [person] = await sql`
        insert into people (canonical_name, tier)
        values ('Mira Alder', 1)
        returning id`;
      const [sourcePage] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source)
        values ('h1/mira-source.md', 'Mira source', 'Mira Alder keeps a field notebook.',
                'h1-mira-source', 2, 'test:h1')
        returning id`;
      const [sourceChunk] = await sql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${sourcePage!.id}, 0, 'Mira Alder keeps a field notebook.', 2)
        returning id`;
      await sql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values
          ('page', ${sourcePage!.id}, 'mentions', 'person', ${person!.id},
           'pages', ${sourcePage!.id}, 'system:h1-test')`;

      const notePath = compiledNotePath("person", "Mira Alder", person!.id);
      const body = `# Mira Alder

${COMPILED_NOTE_MARKER}

Mira keeps a field notebook.

## Sources
- ${sourceChunk!.id}`;
      const tier1Archive = renderCompiledNoteArchive({
        title: "Mira Alder",
        tier: 1,
        bodyMd: body,
      });
      const archiveTarget = resolve(config.dataDir, "brain", notePath);
      await atomicWritePrivate(archiveTarget, tier1Archive.bytes);
      const [notePage] = await sql`
        insert into pages
          (path, title, body_md, content_hash, tier, source, created_by, derived_from)
        values
          (${notePath}, 'Mira Alder', ${body}, ${tier1Archive.contentHash}, 1,
           ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR}, ${sourcePage!.id})
        returning id`;
      const [legacyNoteChunk] = await sql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${notePage!.id}, 0, ${body}, 1)
        returning id`;
      const [legacyEdge] = await sql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values
          ('page', ${notePage!.id}, 'mentions', 'person', ${person!.id},
           'chunks', ${legacyNoteChunk!.id}, 'system:h1-legacy')
        returning id`;
      const [canonicalEdge] = await sql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values
          ('page', ${notePage!.id}, 'h1_page_provenance', 'person', ${person!.id},
           'pages', ${notePage!.id}, 'system:h1-canonical')
        returning id`;
      const [decoyPerson] = await sql`
        insert into people (canonical_name, tier)
        values ('Dst Only Decoy', 1)
        returning id`;
      const [dstOnlyEdge] = await sql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values
          ('person', ${decoyPerson!.id}, 'h1_dst_only_decoy', 'page', ${notePage!.id},
           'people', ${decoyPerson!.id}, 'system:h1-decoy')
        returning id`;
      // Ensure source freshness does not request a model call; this item is representation-only.
      await sql`update pages set updated_at = now() + interval '1 minute'
                where id = ${notePage!.id}`;

      let firstEdgeRows = 0;
      const first = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("unexpected model call in legacy-edge promotion fixture");
          },
          retierEdges: async (pageId, tier) => {
            const changed = await retierPageEdges(pageId, tier);
            firstEdgeRows += changed;
            return changed;
          },
        },
      });
      expect(first.repaired).toBe(1);
      expect(firstEdgeRows).toBe(2);
      const [pageAfter] = await sql`select tier from pages where id = ${notePage!.id}`;
      const chunksAfter = await sql`
        select id, tier from chunks
        where parent_type = 'page' and parent_id = ${notePage!.id}
        order by id`;
      const matchingEdges = await sql`
        select id, tier, source_table, source_id, src_type, src_id from edges
        where (
          (source_table = 'pages' and source_id = ${notePage!.id})
          or (src_type = 'page' and src_id = ${notePage!.id})
        )
        order by id`;
      const [dstOnlyAfter] = await sql`
        select tier from edges where id = ${dstOnlyEdge!.id}`;
      const archiveAfter = parseCompiledNoteArchive(await readFile(archiveTarget, "utf8"));
      expect(pageAfter!.tier).toBe(2);
      expect(chunksAfter.length).toBeGreaterThan(0);
      expect(chunksAfter.every((row) => row.tier === 2)).toBe(true);
      expect(matchingEdges.map((row) => row.id).sort()).toEqual(
        [legacyEdge!.id, canonicalEdge!.id].sort(),
      );
      expect(matchingEdges.every((row) => row.tier === 2)).toBe(true);
      expect(archiveAfter?.tier).toBe(2);
      expect(dstOnlyAfter!.tier).toBe(1);

      const rowVersions = () => sql`
        select 'page' as kind, id, xmin::text as version from pages
        where id = ${notePage!.id}
        union all
        select 'chunk' as kind, id, xmin::text as version from chunks
        where parent_type = 'page' and parent_id = ${notePage!.id}
        union all
        select 'edge' as kind, id, xmin::text as version from edges
        where (
          (source_table = 'pages' and source_id = ${notePage!.id})
          or (src_type = 'page' and src_id = ${notePage!.id})
        )
        order by kind, id`;
      const versionsBefore = await rowVersions();
      const embeddingsBefore = await sql`
        select id, embedding::text as embedding, embed_model
        from chunks where parent_type = 'page' and parent_id = ${notePage!.id}
        order by id`;
      const edgeIdsBefore = await sql`
        select id from edges
        where ((source_table = 'pages' and source_id = ${notePage!.id})
           or (src_type = 'page' and src_id = ${notePage!.id}))
        order by id`;
      const writes = {
        recovery: 0,
        page: 0,
        hash: 0,
        archive: 0,
        edgeRows: 0,
        index: 0,
        model: 0,
      };
      const second = await compileNotes({
        deps: {
          distill: async () => {
            writes.model++;
            throw new Error("unexpected second model call");
          },
          writeRecovery: async (record: CompiledNoteRecoveryV1) => {
            writes.recovery++;
            return { valid: true as const, file: "noop.v1.json", filenameHash: "noop", record };
          },
          upsertPage: async (input, options) => {
            writes.page++;
            return repoUpsertPage(input, options);
          },
          updateHash: async (pageId, hash) => {
            writes.hash++;
            await setPageContentHash(pageId, hash);
          },
          writeArchive: async (target, bytes) => {
            writes.archive++;
            await atomicWritePrivate(target, bytes);
          },
          retierEdges: async (pageId, tier) => {
            const changed = await retierPageEdges(pageId, tier);
            writes.edgeRows += changed;
            return changed;
          },
          replaceIndex: async (pageId, bodyMd, title, tier) => {
            writes.index++;
            return indexParent("page", pageId, bodyMd, title, tier, {
              extractEdges: false,
              tierMode: "promote-page-floor",
            });
          },
        },
      });
      expect(second.repaired).toBe(0);
      expect(second.unchanged).toBe(1);
      expect(writes).toEqual({
        recovery: 0,
        page: 0,
        hash: 0,
        archive: 0,
        edgeRows: 0,
        index: 0,
        model: 0,
      });
      expect(await rowVersions()).toEqual(versionsBefore);
      const embeddingsAfter = await sql`
        select id, embedding::text as embedding, embed_model
        from chunks where parent_type = 'page' and parent_id = ${notePage!.id}
        order by id`;
      expect(
        embeddingsAfter.map((row) => ({
          id: row.id,
          embedding: row.embedding,
          embed_model: row.embed_model,
        })),
      ).toEqual(
        embeddingsBefore.map((row) => ({
          id: row.id,
          embedding: row.embedding,
          embed_model: row.embed_model,
        })),
      );
      const edgeIdsAfter = await sql`
        select id from edges
        where ((source_table = 'pages' and source_id = ${notePage!.id})
           or (src_type = 'page' and src_id = ${notePage!.id}))
        order by id`;
      expect(edgeIdsAfter.map((row) => row.id)).toEqual(edgeIdsBefore.map((row) => row.id));
      const [dstOnlySecond] = await sql`
        select tier from edges where id = ${dstOnlyEdge!.id}`;
      expect(dstOnlySecond!.tier).toBe(1);

      const locked = await invokeTool(
        toolByName("minime_get_context"),
        { type: "person", id: person!.id },
        actor,
      );
      const lockedText = JSON.stringify(locked);
      expect(locked.ok).toBe(true);
      expect(lockedText).not.toContain(notePage!.id);
      expect(lockedText).not.toContain('"rel":"mentions"');
      expect(lockedText).not.toContain(legacyEdge!.id);
      const readEdges = () =>
        withActorDbSession(
          actor.actor,
          () => edgesAround("person", person!.id, 20, actor.actor),
          actor.sessionId,
        );
      expect(
        (await readEdges()).some(
          (edge) => edge.id === legacyEdge!.id || edge.id === canonicalEdge!.id,
        ),
      ).toBe(false);

      await requestAndApproveTier2(actor);
      const unlocked = await invokeTool(
        toolByName("minime_get_context"),
        { type: "person", id: person!.id },
        actor,
      );
      const unlockedText = JSON.stringify(unlocked);
      expect(unlocked.ok).toBe(true);
      expect(unlockedText).toContain(notePage!.id);
      expect(unlockedText).toContain('"rel":"mentions"');
      expect((await readEdges()).some((edge) => edge.id === legacyEdge!.id)).toBe(true);
    }));

  test("mixed source tiers produce a tier-two canonical archive with one identity opportunity", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Mixed Tier Person", [1, 2, 1]);
      const sourceIds = await personSourceIds(personId);
      const body = `# Mixed Tier Person\n\n${COMPILED_NOTE_MARKER}\n\nMixed facts.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Mixed Tier Person",
        tier: 2,
        bodyMd: body,
      });
      const record = {
        ...recoveryFixture("Mixed Tier Person", personId, 2),
        body_md: body,
        source_chunk_ids: sourceIds,
        derived_from: sourceIds[0]!,
        archive_sha256: archive.contentHash,
      };
      await writeCompiledNoteRecoveryRecord(record);
      let modelCalls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            throw new Error("recovery should win over candidate");
          },
        },
      });
      expect(result.candidates).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.created + result.updated + result.repaired).toBe(1);
      expect(modelCalls).toBe(0);
      const [page] =
        await sql`select id, path, tier, content_hash, body_md from pages where source = ${COMPILED_NOTE_SOURCE}`;
      expect(page!.path).toBe(compiledNotePath("person", "Mixed Tier Person", personId));
      expect(page!.tier).toBe(2);
      expect(page!.content_hash).toBe(archive.contentHash);
      expect(page!.body_md).toBe(body);
      const archiveBytes = await readFile(resolve(config.dataDir, "brain", page!.path), "utf8");
      expect(parseCompiledNoteArchive(archiveBytes)?.contentHash).toBe(page!.content_hash);
      expect(parseCompiledNoteArchive(archiveBytes)?.bodyMd).toBe(page!.body_md);
      const chunksForBody = await sql`
        select text from chunks where parent_type = 'page' and parent_id = ${page!.id} order by ord`;
      const chunkText = chunksForBody.map((chunk) => chunk.text).join("\n");
      expect(chunkText).toContain(COMPILED_NOTE_MARKER);
      for (const sourceId of sourceIds) expect(chunkText).toContain(sourceId);
      const sync = await brainSync();
      expect(sync.changed + sync.unchanged).toBeGreaterThanOrEqual(1);
      const [afterSync] =
        await sql`select id, tier, source, created_by, body_md, content_hash from pages where source = ${COMPILED_NOTE_SOURCE}`;
      expect(afterSync!.id).toBe(page!.id);
      expect(afterSync!.tier).toBe(2);
      expect(afterSync!.source).toBe(COMPILED_NOTE_SOURCE);
      expect(afterSync!.created_by).toBe(COMPILED_NOTE_CREATOR);
      expect(afterSync!.body_md).toBe(body);
      expect(afterSync!.content_hash).toBe(archive.contentHash);
    });
  });

  test("equal readable slugs stay distinct by canonical UUID path and provenance", async () => {
    await withPrivateDataDir(async () => {
      const firstId = await seedCandidate("Alex Lee");
      const secondId = await seedCandidate("Alex-Lee");
      let calls = 0;
      const result = await compileNotes({
        deps: {
          distill: async (name) => {
            calls++;
            return `${name}: durable fact.`;
          },
        },
      });
      expect(result.created).toBe(2);
      expect(calls).toBe(2);
      const rows = await sql`
        select path, derived_from, tier
        from pages where source = 'dream:notes' order by path`;
      expect(rows.map((row) => row.path)).toEqual(
        [
          compiledNotePath("person", "Alex Lee", firstId),
          compiledNotePath("person", "Alex-Lee", secondId),
        ].sort(),
      );
      expect(new Set(rows.map((row) => row.derived_from)).size).toBe(2);
    });
  });

  test("duplicate alias edges for one owner deduplicate source chunks without false ambiguity", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Alias Owner");
      const sourceIds = await personSourceIds(personId);
      for (const sourceId of sourceIds) {
        const [edge] = await sql`
          select src_id, dst_id from edges
          where source_table = 'chunks' and source_id = ${sourceId}
          limit 1`;
        await sql`
          insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
          values ('page', ${edge!.src_id}, 'mentions', 'person', ${edge!.dst_id}, 'chunks', ${sourceId}, 'test:alias-duplicate')`;
      }
      let calls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Alias Owner: one durable fact.";
          },
        },
      });
      expect(result.created).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(calls).toBe(1);
      const [pages] =
        await sql`select count(*)::int as n from pages where source = ${COMPILED_NOTE_SOURCE}`;
      expect(pages!.n).toBe(1);
      const [chunks] =
        await sql`select count(*)::int as n from chunks where parent_type = 'page' and parent_id = (select id from pages where source = ${COMPILED_NOTE_SOURCE})`;
      expect(chunks!.n).toBeGreaterThan(0);
    });
  });

  test("active page plus valid recovery and candidate deduplicate to one work item", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Dedupe Person");
      const sourceIds = await personSourceIds(personId);
      const body = `# Dedupe Person\n\n${COMPILED_NOTE_MARKER}\n\nExisting durable fact.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({ title: "Dedupe Person", tier: 1, bodyMd: body });
      const [existingPage] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${compiledNotePath("person", "Dedupe Person", personId)}, 'Dedupe Person', ${body}, ${archive.contentHash},
                1, ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR})
        returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture("Dedupe Person", personId, 1),
        body_md: body,
        source_chunk_ids: sourceIds,
        derived_from: sourceIds[0]!,
        archive_sha256: archive.contentHash,
        expected_page_id: existingPage!.id,
      });
      let modelCalls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            throw new Error("dedupe should not distill");
          },
        },
      });
      expect(result.results).toHaveLength(1);
      expect(result.failed).toBe(0);
      expect(result.repaired + result.created + result.updated).toBe(1);
      expect(modelCalls).toBe(0);
      const pages = await sql`select count(*)::int as n from pages where source = 'dream:notes'`;
      expect(pages[0]!.n).toBe(1);
    });
  });

  test("uniquely-owned slug-only legacy page is retained without a UUID rename", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Legacy Owner");
      const sourceIds = await personSourceIds(personId);
      const body = `# Legacy Owner\n\n${COMPILED_NOTE_MARKER}\n\nLegacy durable fact.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const [legacy] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('derived/notes/person/legacy-owner.md', 'Legacy Owner', ${body}, 'wrong-hash', 1,
                'brain-sync', 'test')
        returning id`;
      let modelCalls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            throw new Error("legacy representation should not distill");
          },
        },
      });
      expect(result.failed).toBe(0);
      expect(result.repaired).toBe(1);
      expect(modelCalls).toBe(0);
      const [same] = await sql`select id, path from pages where id = ${legacy!.id}`;
      expect(same).toEqual({ id: legacy!.id, path: "derived/notes/person/legacy-owner.md" });
      const canonical = await sql`
        select count(*)::int as n from pages
        where path = ${compiledNotePath("person", "Legacy Owner", personId)}`;
      expect(canonical[0]!.n).toBe(0);
    });
  });

  test("ambiguous multiple-owner legacy Sources page is retained at tier two and cannot claim either candidate", async () => {
    await withPrivateDataDir(async () => {
      const firstId = await seedCandidate("Ambiguous Owner A", [1, 1, 1]);
      const secondId = await seedCandidate("Ambiguous Owner B", [1, 1, 1]);
      const firstSources = await personSourceIds(firstId);
      const secondSources = await personSourceIds(secondId);
      const listed = [...firstSources.slice(0, 2), ...secondSources.slice(0, 2)];
      const body = `# Ambiguous Owner\n\n${COMPILED_NOTE_MARKER}\n\nAmbiguous durable fact.\n\n## Sources\n${listed.map((id) => `- ${id}`).join("\n")}`;
      const [legacy] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('derived/notes/person/ambiguous-owner.md', 'Ambiguous Owner', ${body}, 'ambiguous-hash', 1,
                'brain-sync', 'test')
        returning id`;
      let modelCalls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            return "Ambiguous owner candidate fact.";
          },
        },
      });
      expect(result.results.some((item) => item.code === "legacy_path_ambiguous")).toBe(true);
      expect(modelCalls).toBe(2);
      const [after] = await sql`select id, tier from pages where id = ${legacy!.id}`;
      expect(after!.id).toBe(legacy!.id);
      expect(after!.tier).toBe(2);
      const canonicalCount = await sql`
        select count(*)::int as n from pages
        where path in (
          ${compiledNotePath("person", "Ambiguous Owner A", firstId)},
          ${compiledNotePath("person", "Ambiguous Owner B", secondId)}
        )`;
      expect(canonicalCount[0]!.n).toBe(2);
    });
  });

  test("marker plus Sources outside derived/notes is reconciled as the existing page", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Outside Marker");
      const sourceIds = await personSourceIds(personId);
      const body = `# Outside Marker\n\n${COMPILED_NOTE_MARKER}\n\nOutside marker fact.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('notes/imported-outside.md', 'Outside Marker', ${body}, 'outside-hash', 1,
                'brain-sync', 'test')
        returning id`;
      let modelCalls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            throw new Error("outside marker should not distill");
          },
        },
      });
      expect(result.failed).toBe(0);
      expect(result.repaired).toBe(1);
      expect(modelCalls).toBe(0);
      const [after] = await sql`select id, path, body_md, tier from pages where id = ${page!.id}`;
      expect(after!.id).toBe(page!.id);
      expect(after!.path).toBe("notes/imported-outside.md");
      expect(after!.body_md).toBe(body);
      expect(after!.tier).toBe(1);
    });
  });

  test("canonical UUID archive imported before page/recovery is repaired in place", async () => {
    await withPrivateDataDir(async (root) => {
      const personId = crypto.randomUUID();
      await sql`insert into people (id, canonical_name, tier) values (${personId}, 'Imported Canonical', 1)`;
      const [sourceJournal] = await sql`
        insert into journal_entries (entry_md, tier)
        values ('Imported Canonical source fact.', 1)
        returning id`;
      const [sourceChunk] = await sql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('journal', ${sourceJournal!.id}, 0, 'Imported Canonical source fact.', 1)
        returning id`;
      const sourceId = sourceChunk!.id as string;
      await sql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by)
        values ('journal', ${sourceJournal!.id}, 'mentions', 'person', ${personId},
                'chunks', ${sourceId}, 1, 'test:imported-canonical')`;
      const body = `# Imported Canonical\n\n${COMPILED_NOTE_MARKER}\n\nImported durable fact.\n\n## Sources\n- ${sourceId}`;
      const archive = renderCompiledNoteArchive({
        title: "Imported Canonical",
        tier: 1,
        bodyMd: body,
      });
      const path = compiledNotePath("person", "Imported Canonical", personId);
      await mkdir(join(root, "brain", "derived", "notes", "person"), {
        recursive: true,
        mode: 0o700,
      });
      await atomicWritePrivate(resolve(root, "brain", path), archive.bytes);
      const sync = await brainSync();
      expect(sync.changed).toBe(1);
      const [before] =
        await sql`select id, path, body_md, content_hash from pages where path = ${path}`;
      let modelCalls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            throw new Error("imported canonical must not distill");
          },
        },
      });
      expect(result.failed).toBe(0);
      expect(modelCalls).toBe(0);
      const [after] =
        await sql`select id, path, body_md, content_hash from pages where path = ${path}`;
      expect(after?.id).toBe(before?.id);
      expect(after?.path).toBe(before?.path);
      expect(after?.body_md).toBe(before?.body_md);
      expect(after?.content_hash).toBe(
        renderCompiledNoteArchive({ title: "Imported Canonical", tier: 1, bodyMd: body })
          .contentHash,
      );
    });
  });

  test("missing archive and below-threshold sources repair existing rows without model work", async () => {
    await withPrivateDataDir(async (root) => {
      const personId = await seedCandidate("Archive Removed");
      let modelCalls = 0;
      const first = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            return "Archive Removed: durable fact.";
          },
        },
      });
      expect(first.created).toBe(1);
      const [page] = await sql`select id, path from pages where source = ${COMPILED_NOTE_SOURCE}`;
      const archiveTarget = resolve(root, "brain", page!.path);
      await rm(archiveTarget);
      await sql`
        delete from edges
        where id in (
          select id from edges
          where dst_type = 'person' and dst_id = ${personId} and rel = 'mentions'
          order by id
          limit 2
        )`;
      const second = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            throw new Error("below-threshold repair must not distill");
          },
        },
      });
      expect(second.repaired).toBe(1);
      expect(second.failed).toBe(0);
      expect(modelCalls).toBe(1);
      expect(await readFile(archiveTarget, "utf8")).toContain(COMPILED_NOTE_MARKER);
      const chunks =
        await sql`select count(*)::int as n from chunks where parent_type = 'page' and parent_id = ${page!.id}`;
      expect(chunks[0]!.n).toBeGreaterThan(0);
    });
  });

  test("deleted page plus expected-page recovery restores the same UUID", async () => {
    await withPrivateDataDir(async () => {
      const personId = crypto.randomUUID();
      await sql`insert into people (id, canonical_name, tier) values (${personId}, 'Deleted Recovery', 1)`;
      const record = await recoveryWithVerifiablePersonSource(
        recoveryFixture("Deleted Recovery", personId, 2),
        personId,
        "Deleted Recovery",
      );
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by, status)
        values (${record.target_path}, ${record.title}, ${record.body_md}, ${record.archive_sha256}, 1,
                ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR}, 'active')
        returning id`;
      await sql`update pages set status = 'deleted' where id = ${page!.id}`;
      // A compiler-owned canonical page is authoritative even when the crash happened
      // before the page UUID was persisted into the recovery record.
      await writeCompiledNoteRecoveryRecord({ ...record, expected_page_id: null });
      let modelCalls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            throw new Error("deleted recovery must not distill");
          },
        },
      });
      expect(result.failed).toBe(0);
      expect(result.repaired).toBe(1);
      expect(modelCalls).toBe(0);
      const [restored] = await sql`select id, status, tier from pages where id = ${page!.id}`;
      expect(restored).toEqual({ id: page!.id, status: "active", tier: 2 });
    });
  });

  test("canonical compiler-owned page with matching expected identity accepts recovery", async () => {
    await withPrivateDataDir(async () => {
      const personId = crypto.randomUUID();
      await sql`insert into people (id, canonical_name, tier) values (${personId}, 'Matching Recovery', 1)`;
      const record = await recoveryWithVerifiablePersonSource(
        recoveryFixture("Matching Recovery", personId, 1),
        personId,
        "Matching Recovery",
      );
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${record.target_path}, ${record.title}, ${record.body_md}, ${record.archive_sha256}, 1,
                ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR})
        returning id`;
      // A compiler-owned canonical page is authoritative even when the crash happened
      // before the page UUID was persisted into the recovery record.
      await writeCompiledNoteRecoveryRecord({ ...record, expected_page_id: null });
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("matching recovery must not distill");
          },
        },
      });
      expect(result.failed).toBe(0);
      expect(result.repaired).toBe(1);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
      const [same] = await sql`select id, source, created_by from pages where id = ${page!.id}`;
      expect(same).toEqual({
        id: page!.id,
        source: COMPILED_NOTE_SOURCE,
        created_by: COMPILED_NOTE_CREATOR,
      });
    });
  });

  test("legacy recovery with matching expected page and unique ownership is accepted", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Legacy Recovery Owner");
      const sourceIds = await personSourceIds(personId);
      const targetPath = "derived/notes/person/legacy-recovery-owner.md";
      const body = `# Legacy Recovery Owner\n\n${COMPILED_NOTE_MARKER}\n\nLegacy recovery fact.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Legacy Recovery Owner",
        tier: 1,
        bodyMd: body,
      });
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${targetPath}, 'Legacy Recovery Owner', ${body}, ${archive.contentHash}, 1, 'brain-sync', 'test')
        returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture("Legacy Recovery Owner", personId, 1),
        target_path: targetPath,
        body_md: body,
        source_chunk_ids: sourceIds,
        derived_from: sourceIds[0]!,
        expected_page_id: page!.id,
        archive_sha256: archive.contentHash,
      });
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("accepted legacy recovery must not distill");
          },
        },
      });
      expect(result.failed).toBe(0);
      expect(result.repaired).toBe(1);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
      const [same] = await sql`select id, path from pages where id = ${page!.id}`;
      expect(same).toEqual({ id: page!.id, path: targetPath });
    });
  });

  test("legacy recovery with mismatched expected page remains retained as identity_conflict", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Legacy Recovery Collision");
      const sourceIds = await personSourceIds(personId);
      const targetPath = "derived/notes/person/legacy-recovery-collision.md";
      const body = `# Legacy Recovery Collision\n\n${COMPILED_NOTE_MARKER}\n\nHuman-owned legacy body.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Legacy Recovery Collision",
        tier: 1,
        bodyMd: body,
      });
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${targetPath}, 'Legacy Recovery Collision', ${body}, ${archive.contentHash}, 1, 'brain-sync', 'human')
        returning id`;
      const wrongExpected = crypto.randomUUID();
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture("Legacy Recovery Collision", personId, 1),
        target_path: targetPath,
        body_md: body,
        source_chunk_ids: sourceIds,
        derived_from: sourceIds[0]!,
        expected_page_id: wrongExpected,
        archive_sha256: archive.contentHash,
      });
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("legacy collision must not distill");
          },
        },
      });
      expect(result.results.some((item) => item.code === "identity_conflict")).toBe(true);
      const [after] =
        await sql`select id, body_md, created_by, tier from pages where id = ${page!.id}`;
      expect(after).toEqual({ id: page!.id, body_md: body, created_by: "human", tier: 1 });
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
    });
  });

  test("legacy recovery aimed at another path is retained as identity_conflict", async () => {
    await withPrivateDataDir(async (root) => {
      const personId = crypto.randomUUID();
      await sql`insert into people (id, canonical_name, tier) values (${personId}, 'Other Path', 1)`;
      const sourceId = (await addMentionSource(personId, "Other Path", 1)).sourceChunkId;
      const targetPath = "derived/notes/person/other-path-target.md";
      const actualPath = "derived/notes/person/other-path-actual.md";
      const body = `# Other Path\n\n${COMPILED_NOTE_MARKER}\n\nOther path fact.\n\n## Sources\n- ${sourceId}`;
      const archive = renderCompiledNoteArchive({ title: "Other Path", tier: 1, bodyMd: body });
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${actualPath}, 'Other Path', ${body}, ${archive.contentHash}, 1, ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR})
        returning id`;
      const [before] = await sql`
        select path, title, body_md, content_hash, tier, source, created_by, derived_from, status
        from pages where id = ${page!.id}`;
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture("Other Path", personId, 1),
        target_path: targetPath,
        body_md: body,
        source_chunk_ids: [sourceId],
        derived_from: sourceId,
        expected_page_id: page!.id,
        archive_sha256: archive.contentHash,
      });
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("other path must not distill");
          },
        },
      });
      expect(result.results.some((item) => item.code === "identity_conflict")).toBe(true);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        1,
      );
      const [after] = await sql`
        select path, title, body_md, content_hash, tier, source, created_by, derived_from, status
        from pages where id = ${page!.id}`;
      const [chunks] = await sql`
        select count(*)::int as count from chunks
        where parent_type = 'page' and parent_id = ${page!.id}`;
      const archiveExists = async (path: string): Promise<boolean> => {
        try {
          await stat(resolve(root, "brain", path));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      };
      expect({
        page: after,
        chunks: chunks!.count,
        actual_archive_exists: await archiveExists(actualPath),
        target_archive_exists: await archiveExists(targetPath),
      }).toEqual({
        page: before,
        chunks: 0,
        actual_archive_exists: false,
        target_archive_exists: false,
      });
    });
  });

  test("legacy recovery occupying a human page is retained without target mutation", async () => {
    await withPrivateDataDir(async () => {
      const personId = crypto.randomUUID();
      await sql`insert into people (id, canonical_name, tier) values (${personId}, 'Human Legacy', 1)`;
      const sourceId = (await addMentionSource(personId, "Human Legacy", 1)).sourceChunkId;
      const targetPath = "derived/notes/person/human-legacy.md";
      const body = `# Human Legacy\n\n${COMPILED_NOTE_MARKER}\n\nHuman legacy fact.\n\n## Sources\n- ${sourceId}`;
      const archive = renderCompiledNoteArchive({ title: "Human Legacy", tier: 1, bodyMd: body });
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${targetPath}, 'Human Legacy', '# human-owned', 'human-legacy-hash', 1, 'brain-sync', 'human')
        returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture("Human Legacy", personId, 1),
        target_path: targetPath,
        body_md: body,
        source_chunk_ids: [sourceId],
        derived_from: sourceId,
        expected_page_id: page!.id,
        archive_sha256: archive.contentHash,
      });
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("human page must not distill");
          },
        },
      });
      expect(result.results.some((item) => item.code === "identity_conflict")).toBe(true);
      const [after] =
        await sql`select body_md, content_hash, source, created_by, tier from pages where id = ${page!.id}`;
      expect(after).toEqual({
        body_md: "# human-owned",
        content_hash: "human-legacy-hash",
        source: "brain-sync",
        created_by: "human",
        tier: 1,
      });
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        1,
      );
    });
  });

  test("legacy recovery with multiple source owners is removed as unverifiable and its generated mirror quarantined", async () => {
    await withPrivateDataDir(async () => {
      const firstId = crypto.randomUUID();
      const secondId = crypto.randomUUID();
      await sql`insert into people (id, canonical_name, tier) values (${firstId}, 'Legacy Owner One', 1), (${secondId}, 'Legacy Owner Two', 1)`;
      const sourceIds: string[] = [];
      for (const [index, owner] of [firstId, secondId].entries()) {
        const [source] = await sql`
          insert into pages (path, title, body_md, content_hash, tier, source)
          values (${`legacy-owner-${index}.md`}, 'Legacy owner source', '# source', ${`legacy-owner-${index}`}, 1, 'test')
          returning id`;
        const sourceId = crypto.randomUUID();
        sourceIds.push(sourceId);
        const [chunk] = await sql`
          insert into chunks (id, parent_type, parent_id, ord, text, tier)
          values (${sourceId}, 'page', ${source!.id}, 0, 'Legacy owner source fact', 1)
          returning id`;
        await sql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id)
          values ('page', ${source!.id}, 'mentions', 'person', ${owner}, 'chunks', ${chunk!.id})`;
      }
      const personId = firstId;
      const targetPath = "derived/notes/person/ambiguous-recovery.md";
      const body = `# Ambiguous Recovery\n\n${COMPILED_NOTE_MARKER}\n\nAmbiguous recovery fact.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Ambiguous Recovery",
        tier: 1,
        bodyMd: body,
      });
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${targetPath}, 'Ambiguous Recovery', ${body}, ${archive.contentHash}, 1, 'brain-sync', 'test')
        returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture("Ambiguous Recovery", personId, 1),
        target_path: targetPath,
        body_md: body,
        source_chunk_ids: sourceIds,
        derived_from: sourceIds[0]!,
        expected_page_id: page!.id,
        archive_sha256: archive.contentHash,
      });
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("ambiguous recovery must not distill");
          },
        },
      });
      expect(result.results.some((item) => item.code === "source_evidence_unverifiable")).toBe(
        true,
      );
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
      const [after] = await sql`select body_md, tier, status from pages where id = ${page!.id}`;
      expect(after!.body_md).toBe(body);
      expect(after).toMatchObject({ tier: 0, status: "deleted" });
    });
  });

  test("canonical marker/Sources ownership contradiction is removed as unverifiable without changing a human page", async () => {
    await withPrivateDataDir(async () => {
      const ownerId = await seedCandidate("Contradictory Owner");
      const otherId = crypto.randomUUID();
      await sql`insert into people (id, canonical_name, tier) values (${otherId}, 'Other Owner', 1)`;
      const ownerSourceIds = await personSourceIds(ownerId);
      const otherSourceId = crypto.randomUUID();
      const [source] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source)
        values ('other-owner-source.md', 'Other source', '# Other', 'other-hash', 1, 'test')
        returning id`;
      await sql`
        insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${otherSourceId}, 'page', ${source!.id}, 0, 'Other owner fact', 1)`;
      await sql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id)
        values ('page', ${source!.id}, 'mentions', 'person', ${otherId}, 'chunks', ${otherSourceId})`;
      const record = recoveryFixture("Contradictory Owner", ownerId, 1);
      const body = `# Contradictory Owner\n\n${COMPILED_NOTE_MARKER}\n\nHuman body.\n\n## Sources\n- ${otherSourceId}`;
      const archive = renderCompiledNoteArchive({ title: record.title, tier: 1, bodyMd: body });
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${record.target_path}, ${record.title}, ${body}, ${archive.contentHash}, 1,
                'manual', 'human')
        returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...record,
        body_md: body,
        source_chunk_ids: [otherSourceId],
        derived_from: otherSourceId,
        archive_sha256: archive.contentHash,
        expected_page_id: page!.id,
      });
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("contradictory ownership must not distill");
          },
        },
      });
      expect(result.results.some((item) => item.code === "source_evidence_unverifiable")).toBe(
        true,
      );
      const [after] =
        await sql`select body_md, source, created_by, tier from pages where id = ${page!.id}`;
      expect(after).toEqual({ body_md: body, source: "manual", created_by: "human", tier: 1 });
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
      expect(ownerSourceIds.length).toBe(3);
    });
  });

  test("unsafe marker-recognized database path is retained at tier two without outside access", async () => {
    await withPrivateDataDir(async () => {
      const personId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      await sql`insert into people (id, canonical_name, tier) values (${personId}, 'Unsafe DB Path', 1)`;
      const [source] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source)
        values ('unsafe-source.md', 'Unsafe source', '# unsafe', 'unsafe-source-hash', 1, 'test')
        returning id`;
      await sql`insert into chunks (id, parent_type, parent_id, ord, text, tier)
        values (${sourceId}, 'page', ${source!.id}, 0, 'Unsafe DB fact', 1)`;
      await sql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id)
        values ('page', ${source!.id}, 'mentions', 'person', ${personId}, 'chunks', ${sourceId})`;
      const body = `# Unsafe DB Path\n\n${COMPILED_NOTE_MARKER}\n\nUnsafe body.\n\n## Sources\n- ${sourceId}`;
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values ('../outside-compiled.md', 'Unsafe DB Path', ${body}, 'unsafe-hash', 1, 'brain-sync', 'test')
        returning id`;
      const [pageChunk] = await sql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${page!.id}, 0, ${body}, 1)
        returning id`;
      await sql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values ('page', ${page!.id}, 'mentions', 'person', ${personId}, 'pages', ${page!.id}, 1),
               ('page', ${page!.id}, 'mentions', 'person', ${personId}, 'chunks', ${pageChunk!.id}, 1)`;
      const outsideTarget = resolve(config.dataDir, "outside-compiled.md");
      let modelCalls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            throw new Error("unsafe archive must not distill");
          },
        },
      });
      expect(result.results.some((item) => item.code === "unsafe_archive_path")).toBe(true);
      expect(modelCalls).toBe(0);
      const [after] = await sql`select id, tier, body_md from pages where id = ${page!.id}`;
      expect(after!.id).toBe(page!.id);
      expect(after!.tier).toBe(2);
      expect(after!.body_md).toBe(body);
      const pageChunks =
        await sql`select tier from chunks where parent_type = 'page' and parent_id = ${page!.id}`;
      expect(pageChunks.every((row) => row.tier === 2)).toBe(true);
      const pageEdges = await sql`
        select tier from edges
        where ((source_table = 'pages' and source_id = ${page!.id})
           or (src_type = 'page' and src_id = ${page!.id}))`;
      expect(pageEdges).toHaveLength(2);
      expect(pageEdges.every((row) => row.tier === 2)).toBe(true);
      expect(await readFile(outsideTarget, "utf8").catch(() => null)).toBeNull();
    });
  });

  test("recovery validator rejects malformed and noncanonical records without leaking body data", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const body = `# Validator\n\n${COMPILED_NOTE_MARKER}\n\nFacts.\n\n## Sources\n- ${sourceId}`;
      const archive = renderCompiledNoteArchive({ title: "Validator", tier: 2, bodyMd: body });
      const valid: CompiledNoteRecoveryV1 = {
        version: 1 as const,
        entity_kind: "person" as const,
        entity_id: entityId,
        expected_page_id: null,
        target_path: compiledNotePath("person", "Validator", entityId),
        title: "Validator",
        tier: 2 as const,
        derived_from: sourceId,
        source_chunk_ids: [sourceId],
        source_freshness_at: "2026-07-24T00:00:00.000Z",
        body_md: body,
        archive_sha256: archive.contentHash,
      };
      const cases: Array<[string, unknown]> = [
        ["malformed JSON", "{"],
        ["unknown version", { ...valid, version: 9 }],
        [
          "missing field",
          (() => {
            const { title: _title, ...rest } = valid;
            return rest;
          })(),
        ],
        ["extra field", { ...valid, secret: "tier-2 sentinel" }],
        ["noncanonical entity UUID", { ...valid, entity_id: entityId.toUpperCase() }],
        ["noncanonical source UUID", { ...valid, source_chunk_ids: [sourceId.toUpperCase()] }],
        ["duplicate source UUID", { ...valid, source_chunk_ids: [sourceId, sourceId] }],
        ["invalid derived UUID", { ...valid, derived_from: "not-a-uuid" }],
        ["invalid date", { ...valid, source_freshness_at: "not-a-date" }],
        [
          "noncanonical offset date",
          { ...valid, source_freshness_at: "2026-07-24T08:00:00+08:00" },
        ],
        ["wrong archive hash", { ...valid, archive_sha256: "f".repeat(64) }],
        ["body with CRLF", { ...valid, body_md: body.replaceAll("\n", "\r\n") }],
        ["body with terminal newline", { ...valid, body_md: `${body}\n` }],
        [
          "filename kind/entity mismatch",
          { ...valid, target_path: compiledNotePath("org", "Validator", entityId) },
        ],
        [
          "target UUID identity mismatch",
          { ...valid, target_path: compiledNotePath("person", "Validator", crypto.randomUUID()) },
        ],
        [
          "non-UUID target with null expected page",
          { ...valid, target_path: "derived/notes/person/validator.md" },
        ],
        ["absolute path", { ...valid, target_path: "/tmp/outside.md" }],
        ["lexical traversal", { ...valid, target_path: "../outside.md" }],
      ];
      const recoveryDir = resolve(root, "tmp", "compiled-notes");
      await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
      const filename = recoveryFilenameFor(valid.target_path);
      for (const [label, value] of cases) {
        await writeFile(
          join(recoveryDir, filename),
          typeof value === "string" ? value : JSON.stringify(value),
          { mode: 0o600 },
        );
        const listing = await listCompiledNoteRecoveryRecords();
        expect(listing).toHaveLength(1);
        expect(listing[0]!.valid, label).toBe(false);
        if (!listing[0]!.valid) expect(listing[0]!.code, label).toBe("invalid_recovery_record");
        expect(JSON.stringify(listing), label).not.toContain("tier-2 sentinel");
        await rm(join(recoveryDir, filename), { force: true });
      }
      await writeFile(join(recoveryDir, filename), `${JSON.stringify(valid)}\n`, { mode: 0o600 });
      const accepted = await listCompiledNoteRecoveryRecords();
      expect(accepted).toHaveLength(1);
      expect(accepted[0]!.valid).toBe(true);
      if (accepted[0]!.valid) {
        expect(new Date(accepted[0]!.record.source_freshness_at).toISOString()).toBe(
          accepted[0]!.record.source_freshness_at,
        );
      }
    });
  });

  test("recovery enumeration is finite, private, symlink-safe, and keeps later valid records", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const body = `# Safe\n\n${COMPILED_NOTE_MARKER}\n\nSafe facts.\n\n## Sources\n- ${sourceId}`;
      const archive = renderCompiledNoteArchive({ title: "Safe", tier: 1, bodyMd: body });
      const valid = {
        version: 1 as const,
        entity_kind: "person" as const,
        entity_id: entityId,
        expected_page_id: null,
        target_path: compiledNotePath("person", "Safe", entityId),
        title: "Safe",
        tier: 1 as const,
        derived_from: sourceId,
        source_chunk_ids: [sourceId],
        source_freshness_at: "2026-07-24T00:00:00.000Z",
        body_md: body,
        archive_sha256: archive.contentHash,
      };
      const recoveryDir = resolve(root, "tmp", "compiled-notes");
      await writeCompiledNoteRecoveryRecord(valid);
      await writeFile(join(recoveryDir, "bad.json"), "{", { mode: 0o600 });
      const outsideRecordDir = await mkdtemp(join(tmpdir(), "minime-h1-record-outside-"));
      const outsideRecord = join(outsideRecordDir, "outside.json");
      await writeFile(outsideRecord, JSON.stringify(valid), { mode: 0o600 });
      await symlink(outsideRecord, join(recoveryDir, "link.json"));
      await chmod(recoveryDir, 0o755);
      const listing = await listCompiledNoteRecoveryRecords();
      expect(listing.filter((entry) => entry.valid)).toHaveLength(1);
      expect(
        listing.filter((entry) => !entry.valid && entry.code === "invalid_recovery_record"),
      ).toHaveLength(2);
      expect((await stat(recoveryDir)).mode & 0o777).toBe(0o700);
      const files = await readdir(recoveryDir);
      const validFile = files.find((file) => file !== "bad.json");
      expect(validFile).toBeTruthy();
      expect(
        (await stat(join(recoveryDir, recoveryFilenameFor(valid.target_path)))).mode & 0o777,
      ).toBe(0o600);

      const outside = await mkdtemp(join(tmpdir(), "minime-h1-recovery-outside-"));
      let outsideTmp: string | undefined;
      try {
        await rm(recoveryDir, { recursive: true, force: true });
        await symlink(outside, recoveryDir);
        await expect(listCompiledNoteRecoveryRecords()).rejects.toThrow("UNSAFE_PRIVATE_ROOT");
        await rm(resolve(root, "tmp"), { recursive: true, force: true });
        outsideTmp = await mkdtemp(join(tmpdir(), "minime-h1-tmp-outside-"));
        await symlink(outsideTmp, resolve(root, "tmp"));
        await expect(listCompiledNoteRecoveryRecords()).rejects.toThrow("UNSAFE_PRIVATE_ROOT");
      } finally {
        await rm(outside, { recursive: true, force: true });
        await rm(outsideRecordDir, { recursive: true, force: true });
        if (outsideTmp) await rm(outsideTmp, { recursive: true, force: true });
      }
    });
  });

  test("invalid recovery remains byte-for-byte and reports only its fixed code", async () => {
    await withPrivateDataDir(async (root) => {
      const entityId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const body = `# Invalid Sentinel\n\n${COMPILED_NOTE_MARKER}\n\nTier-2 sentinel.\n\n## Sources\n- ${sourceId}`;
      const record = {
        version: 1,
        entity_kind: "person",
        entity_id: entityId,
        expected_page_id: null,
        target_path: compiledNotePath("person", "Invalid Sentinel", entityId),
        title: "Invalid Sentinel",
        tier: 2,
        derived_from: sourceId,
        source_chunk_ids: [sourceId],
        source_freshness_at: "2026-07-24T00:00:00.000Z",
        body_md: body,
        archive_sha256: "f".repeat(64),
      };
      const recoveryDir = resolve(root, "tmp", "compiled-notes");
      await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
      const file = join(recoveryDir, recoveryFilenameFor(record.target_path));
      const bytes = `${JSON.stringify(record)}\n`;
      await writeFile(file, bytes, { mode: 0o600 });
      let modelCalls = 0;
      const [eventsBefore] = await sql`select count(*)::int as n from events`;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            throw new Error("tier-2 sentinel provider rejection");
          },
        },
      });
      expect(result.candidates).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.code).toBe("invalid_recovery_record");
      expect(JSON.stringify(result)).not.toContain("Tier-2 sentinel");
      expect(modelCalls).toBe(0);
      const [eventsAfter] = await sql`select count(*)::int as n from events`;
      expect(eventsAfter!.n).toBe(eventsBefore!.n);
      expect(await readFile(file, "utf8")).toBe(bytes);
    });
  });

  test("recovery write failure leaves the target untouched and permits a later distillation", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Recovery Write Failure");
      let calls = 0;
      const first = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Recovery Write Failure: durable fact.";
          },
          writeRecovery: async () => {
            throw new Error("write denied");
          },
        },
      });
      expect(first.failed).toBe(1);
      expect(first.results[0]!.code).toBe("recovery_write_failed");
      expect(calls).toBe(1);
      const pagesAfterFailure =
        await sql`select count(*)::int as n from pages where source = 'dream:notes'`;
      expect(pagesAfterFailure[0]?.n).toBe(0);
      const second = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Recovery Write Failure: durable fact.";
          },
        },
      });
      expect(second.created + second.updated).toBe(1);
      expect(calls).toBe(2);
      expect(personId).toBeTruthy();
    });
  });

  test("page upsert failure retains a valid record and the next run does not redistill", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Page Upsert Failure");
      let calls = 0;
      const first = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Page Upsert Failure: durable fact.";
          },
          upsertPage: async () => {
            throw new Error("page unavailable");
          },
        },
      });
      expect(first.failed).toBe(1);
      expect(first.results[0]!.code).toBe("page_upsert_failed");
      expect(calls).toBe(1);
      await sql`
        delete from edges
        where id in (
          select id from edges
          where dst_type = 'person' and dst_id = ${personId} and rel = 'mentions'
          order by id
          limit 2
        )`;
      const second = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "must not redistill";
          },
        },
      });
      expect(second.failed).toBe(0);
      expect(second.created).toBe(1);
      expect(calls).toBe(1);
    });
  });

  test("wrong existing hash plus hash-update failure retains a repairable item", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Hash Update Failure");
      let calls = 0;
      const first = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Hash Update Failure: durable fact.";
          },
        },
      });
      expect(first.created).toBe(1);
      const [page] = await sql`
        select id from pages where source = 'dream:notes' and path like ${`%${personId}%`}`;
      expect(page).toBeTruthy();
      await sql`update pages set content_hash = 'wrong-existing-hash' where id = ${page!.id}`;
      const failed = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            throw new Error("must not redistill");
          },
          updateHash: async () => {
            throw new Error("hash unavailable");
          },
        },
      });
      expect(failed.failed).toBe(1);
      expect(failed.results[0]!.code).toBe("hash_update_failed");
      expect(calls).toBe(1);
      const repaired = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            throw new Error("must not redistill on retry");
          },
        },
      });
      expect(repaired.repaired).toBe(1);
      expect(calls).toBe(1);
    });
  });

  test("archive and chunk failures preserve recovery and converge on retry", async () => {
    for (const [label, dependency, expectedCode] of [
      ["archive", "writeArchive", "archive_rename_failed"],
      ["chunk", "replaceIndex", "chunk_replace_failed"],
    ] as const) {
      await withPrivateDataDir(async () => {
        await seedCandidate(`${label} failure`);
        let calls = 0;
        const first = await compileNotes({
          deps: {
            distill: async () => {
              calls++;
              return `${label} failure: durable fact.`;
            },
            [dependency]: async () => {
              throw new Error(`${label} unavailable`);
            },
          },
        });
        expect(first.failed).toBe(1);
        expect(first.results.find((item) => item.status === "failed")!.code).toBe(expectedCode);
        const second = await compileNotes({
          deps: {
            distill: async () => {
              calls++;
              return "must not redistill";
            },
          },
        });
        expect(second.repaired).toBe(1);
        expect(calls).toBe(1);
      });
    }
  });

  test("edge retier failure and verification mismatch retain the record", async () => {
    for (const [dependency, expectedCode] of [
      ["retierEdges", "edge_retier_failed"],
      ["replaceIndex", "verification_failed"],
    ] as const) {
      await withPrivateDataDir(async () => {
        await seedCandidate(`failure ${dependency}`);
        let calls = 0;
        const first = await compileNotes({
          deps: {
            distill: async () => {
              calls++;
              return `failure ${dependency}: durable fact.`;
            },
            [dependency]: async () => {
              if (dependency === "replaceIndex") return 0;
              throw new Error("edge unavailable");
            },
          },
        });
        expect(first.failed).toBe(1);
        expect(first.results.find((item) => item.status === "failed")!.code).toBe(expectedCode);
        const listed = await listCompiledNoteRecoveryRecords();
        expect(listed.filter((entry) => entry.valid)).toHaveLength(1);
        expect(calls).toBe(1);
      });
    }
  });

  test("recovery unlink failure leaves a verified record and retry removes it without model work", async () => {
    await withPrivateDataDir(async (root) => {
      const personId = await seedCandidate("Unlink Failure");
      const recoveryDir = resolve(root, "tmp", "compiled-notes");
      let calls = 0;
      const first = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Unlink Failure: durable fact.";
          },
        },
      });
      expect(first.created).toBe(1);
      const [page] =
        await sql`select id, path, title, body_md, tier, content_hash from pages where source = ${COMPILED_NOTE_SOURCE}`;
      const sourceIds = parseCompiledNoteSourceIds(page!.body_md).ids;
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture("Unlink Failure", personId, page!.tier as 1 | 2),
        expected_page_id: page!.id,
        target_path: page!.path,
        title: page!.title,
        body_md: page!.body_md,
        source_chunk_ids: sourceIds,
        derived_from: sourceIds[0]!,
        archive_sha256: page!.content_hash,
      });
      await rm(resolve(root, "brain", page!.path));
      const recordFile = join(recoveryDir, recoveryFilenameFor(page!.path));
      const recordBytes = await readFile(recordFile);
      const outside = await mkdtemp(join(tmpdir(), "minime-h1-unlink-outside-"));
      const outsideRecord = join(outside, "record.json");
      try {
        const second = await compileNotes({
          deps: {
            distill: async () => {
              calls++;
              return "must not redistill";
            },
            writeArchive: async (target, bytes) => {
              await atomicWritePrivate(target, bytes);
              // Replace the listed record with a symlink after enumeration; unlink must fail closed.
              await writeFile(outsideRecord, recordBytes, { mode: 0o600 });
              await rm(recordFile, { force: true });
              await symlink(outsideRecord, recordFile);
            },
          },
        });
        expect(second.failed).toBe(1);
        expect(second.results[0]!.code).toBe("recovery_remove_failed");
        await rm(recordFile, { force: true });
        await writeFile(recordFile, recordBytes, { mode: 0o600 });
        await chmod(recoveryDir, 0o700);
        const third = await compileNotes({
          deps: {
            distill: async () => {
              calls++;
              return "must not redistill";
            },
          },
        });
        expect(third.failed).toBe(0);
        expect(calls).toBe(1);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("provider rejection is opaque and returns model_distill_failed", async () => {
    await withPrivateDataDir(async () => {
      await seedCandidate("Provider Sentinel");
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
      try {
        const result = await compileNotes({
          deps: {
            distill: async () => {
              throw new Error("tier-2 sentinel provider rejection");
            },
          },
        });
        expect(result.created + result.updated).toBe(1);
        expect(result.results[0]!.code).toBe("model_distill_failed");
        expect(JSON.stringify(result)).not.toContain("tier-2 sentinel");
        expect(errors.join(" ")).not.toContain("tier-2 sentinel");
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^\[dream:notes\] model_distill_failed target=[0-9a-f]{16}$/);
      } finally {
        console.error = original;
      }
    });
  });

  test("dream summary success shape is content-free across tier-2 note failures", async () => {
    await withPrivateDataDir(async () => {
      const SENTINEL = "tier-2-dream-summary-sentinel";
      await seedCandidate(`${SENTINEL} title/${SENTINEL} readable`, [2, 2, 2]);
      const recoveryDir = compiledNoteRecoveryDir();
      await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
      await chmod(recoveryDir, 0o700);
      const invalidRecovery = join(recoveryDir, `person--${crypto.randomUUID()}.v1.json`);
      await writeFile(invalidRecovery, `{ malformed recovery ${SENTINEL}`, { mode: 0o600 });

      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
      try {
        const providerFailure = await compileNotes({
          deps: {
            distill: async () => {
              throw new Error(`${SENTINEL} provider rejection`);
            },
          },
        });
        const providerResult = providerFailure.results.find(
          (entry) => entry.code === "model_distill_failed",
        );
        expect(providerResult).toMatchObject({
          status: "created",
          code: "model_distill_failed",
          tier: 2,
        });
        expect(providerFailure.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ status: "failed", code: "invalid_recovery_record" }),
          ]),
        );
        const [before] = await sql`select coalesce(max(id), 0)::int as id from events`;
        const result = await dream();
        const events = await sql`select payload from events
          where verb = 'dream:summary' and id > ${before!.id}
          order by id desc`;
        const serialized = JSON.stringify({ result, providerFailure });
        const stderr = errors.join("\n");
        expect(events).toHaveLength(1);
        expect(serialized).not.toContain(SENTINEL);
        expect(stderr).not.toContain(SENTINEL);
        expect(JSON.stringify(events)).not.toContain(SENTINEL);
        expect(result["2b_compile_notes"]).toEqual({
          candidates: expect.any(Number),
          created: expect.any(Number),
          updated: expect.any(Number),
          repaired: expect.any(Number),
          unchanged: expect.any(Number),
          failed: expect.any(Number),
        });
      } finally {
        console.error = original;
      }
    });
  });

  test("dream summary uses the fixed fallback after a top-level notes failure", async () => {
    await withPrivateDataDir(async () => {
      const SENTINEL = "tier-2-dream-fallback-sentinel";
      const recoveryDir = compiledNoteRecoveryDir();
      await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
      await chmod(recoveryDir, 0o700);
      await writeFile(
        join(recoveryDir, `person--${crypto.randomUUID()}.v1.json`),
        `{ malformed private ${SENTINEL}`,
        { mode: 0o600 },
      );

      const errors: string[] = [];
      const original = console.error;
      let pagesRenamed = false;
      console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
      try {
        await sql`alter table pages rename to pages_h1_dream_summary_failure`;
        pagesRenamed = true;
        const [before] = await sql`select coalesce(max(id), 0)::int as id from events`;
        const result = await dream();
        const events = await sql`select payload from events
          where verb = 'dream:summary' and id > ${before!.id}
          order by id desc`;
        expect(result["2b_compile_notes"]).toEqual({
          candidates: 0,
          created: 0,
          updated: 0,
          repaired: 0,
          unchanged: 0,
          failed: 1,
        });
        expect(events).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain(SENTINEL);
        expect(errors.join("\n")).not.toContain(SENTINEL);
        expect(JSON.stringify(events)).not.toContain(SENTINEL);
      } finally {
        try {
          if (pagesRenamed) {
            await sql`alter table pages_h1_dream_summary_failure rename to pages`;
          }
        } finally {
          console.error = original;
        }
      }
    });
  });

  test("canonical human collision retains recovery and writes nothing, while matching compiled identity is accepted", async () => {
    await withPrivateDataDir(async () => {
      const [person] = await sql`
        insert into people (canonical_name, tier)
        values ('Collision Person', 1)
        returning id`;
      const personId = person!.id;
      const record = await recoveryWithVerifiablePersonSource(
        recoveryFixture("Collision Person", personId, 2),
        personId,
        "Collision Person",
      );
      await writeCompiledNoteRecoveryRecord(record);
      const target = record.target_path;
      const [human] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${target}, 'Human', '# human', 'human-hash', 1, 'brain-sync', 'human')
        returning id, xmin::text as version`;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("collision must not model");
          },
        },
      });
      expect(result.failed).toBe(1);
      expect(result.results[0]!.code).toBe("identity_conflict");
      const [after] =
        await sql`select body_md, tier, xmin::text as version from pages where id = ${human!.id}`;
      expect(after).toEqual({ body_md: "# human", tier: 1, version: human!.version });
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        1,
      );
    });
  });

  test("symlinked archive target fails closed before any archive write", async () => {
    await withPrivateDataDir(async (root) => {
      const [person] = await sql`
        insert into people (canonical_name, tier)
        values ('Archive Symlink Person', 1)
        returning id`;
      const record = await recoveryWithVerifiablePersonSource(
        recoveryFixture("Archive Symlink Person", person!.id, 2),
        person!.id,
        "Archive Symlink Person",
      );
      await writeCompiledNoteRecoveryRecord(record);
      const archiveTarget = resolve(root, "brain", record.target_path);
      const outsideDir = await mkdtemp(join(tmpdir(), "minime-h1-archive-outside-"));
      const outsideFile = join(outsideDir, "outside.md");
      await writeFile(outsideFile, "outside sentinel", { mode: 0o600 });
      await mkdir(join(root, "brain", "derived", "notes", "person"), {
        recursive: true,
        mode: 0o700,
      });
      await symlink(outsideFile, archiveTarget);
      try {
        const result = await compileNotes({
          deps: {
            distill: async () => {
              throw new Error("must not distill symlink target");
            },
          },
        });
        expect(result.failed).toBe(1);
        expect(result.results[0]!.code).toBe("unsafe_archive_path");
        expect(await readFile(outsideFile, "utf8")).toBe("outside sentinel");
        expect(
          (await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid),
        ).toHaveLength(1);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  test("symlinked brain root aborts recovery convergence without touching the outside root", async () => {
    await withPrivateDataDir(async (root) => {
      const personId = crypto.randomUUID();
      await sql`insert into people (id, canonical_name, tier) values (${personId}, 'Symlink Brain', 1)`;
      const record = recoveryFixture("Symlink Brain", personId, 1);
      await writeCompiledNoteRecoveryRecord(record);
      const outside = await mkdtemp(join(tmpdir(), "minime-h1-brain-outside-"));
      const brain = join(root, "brain");
      await symlink(outside, brain);
      try {
        const result = await compileNotes({
          deps: {
            distill: async () => {
              throw new Error("symlink brain must not distill");
            },
          },
        });
        expect(result.failed).toBe(1);
        expect(result.results[0]!.code).toBe("unsafe_archive_path");
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("two concurrent compiler loops share one PostgreSQL lease and one model call", async () => {
    await withPrivateDataDir(async () => {
      await seedCandidate("Lease Person");
      let calls = 0;
      let entered = false;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deps = {
        distill: async () => {
          calls++;
          entered = true;
          await barrier;
          return "Lease Person: durable fact.";
        },
      };
      const first = compileNotes({ deps });
      for (let i = 0; i < 50 && !entered; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(entered).toBe(true);
      const second = compileNotes({ deps });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(calls).toBe(1);
      release();
      await Promise.all([first, second]);
      expect(calls).toBe(1);
    });
  });

  test("child-process lease crash releases the advisory lock for the next compiler", async () => {
    await withPrivateDataDir(async () => {
      await seedCandidate("Crash Lease Person");
      const child = Bun.spawn(
        [
          "bun",
          "-e",
          "import postgres from 'postgres'; const db = postgres(process.env.DATABASE_URL); await db`select pg_advisory_lock(1296649541, 1)`; process.exit(0);",
        ],
        { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).toBe(0);
      let entered = false;
      await withCompiledNotesLease(async () => {
        entered = true;
        return true;
      });
      expect(entered).toBe(true);
    });
  });

  test("source changes after a recovery snapshot permit one newer distillation", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Recovery Source Race");
      const sourceIds = await personSourceIds(personId);
      const oldSourceIds = sourceIds.slice(0, 2);
      const body = `# Recovery Source Race\n\n${COMPILED_NOTE_MARKER}\n\nOld durable fact.\n\n## Sources\n${oldSourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Recovery Source Race",
        tier: 1,
        bodyMd: body,
      });
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture("Recovery Source Race", personId, 1),
        body_md: body,
        source_chunk_ids: oldSourceIds,
        derived_from: oldSourceIds[0]!,
        archive_sha256: archive.contentHash,
      });
      let calls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Recovery Source Race: refreshed durable fact.";
          },
        },
      });
      expect(result.failed).toBe(0);
      expect(result.updated + result.created + result.repaired).toBe(1);
      expect(calls).toBe(1);
    });
  });

  test("source change during the permitted model call reports deferred freshness", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Deferred Source Race");
      let calls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            const [page] = await sql`
              insert into pages (path, title, body_md, content_hash, tier, source)
              values ('deferred-race-source.md', 'Deferred source', 'Deferred Source Race arrived.', 'deferred-source-hash', 1, 'test')
              returning id`;
            const [chunk] = await sql`
              insert into chunks (parent_type, parent_id, ord, text, tier)
              values ('page', ${page!.id}, 0, 'Deferred Source Race arrived.', 1)
              returning id`;
            await sql`
              insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
              values ('page', ${page!.id}, 'mentions', 'person', ${personId}, 'chunks', ${chunk!.id}, 'test:deferred')`;
            return "Deferred Source Race: first durable fact.";
          },
        },
      });
      expect(calls).toBe(1);
      expect(result.results[0]!.status).toMatch(/created|updated/);
      expect(result.results[0]!.code).toBe("source_changed_deferred");
      const next = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Deferred Source Race: second durable fact.";
          },
        },
      });
      expect(next.updated + next.created).toBe(1);
      expect(calls).toBe(2);
    });
  });

  test("representation repair does not erase a stale source baseline", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Repair Then Distill");
      let calls = 0;
      const first = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Repair Then Distill: initial fact.";
          },
        },
      });
      expect(first.created).toBe(1);
      const [page] =
        await sql`select id, body_md from pages where source = ${COMPILED_NOTE_SOURCE}`;
      await sql`update pages set content_hash = 'wrong-before-stale-repair' where id = ${page!.id}`;
      const [source] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source)
        values ('repair-then-distill-source.md', 'Repair source', 'Repair Then Distill arrived later.', 'repair-source-hash', 1, 'test')
        returning id`;
      const [chunk] = await sql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${source!.id}, 0, 'Repair Then Distill arrived later.', 1)
        returning id`;
      await sql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
        values ('page', ${source!.id}, 'mentions', 'person', ${personId}, 'chunks', ${chunk!.id}, 'test:late')`;
      const second = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Repair Then Distill: refreshed fact.";
          },
        },
      });
      expect(second.updated).toBe(1);
      expect(second.failed).toBe(0);
      expect(calls).toBe(2);
      const [after] = await sql`select body_md from pages where id = ${page!.id}`;
      expect(after!.body_md).not.toBe(page!.body_md);
    });
  });

  test("a later source timestamp still triggers after a persisted representation repair", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Later Timestamp");
      let calls = 0;
      const first = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Later Timestamp: initial fact.";
          },
        },
      });
      expect(first.created).toBe(1);
      const [page] = await sql`select id from pages where source = ${COMPILED_NOTE_SOURCE}`;
      await sql`update pages set content_hash = 'repair-only-hash' where id = ${page!.id}`;
      const repaired = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            throw new Error("repair-only pass must not distill");
          },
        },
      });
      expect(repaired.repaired).toBe(1);
      expect(calls).toBe(1);
      const [source] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source)
        values ('later-timestamp-source.md', 'Later source', 'Later Timestamp changed.', 'later-source-hash', 1, 'test')
        returning id`;
      const [chunk] = await sql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${source!.id}, 0, 'Later Timestamp changed.', 1)
        returning id`;
      await sql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, created_at)
        values ('page', ${source!.id}, 'mentions', 'person', ${personId}, 'chunks', ${chunk!.id}, 'test:later', now() + interval '1 minute')`;
      const next = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Later Timestamp: refreshed fact.";
          },
        },
      });
      expect(next.updated).toBe(1);
      expect(calls).toBe(2);
    });
  });

  test("newer alias edge with identical ordered Sources IDs triggers exactly one model call", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Alias Freshness");
      let calls = 0;
      const first = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Alias Freshness: initial fact.";
          },
        },
      });
      expect(first.created).toBe(1);
      const [source] = await sql`
        select src_id, source_id from edges
        where dst_type = 'person' and dst_id = ${personId} and rel = 'mentions' and source_table = 'chunks'
        order by id limit 1`;
      await sql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by, created_at)
        values ('page', ${source!.src_id}, 'mentions', 'person', ${personId}, 'chunks', ${source!.source_id}, 'test:alias-later', now() + interval '1 minute')`;
      const second = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Alias Freshness: refreshed fact.";
          },
        },
      });
      expect(second.updated).toBe(1);
      expect(second.results).toHaveLength(1);
      expect(calls).toBe(2);
      const [note] = await sql`select body_md from pages where source = ${COMPILED_NOTE_SOURCE}`;
      expect(note!.body_md).toContain("refreshed fact");
    });
  });

  test("legacy recovery ownership is derived from the current page Sources", async () => {
    const cases = [
      { label: "human current body", mode: "human" as const, expectConflict: true },
      { label: "contradictory current owner", mode: "other" as const, expectConflict: true },
      { label: "matching current owner", mode: "matching" as const, expectConflict: false },
    ];
    for (const fixture of cases) {
      await resetDb();
      await withPrivateDataDir(async () => {
        const [person] = await sql`
          insert into people (canonical_name, tier) values (${`Legacy ${fixture.mode}`}, 1)
          returning id`;
        const [oldPage] = await sql`
          insert into pages (path, title, body_md, content_hash, tier, source)
          values (${`legacy-old-${fixture.mode}.md`}, 'Old source', 'old durable source', 'old-hash', 1, 'test')
          returning id`;
        const [oldChunk] = await sql`
          insert into chunks (parent_type, parent_id, ord, text, tier)
          values ('page', ${oldPage!.id}, 0, ${`Legacy ${fixture.mode} old source`}, 1)
          returning id`;
        await sql`
          insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
          values ('page', ${oldPage!.id}, 'mentions', 'person', ${person!.id}, 'chunks', ${oldChunk!.id}, 'test:legacy-old')`;
        let currentSourceId = oldChunk!.id as string;
        if (fixture.mode === "other") {
          const [other] = await sql`
            insert into people (canonical_name, tier) values ('Legacy Other', 1) returning id`;
          const [currentPage] = await sql`
            insert into pages (path, title, body_md, content_hash, tier, source)
            values ('legacy-current-source.md', 'Current source', 'other', 'current-source-hash', 1, 'test')
            returning id`;
          const [currentChunk] = await sql`
            insert into chunks (parent_type, parent_id, ord, text, tier)
            values ('page', ${currentPage!.id}, 0, 'Legacy Other current source', 1)
            returning id`;
          await sql`
            insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by)
            values ('page', ${currentPage!.id}, 'mentions', 'person', ${other!.id}, 'chunks', ${currentChunk!.id}, 'test:legacy-current')`;
          currentSourceId = currentChunk!.id as string;
        }
        const targetPath = `derived/notes/person/legacy-current-${fixture.mode}.md`;
        const currentBody =
          fixture.mode === "human"
            ? "# Human replacement\n\nHuman-owned text without compiled ownership."
            : `# Legacy ${fixture.mode}\n\n${COMPILED_NOTE_MARKER}\n\nCurrent durable body.\n\n## Sources\n- ${currentSourceId}`;
        const [page] = await sql`
          insert into pages (path, title, body_md, content_hash, tier, source, created_by)
          values (${targetPath}, ${`Legacy ${fixture.mode}`}, ${currentBody}, 'current-page-hash', 1, 'brain-sync', 'human')
          returning id, body_md, content_hash, xmin::text as version`;
        const record = legacyRecoveryFixture(
          `Legacy ${fixture.mode}`,
          person!.id as string,
          targetPath,
          page!.id as string,
          [oldChunk!.id as string],
        );
        await writeCompiledNoteRecoveryRecord(record);
        let models = 0;
        let pageWrites = 0;
        let archiveWrites = 0;
        let indexWrites = 0;
        const result = await compileNotes({
          deps: {
            distill: async () => {
              models++;
              return "must not distill";
            },
            upsertPage: async (input, options) => {
              pageWrites++;
              return repoUpsertPage(input, options);
            },
            writeArchive: async (archivePath, archiveBytes) => {
              archiveWrites++;
              await atomicWritePrivate(archivePath, archiveBytes);
            },
            replaceIndex: async (pageId, pageBody, pageTitle, pageTier) => {
              indexWrites++;
              return indexParent("page", pageId, pageBody, pageTitle, pageTier, {
                extractEdges: false,
                tierMode: "promote-page-floor",
              });
            },
          },
        });
        if (fixture.expectConflict) {
          expect(result.results.some((item) => item.code === "identity_conflict")).toBe(true);
          expect(result.failed).toBe(1);
          expect(models).toBe(0);
          expect(pageWrites + archiveWrites + indexWrites).toBe(0);
          const [after] =
            await sql`select body_md, content_hash, xmin::text as version from pages where id = ${page!.id}`;
          expect(after).toEqual({
            body_md: page!.body_md,
            content_hash: page!.content_hash,
            version: page!.version,
          });
          expect(
            (await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid),
          ).toHaveLength(1);
        } else {
          expect(result.failed).toBe(0);
          expect(result.repaired).toBe(1);
          expect(models).toBe(0);
          const [after] =
            await sql`select id, source, created_by from pages where id = ${page!.id}`;
          expect(after).toEqual({
            id: page!.id,
            source: COMPILED_NOTE_SOURCE,
            created_by: COMPILED_NOTE_CREATOR,
          });
        }
      });
    }
  });

  test("canonical recovery rejects dangling expected IDs and accepts matching non-dream ownership", async () => {
    await withPrivateDataDir(async () => {
      const entityId = crypto.randomUUID();
      await sql`
        insert into people (id, canonical_name, tier) values (${entityId}, 'Dangling expected', 1)`;
      const dangling = await recoveryWithVerifiablePersonSource(
        recoveryFixture("Dangling expected", entityId, 1),
        entityId,
        "Dangling expected",
      );
      dangling.expected_page_id = crypto.randomUUID();
      await writeCompiledNoteRecoveryRecord(dangling);
      const result = await compileNotes();
      expect(result).toEqual({
        candidates: 0,
        created: 0,
        updated: 0,
        repaired: 0,
        unchanged: 0,
        failed: 1,
        results: [
          {
            status: "failed",
            target_hash: opaqueTargetHash(dangling.target_path),
            code: "identity_conflict",
            kind: "person",
            tier: 1,
          },
        ],
      });
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        1,
      );
    });

    await withPrivateDataDir(async () => {
      const [person] =
        await sql`insert into people (canonical_name, tier) values ('Canonical import', 1) returning id`;
      const [source] =
        await sql`insert into pages (path, title, body_md, content_hash, tier, source) values ('canonical-source.md', 'Canonical source', 'Canonical import fact', 'source-hash', 1, 'test') returning id`;
      const [chunk] =
        await sql`insert into chunks (parent_type, parent_id, ord, text, tier) values ('page', ${source!.id}, 0, 'Canonical import fact', 1) returning id`;
      await sql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by) values ('page', ${source!.id}, 'mentions', 'person', ${person!.id}, 'chunks', ${chunk!.id}, 'test:canonical')`;
      const body = `# Canonical import\n\n${COMPILED_NOTE_MARKER}\n\nCanonical import fact.\n\n## Sources\n- ${chunk!.id}`;
      const archive = renderCompiledNoteArchive({
        title: "Canonical import",
        tier: 1,
        bodyMd: body,
      });
      await sql`insert into pages (path, title, body_md, content_hash, tier, source, created_by) values (${compiledNotePath("person", "Canonical import", person!.id)}, 'Canonical import', ${body}, ${archive.contentHash}, 1, 'brain-sync', 'human')`;
      const record = {
        ...recoveryFixture("Canonical import", person!.id, 1),
        body_md: body,
        source_chunk_ids: [chunk!.id],
        derived_from: chunk!.id,
        archive_sha256: archive.contentHash,
      };
      await writeCompiledNoteRecoveryRecord(record);
      const result = await compileNotes();
      expect(result.failed).toBe(0);
      expect(result.repaired).toBe(1);
      const [after] =
        await sql`select source, created_by from pages where path = ${record.target_path}`;
      expect(after).toEqual({ source: COMPILED_NOTE_SOURCE, created_by: COMPILED_NOTE_CREATOR });
    });
  });

  test("recovery freshness permits one distillation for a newer alias edge", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Recovery Alias Freshness");
      const ids = await personSourceIds(personId);
      const body = `# Recovery Alias Freshness\n\n${COMPILED_NOTE_MARKER}\n\nOld recovery body.\n\n## Sources\n${ids.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Recovery Alias Freshness",
        tier: 1,
        bodyMd: body,
      });
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture("Recovery Alias Freshness", personId, 1),
        body_md: body,
        source_chunk_ids: ids,
        derived_from: ids[0]!,
        source_freshness_at: "2020-01-01T00:00:00.000Z",
        archive_sha256: archive.contentHash,
      });
      let calls = 0;
      const first = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Recovery Alias Freshness: refreshed.";
          },
        },
      });
      expect(first.created).toBe(1);
      expect(calls).toBe(1);
      const second = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "must not distill again";
          },
        },
      });
      expect(second.unchanged + second.repaired).toBe(1);
      expect(calls).toBe(1);
    });
  });

  test("compile waits for the shared target lease before enumerating or writing", async () => {
    await withPrivateDataDir(async () => {
      await seedCandidate("Target Lease Barrier");
      const targetPath = compiledNotePath(
        "person",
        "Target Lease Barrier",
        (await sql`select id from people where canonical_name = 'Target Lease Barrier'`)[0]!
          .id as string,
      );
      let release!: () => void;
      const held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolveEntered) => {
        entered = resolveEntered;
      });
      const holder = withCompiledNoteTargetLease(targetPath, async () => {
        entered();
        await held;
      });
      await enteredPromise;
      let finished = false;
      let calls = 0;
      const pending = compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Target Lease Barrier: fact.";
          },
        },
      }).then((value) => {
        finished = true;
        return value;
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      expect(finished).toBe(false);
      expect(calls).toBe(0);
      release();
      await holder;
      const result = await pending;
      expect(result.created).toBe(1);
      expect(calls).toBe(1);
    });
  });

  test("edge-only representation floor is authoritative for page and archive", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Edge Floor Person");
      const sourceIds = await personSourceIds(personId);
      const body = `# Edge Floor Person\n\n${COMPILED_NOTE_MARKER}\n\nExisting body.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Edge Floor Person",
        tier: 1,
        bodyMd: body,
      });
      const path = compiledNotePath("person", "Edge Floor Person", personId);
      const [page] =
        await sql`insert into pages (path, title, body_md, content_hash, tier, source, created_by, derived_from) values (${path}, 'Edge Floor Person', ${body}, ${archive.contentHash}, 1, ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR}, ${sourceIds[0]!}) returning id`;
      await sql`insert into chunks (parent_type, parent_id, ord, text, tier) values ('page', ${page!.id}, 0, ${body}, 1)`;
      await sql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by) values ('page', ${page!.id}, 'compiled-floor', 'person', ${personId}, 'pages', ${page!.id}, 2, 'test:floor')`;
      await sql`update edges set tier = 2 where source_table = 'pages' and source_id = ${page!.id}`;
      const result = await compileNotes();
      expect(result.repaired).toBe(1);
      expect(result.results[0]!.tier).toBe(2);
      const [after] = await sql`select tier from pages where id = ${page!.id}`;
      expect(after!.tier).toBe(2);
      const archiveAfter = parseCompiledNoteArchive(
        await readFile(resolve(config.dataDir, "brain", path), "utf8"),
      );
      expect(archiveAfter?.tier).toBe(2);
      const chunks =
        await sql`select tier from chunks where parent_type = 'page' and parent_id = ${page!.id}`;
      expect(chunks.every((row) => row.tier === 2)).toBe(true);
      const edges =
        await sql`select tier from edges where (source_table = 'pages' and source_id = ${page!.id}) or (src_type = 'page' and src_id = ${page!.id})`;
      expect(edges.every((row) => row.tier === 2)).toBe(true);
      const second = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("aligned retry must not distill");
          },
          retierEdges: async () => 0,
        },
      });
      expect(second.unchanged).toBe(1);
    });
  });

  test("cluster-only tier floor promotes a page with no eligible candidate", async () => {
    await withPrivateDataDir(async () => {
      const [person] =
        await sql`insert into people (canonical_name, tier) values ('Cluster Floor Person', 1) returning id`;
      const [sourceOne] =
        await sql`insert into pages (path, title, body_md, content_hash, tier, source) values ('cluster-floor-one.md', 'One', 'Cluster Floor Person one', 'one', 1, 'test') returning id`;
      const [chunkOne] =
        await sql`insert into chunks (parent_type, parent_id, ord, text, tier) values ('page', ${sourceOne!.id}, 0, 'Cluster Floor Person one', 1) returning id`;
      const [sourceTwo] =
        await sql`insert into pages (path, title, body_md, content_hash, tier, source) values ('cluster-floor-two.md', 'Two', 'Cluster Floor Person two', 'two', 2, 'test') returning id`;
      const [chunkTwo] =
        await sql`insert into chunks (parent_type, parent_id, ord, text, tier) values ('page', ${sourceTwo!.id}, 0, 'Cluster Floor Person two', 2) returning id`;
      await sql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by)
        values ('page', ${sourceOne!.id}, 'mentions', 'person', ${person!.id}, 'chunks', ${chunkOne!.id}, 1, 'test:cluster'),
               ('page', ${sourceTwo!.id}, 'mentions', 'person', ${person!.id}, 'chunks', ${chunkTwo!.id}, 2, 'test:cluster')`;
      const body = `# Cluster Floor Person\n\n${COMPILED_NOTE_MARKER}\n\nCluster floor body.\n\n## Sources\n- ${chunkOne!.id}`;
      const archive = renderCompiledNoteArchive({
        title: "Cluster Floor Person",
        tier: 1,
        bodyMd: body,
      });
      const path = compiledNotePath("person", "Cluster Floor Person", person!.id);
      const [page] =
        await sql`insert into pages (path, title, body_md, content_hash, tier, source, created_by, derived_from) values (${path}, 'Cluster Floor Person', ${body}, ${archive.contentHash}, 1, ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR}, ${sourceOne!.id}) returning id`;
      await sql`insert into chunks (parent_type, parent_id, ord, text, tier) values ('page', ${page!.id}, 0, ${body}, 1)`;
      const result = await compileNotes();
      expect(result.repaired).toBe(1);
      const [after] = await sql`select tier from pages where id = ${page!.id}`;
      expect(after!.tier).toBe(2);
    });
  });

  test("tier raised during page upsert rerenders and converges at the higher floor", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Tier Race Person");
      const sourceIds = await personSourceIds(personId);
      const body = `# Tier Race Person\n\n${COMPILED_NOTE_MARKER}\n\nTier race body.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Tier Race Person",
        tier: 1,
        bodyMd: body,
      });
      const path = compiledNotePath("person", "Tier Race Person", personId);
      const [page] =
        await sql`insert into pages (path, title, body_md, content_hash, tier, source, created_by, derived_from) values (${path}, 'Stale title', ${body}, ${archive.contentHash}, 1, ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR}, ${sourceIds[0]!}) returning id`;
      await sql`insert into chunks (parent_type, parent_id, ord, text, tier) values ('page', ${page!.id}, 0, ${body}, 1)`;
      await sql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by) values ('page', ${page!.id}, 'compiled-floor', 'person', ${personId}, 'pages', ${page!.id}, 1, 'test:tier-race')`;
      const result = await compileNotes({
        deps: {
          upsertPage: async (input, options) => {
            const upserted = await repoUpsertPage(input, options);
            await sql`update pages set tier = 2 where id = ${upserted.id}`;
            await sql`update chunks set tier = 2 where parent_type = 'page' and parent_id = ${upserted.id}`;
            await sql`update edges set tier = 2 where (source_table = 'pages' and source_id = ${upserted.id}) or (src_type = 'page' and src_id = ${upserted.id})`;
            return upserted;
          },
        },
      });
      expect(result.repaired).toBe(1);
      expect(result.results[0]!.tier).toBe(2);
      const [after] = await sql`select tier from pages where id = ${page!.id}`;
      expect(after!.tier).toBe(2);
      expect(
        parseCompiledNoteArchive(await readFile(resolve(config.dataDir, "brain", path), "utf8"))
          ?.tier,
      ).toBe(2);
    });
  });

  test("imported canonical repair restores archive hash and representative parent", async () => {
    await withPrivateDataDir(async () => {
      const [person] =
        await sql`insert into people (canonical_name, tier) values ('Representative Parent', 1) returning id`;
      const [source] =
        await sql`insert into pages (path, title, body_md, content_hash, tier, source) values ('representative-parent.md', 'Parent', 'Representative Parent fact', 'parent-hash', 1, 'test') returning id`;
      const [chunk] =
        await sql`insert into chunks (parent_type, parent_id, ord, text, tier) values ('page', ${source!.id}, 0, 'Representative Parent fact', 1) returning id`;
      await sql`insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, extracted_by) values ('page', ${source!.id}, 'mentions', 'person', ${person!.id}, 'chunks', ${chunk!.id}, 'test:representative')`;
      const body = `# Representative Parent\n\n${COMPILED_NOTE_MARKER}\n\nRepresentative Parent fact.\n\n## Sources\n- ${chunk!.id}`;
      const archive = renderCompiledNoteArchive({
        title: "Representative Parent",
        tier: 1,
        bodyMd: body,
      });
      const path = compiledNotePath("person", "Representative Parent", person!.id);
      const wrongHash = "wrong-imported-hash";
      await sql`insert into pages (path, title, body_md, content_hash, tier, source, created_by, derived_from) values (${path}, 'Representative Parent', ${body}, ${wrongHash}, 1, 'brain-sync', 'human', ${chunk!.id})`;
      await mkdir(join(config.dataDir, "brain", "derived", "notes", "person"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(resolve(config.dataDir, "brain", path), archive.text, {
        encoding: "utf8",
        mode: 0o600,
      });
      const result = await compileNotes();
      expect(result.repaired).toBe(1);
      const [after] = await sql`select content_hash, derived_from from pages where path = ${path}`;
      expect(after).toEqual({ content_hash: archive.contentHash, derived_from: source!.id });
    });
  });

  test("deleted canonical page is reactivated with its original UUID", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Deleted Reactivation");
      const sourceIds = await personSourceIds(personId);
      const body = `# Deleted Reactivation\n\n${COMPILED_NOTE_MARKER}\n\nDeleted durable body.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Deleted Reactivation",
        tier: 1,
        bodyMd: body,
      });
      const path = compiledNotePath("person", "Deleted Reactivation", personId);
      const [page] =
        await sql`insert into pages (path, title, body_md, content_hash, tier, source, created_by, derived_from, status) values (${path}, 'Deleted Reactivation', ${body}, ${archive.contentHash}, 1, ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR}, ${sourceIds[0]!}, 'deleted') returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture("Deleted Reactivation", personId, 1),
        expected_page_id: page!.id,
        body_md: body,
        source_chunk_ids: sourceIds,
        derived_from: sourceIds[0]!,
        archive_sha256: archive.contentHash,
      });
      const result = await compileNotes();
      expect(result.repaired).toBe(1);
      const [after] = await sql`select id, status from pages where path = ${path}`;
      expect(after).toEqual({ id: page!.id, status: "active" });
    });
  });

  test("unsafe private roots return one fixed opaque failure result", async () => {
    const modes = ["brain", "recovery"] as const;
    for (const mode of modes) {
      await resetDb();
      await withPrivateDataDir(async (root) => {
        const entityId = crypto.randomUUID();
        const record = recoveryFixture(`Unsafe root ${mode}`, entityId, 1);
        await writeCompiledNoteRecoveryRecord(record);
        const outside = await mkdtemp(join(tmpdir(), `minime-h1-unsafe-${mode}-`));
        if (mode === "brain") {
          await rm(join(root, "brain"), { recursive: true, force: true });
          await symlink(outside, join(root, "brain"));
        } else {
          const recoveryDir = compiledNoteRecoveryDir();
          await rm(recoveryDir, { recursive: true, force: true });
          await symlink(outside, recoveryDir);
        }
        let models = 0;
        const result = await compileNotes({
          deps: {
            distill: async () => {
              models++;
              return "must not run";
            },
          },
        });
        expect(result).toEqual({
          candidates: 0,
          created: 0,
          updated: 0,
          repaired: 0,
          unchanged: 0,
          failed: 1,
          results: [
            {
              status: "failed",
              target_hash: opaqueTargetHash("compiled-note-root"),
              code: "unsafe_archive_path",
            },
          ],
        });
        expect(models).toBe(0);
      });
    }
  });

  test("archive regular-file to symlink swap fails closed during final verification", async () => {
    await withPrivateDataDir(async (root) => {
      const personId = crypto.randomUUID();
      await sql`
        insert into people (id, canonical_name, tier) values (${personId}, 'Archive TOCTOU', 1)`;
      const record = await recoveryWithVerifiablePersonSource(
        recoveryFixture("Archive TOCTOU", personId, 1),
        personId,
        "Archive TOCTOU",
      );
      await writeCompiledNoteRecoveryRecord(record);
      const target = resolve(root, "brain", record.target_path);
      await mkdir(join(root, "brain", "derived", "notes", "person"), {
        recursive: true,
        mode: 0o700,
      });
      const outsideDir = await mkdtemp(join(tmpdir(), "minime-h1-toctou-outside-"));
      const outside = join(outsideDir, "sentinel.md");
      await writeFile(outside, "outside sentinel", { mode: 0o600 });
      const result = await compileNotes({
        deps: {
          writeArchive: async () => {
            await symlink(outside, target);
          },
        },
      });
      expect(result.failed).toBe(1);
      expect(result.results[0]!.code).toBe("unsafe_archive_path");
      expect(await readFile(outside, "utf8")).toBe("outside sentinel");
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        1,
      );
    });
  });

  test("missing source evidence is removed before recovery writes", async () => {
    await withPrivateDataDir(async () => {
      const personId = crypto.randomUUID();
      const missing = recoveryFixture("Missing Source", personId, 1);
      await writeCompiledNoteRecoveryRecord(missing);
      const orgId = crypto.randomUUID();
      const orgBody = `# Acme\n\n${COMPILED_NOTE_MARKER}\n\nAcme facts.\n\n## Sources\n- ${crypto.randomUUID()}`;
      const orgArchive = renderCompiledNoteArchive({ title: "Acme", tier: 1, bodyMd: orgBody });
      await writeCompiledNoteRecoveryRecord({
        ...missing,
        target_path: compiledNotePath("org", "Acme", orgId),
        title: "Acme",
        body_md: orgBody,
        archive_sha256: orgArchive.contentHash,
        entity_kind: "org",
        entity_id: orgId,
        derived_from: crypto.randomUUID(),
        source_chunk_ids: [crypto.randomUUID()],
      });
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("recovery must not distill");
          },
        },
      });
      expect(result.created).toBe(0);
      expect(result.failed).toBe(2);
      expect(
        result.results.every(
          (entry) =>
            entry.status === "failed" &&
            entry.code === "source_evidence_unverifiable" &&
            !("tier" in entry),
        ),
      ).toBe(true);
      const rows =
        await sql`select tier, source, created_by from pages where source = 'dream:notes' order by path`;
      expect(rows).toHaveLength(0);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
    });
  });

  test("recovery ownership is revalidated after waiting for the target lease", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Lease Ownership Race");
      const sourceIds = await personSourceIds(personId);
      const body = `# Lease Ownership Race\n\n${COMPILED_NOTE_MARKER}\n\nLease facts.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Lease Ownership Race",
        tier: 1,
        bodyMd: body,
      });
      const path = compiledNotePath("person", "Lease Ownership Race", personId);
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${path}, 'Lease Ownership Race', ${body}, ${archive.contentHash}, 1, 'brain-sync', 'human')
        returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture("Lease Ownership Race", personId, 1),
        body_md: body,
        source_chunk_ids: sourceIds,
        derived_from: sourceIds[0]!,
        archive_sha256: archive.contentHash,
        expected_page_id: page!.id,
      });
      let release!: () => void;
      const held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolveEntered) => {
        entered = resolveEntered;
      });
      const holder = withCompiledNoteTargetLease(path, async () => {
        entered();
        await held;
      });
      await enteredPromise;
      let models = 0;
      const pending = compileNotes({
        deps: {
          distill: async () => {
            models++;
            return "must not distill";
          },
        },
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      await sql`update pages set body_md = 'Human replacement', source = 'human', created_by = 'human' where id = ${page!.id}`;
      release();
      await holder;
      const result = await pending;
      expect(result.failed).toBe(1);
      expect(result.results[0]!.code).toBe("identity_conflict");
      expect(models).toBe(0);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        1,
      );
    });
  });

  test("convergence writes page, hash, archive, index, then post-retier", async () => {
    await withPrivateDataDir(async (root) => {
      const personId = await seedCandidate("Ordered Convergence");
      const sourceIds = await personSourceIds(personId);
      const body = `# Ordered Convergence\n\n${COMPILED_NOTE_MARKER}\n\nOrdered facts.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Ordered Convergence",
        tier: 1,
        bodyMd: body,
      });
      const path = compiledNotePath("person", "Ordered Convergence", personId);
      await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${path}, 'Stale title', ${body}, 'wrong-hash', 1, 'brain-sync', 'human')`;
      const events: string[] = [];
      const archiveTarget = resolve(root, "brain", path);
      await mkdir(join(root, "brain", "derived", "notes", "person"), {
        recursive: true,
        mode: 0o700,
      });
      const result = await compileNotes({
        deps: {
          upsertPage: async (input, options) => {
            events.push("upsert");
            return repoUpsertPage(input, options);
          },
          updateHash: async (pageId, hash) => {
            events.push("hash");
            return setPageContentHash(pageId, hash);
          },
          writeArchive: async (archivePath, bytes) => {
            events.push("archive");
            return atomicWritePrivate(archivePath, bytes);
          },
          replaceIndex: async (pageId, pageBody, title, tier) => {
            events.push("index");
            return indexParent("page", pageId, pageBody, title, tier, {
              extractEdges: false,
              tierMode: "promote-page-floor",
            });
          },
          retierEdges: async (pageId, tier) => {
            events.push("retier");
            return retierPageEdges(pageId, tier);
          },
        },
      });
      expect(result.failed).toBe(0);
      expect(events).toEqual(["retier", "upsert", "hash", "archive", "index", "retier"]);
      expect(await readFile(archiveTarget, "utf8")).toBe(
        renderCompiledNoteArchive({ title: "Stale title", tier: 1, bodyMd: body }).text,
      );
    });
  });

  test("an injected no-op retier fails exact mixed dual-predicate edge verification", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Mixed Edge Floor", [2, 2, 2]);
      const sourceIds = await personSourceIds(personId);
      const body = `# Mixed Edge Floor\n\n${COMPILED_NOTE_MARKER}\n\nMixed edge facts.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({
        title: "Mixed Edge Floor",
        tier: 1,
        bodyMd: body,
      });
      const path = compiledNotePath("person", "Mixed Edge Floor", personId);
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${path}, 'Mixed Edge Floor', ${body}, ${archive.contentHash}, 1, ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR})
        returning id`;
      const [edgeA] = await sql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by)
        values ('page', ${page!.id}, 'mixed-a', 'person', ${personId}, 'pages', ${page!.id}, 1, 'test:mixed') returning id`;
      await sql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, tier, extracted_by)
        values ('page', ${page!.id}, 'mixed-b', 'person', ${personId}, 1, 'test:mixed')`;
      await sql`update edges set tier = 2 where id = ${edgeA!.id}`;
      const result = await compileNotes({ deps: { retierEdges: async () => 0 } });
      expect(result.failed).toBe(1);
      expect(result.results[0]!.code).toBe("verification_failed");
      const edges = await sql`
        select tier from edges
        where (source_table = 'pages' and source_id = ${page!.id})
           or (src_type = 'page' and src_id = ${page!.id})`;
      expect(edges.length).toBeGreaterThanOrEqual(2);
      expect(edges.some((edge) => Number(edge.tier) === 1)).toBe(true);
    });
  });

  test("a recovery regular file replaced by a symlink is rejected before read", async () => {
    await withPrivateDataDir(async (root) => {
      const record = recoveryFixture("Recovery Record Swap", crypto.randomUUID(), 1);
      await writeCompiledNoteRecoveryRecord(record);
      const recordFile = join(compiledNoteRecoveryDir(), recoveryFilenameFor(record.target_path));
      const outsideDir = await mkdtemp(join(tmpdir(), "minime-h1-record-swap-"));
      const outside = join(outsideDir, "outside.json");
      await writeFile(outside, "outside record", { mode: 0o600 });
      await rm(recordFile);
      await symlink(outside, recordFile);
      const listing = await listCompiledNoteRecoveryRecords();
      expect(listing).toEqual([
        {
          valid: false,
          file: recoveryFilenameFor(record.target_path),
          filenameHash: opaqueTargetHash(recoveryFilenameFor(record.target_path)),
          code: "invalid_recovery_record",
        },
      ]);
      expect(await readFile(outside, "utf8")).toBe("outside record");
      expect(
        await stat(recordFile)
          .then(() => false)
          .catch(() => true),
      ).toBe(false);
      expect(root).toContain("minime-h1-recovery-");
    });
  });

  test("legacy recovery with missing current owner remains an identity conflict", async () => {
    await withPrivateDataDir(async () => {
      const personId = crypto.randomUUID();
      await sql`insert into people (id, canonical_name, tier) values (${personId}, 'Legacy Missing Owner', 1)`;
      const record = await recoveryWithVerifiablePersonSource(
        recoveryFixture("Legacy Missing Owner", personId, 1),
        personId,
        "Legacy Missing Owner",
      );
      const body = `# Legacy Missing Owner\n\n${COMPILED_NOTE_MARKER}\n\nMissing owner.\n\n## Sources\n- ${crypto.randomUUID()}`;
      const archive = renderCompiledNoteArchive({ title: record.title, tier: 1, bodyMd: body });
      const path = "legacy/legacy-missing-owner.md";
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${path}, ${record.title}, ${body}, ${archive.contentHash}, 1, ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR})
        returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...record,
        target_path: path,
        expected_page_id: page!.id,
      });
      const result = await compileNotes();
      expect(result.failed).toBe(1);
      expect(result.results[0]!.code).toBe("identity_conflict");
      const [after] = await sql`select source, body_md from pages where id = ${page!.id}`;
      expect(after).toEqual({ source: COMPILED_NOTE_SOURCE, body_md: body });
    });
  });

  test("recovery conflict does not suppress an eligible canonical candidate", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Conflict Candidate");
      const sourceIds = await personSourceIds(personId);
      const record = recoveryWithFacts(
        {
          ...recoveryFixture("Conflict Candidate", personId, 1),
          derived_from: sourceIds[0]!,
          source_chunk_ids: sourceIds,
        },
        "Conflict Candidate recovery facts.",
      );
      const conflictBody = "# Human Conflict\n\nHuman replacement.";
      const conflictPath = "legacy/conflict-candidate.md";
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${conflictPath}, 'Human Conflict', ${conflictBody}, 'human-hash', 1, 'human', 'human')
        returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...record,
        target_path: conflictPath,
        expected_page_id: page!.id,
      });
      const result = await compileNotes();
      expect(result.results.some((item) => item.code === "identity_conflict")).toBe(true);
      expect(result.created + result.updated + result.repaired).toBe(1);
      const [canonical] = await sql`
        select source, created_by from pages
        where path = ${record.target_path}`;
      expect(canonical).toEqual({
        source: COMPILED_NOTE_SOURCE,
        created_by: COMPILED_NOTE_CREATOR,
      });
      const [human] = await sql`select source, body_md from pages where id = ${page!.id}`;
      expect(human).toEqual({ source: "human", body_md: conflictBody });
      expect(sourceIds).toHaveLength(3);
    });
  });

  test("a human canonical UUID occupant is not claimed by path recognition", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Human UUID Occupant");
      const path = compiledNotePath("person", "Human UUID Occupant", personId);
      const humanBody = "# Human UUID Occupant\n\nHuman-owned text.";
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${path}, 'Human UUID Occupant', ${humanBody}, 'human-hash', 1, 'human', 'human')
        returning id`;
      const result = await compileNotes();
      expect(result.failed).toBe(1);
      expect(result.results[0]!.code).toBe("identity_conflict");
      const [after] =
        await sql`select source, created_by, body_md from pages where id = ${page!.id}`;
      expect(after).toEqual({ source: "human", created_by: "human", body_md: humanBody });
    });
  });

  test("a conflicting recovery is atomically superseded before canonical writes", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Superseded Conflict");
      const sourceIds = await personSourceIds(personId);
      const record = recoveryWithFacts(
        {
          ...recoveryFixture("Superseded Conflict", personId, 1),
          derived_from: sourceIds[0]!,
          source_chunk_ids: sourceIds,
        },
        "Superseded Conflict recovery facts.",
      );
      const conflictPath = "legacy/superseded-conflict.md";
      const conflictBody = "# Human conflict\n\nHuman-owned replacement.";
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${conflictPath}, 'Human conflict', ${conflictBody}, 'human-hash', 1, 'human', 'human')
        returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...record,
        target_path: conflictPath,
        expected_page_id: page!.id,
      });
      const events: string[] = [];
      const result = await compileNotes({
        deps: {
          distill: async () => "Superseded Conflict: canonical candidate.",
          writeRecovery: async (next) => {
            events.push("writeRecovery");
            return writeCompiledNoteRecoveryRecord(next);
          },
          upsertPage: async (input, options) => {
            events.push("upsert");
            return repoUpsertPage(input, options);
          },
        },
      });
      expect(result.results.some((item) => item.code === "identity_conflict")).toBe(true);
      expect(result.created + result.updated + result.repaired).toBe(1);
      expect(events[0]).toBe("writeRecovery");
      expect(events.indexOf("writeRecovery")).toBeLessThan(events.indexOf("upsert"));
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
      const [human] = await sql`select source, body_md from pages where id = ${page!.id}`;
      expect(human).toEqual({ source: "human", body_md: conflictBody });
    });
  });

  test("an unverifiable recovery blocks the same-entity candidate for one invocation", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Supersession Retry");
      const record = recoveryFixture("Supersession Retry", personId, 1);
      const conflictPath = "legacy/supersession-retry.md";
      const conflictBody = "# Human retry conflict\n\nHuman-owned replacement.";
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${conflictPath}, 'Human retry conflict', ${conflictBody}, 'human-hash', 1, 'human', 'human')
        returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...record,
        target_path: conflictPath,
        expected_page_id: page!.id,
      });
      let calls = 0;
      const failed = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Supersession Retry: durable candidate.";
          },
          upsertPage: async () => {
            throw new Error("canonical page unavailable");
          },
        },
      });
      expect(failed.failed).toBe(1);
      expect(failed.results.some((item) => item.code === "source_evidence_unverifiable")).toBe(
        true,
      );
      expect(calls).toBe(0);
      const retained = (await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid);
      expect(retained).toHaveLength(0);
      const retried = await compileNotes({
        deps: {
          distill: async () => {
            calls++;
            return "Supersession Retry: durable candidate.";
          },
        },
      });
      expect(retried.failed).toBe(0);
      expect(retried.created).toBe(1);
      expect(calls).toBe(1);
      const [human] = await sql`select source, body_md from pages where id = ${page!.id}`;
      expect(human).toEqual({ source: "human", body_md: conflictBody });
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
    });
  });

  test("correction 3 fresh recovery that becomes stale during first convergence distills once afterward", async () => {
    await withPrivateDataDir(async () => {
      const name = "Post-convergence Freshness";
      const personId = await seedCandidate(name);
      const sourceIds = await personSourceIds(personId);
      const [freshness] = await sql`
        select max(created_at) as latest_mention_at
        from edges
        where rel = 'mentions' and dst_type = 'person' and dst_id = ${personId}`;
      const [firstSource] = await sql`
        select parent_id from chunks where id = ${sourceIds[0]!}`;
      const body = `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\nFresh recovery body.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({ title: name, tier: 1, bodyMd: body });
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture(name, personId, 1),
        body_md: body,
        source_chunk_ids: sourceIds,
        source_freshness_at: (freshness!.latest_mention_at as Date).toISOString(),
        derived_from: firstSource!.parent_id,
        archive_sha256: archive.contentHash,
      });
      let insertedSourceId: string | null = null;
      let retierCalls = 0;
      let modelCalls = 0;
      let distilledSourceCount = 0;
      const result = await compileNotes({
        deps: {
          retierEdges: async (pageId, tier) => {
            retierCalls++;
            const changed = await retierPageEdges(pageId, tier);
            if (retierCalls === 1) {
              insertedSourceId = (await addMentionSource(personId, name)).sourceChunkId;
            }
            return changed;
          },
          distill: async (_candidateName, chunks) => {
            modelCalls++;
            distilledSourceCount = chunks.length;
            return "Post-convergence Freshness: refreshed after convergence.";
          },
        },
      });
      expect(modelCalls).toBe(1);
      expect(distilledSourceCount).toBe(4);
      expect(result.created).toBe(1);
      expect(result.failed).toBe(0);
      const [page] = await sql`
        select body_md from pages
        where path = ${compiledNotePath("person", name, personId)}`;
      expect(page!.body_md).toContain("refreshed after convergence");
      expect(insertedSourceId).not.toBeNull();
      expect(parseCompiledNoteSourceIds(page!.body_md).ids).toContain(insertedSourceId!);
    });
  });

  test("correction 3 initially stale recovery below the current candidate threshold does not distill or supersede", async () => {
    await withPrivateDataDir(async () => {
      const name = "Post-convergence Threshold";
      const personId = await seedCandidate(name);
      const sourceIds = await personSourceIds(personId);
      const [firstSource] = await sql`
        select parent_id from chunks where id = ${sourceIds[0]!}`;
      const body = `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\nThreshold recovery body.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({ title: name, tier: 1, bodyMd: body });
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture(name, personId, 1),
        body_md: body,
        source_chunk_ids: sourceIds,
        source_freshness_at: "2000-01-01T00:00:00.000Z",
        derived_from: firstSource!.parent_id,
        archive_sha256: archive.contentHash,
      });
      let dropped = false;
      let modelCalls = 0;
      let supersedingWrites = 0;
      const result = await compileNotes({
        deps: {
          retierEdges: async (pageId, tier) => {
            const changed = await retierPageEdges(pageId, tier);
            if (!dropped) {
              dropped = true;
              await sql`
                delete from edges
                where rel = 'mentions' and dst_type = 'person' and dst_id = ${personId}
                  and source_table = 'chunks' and source_id = ${sourceIds[2]!}`;
            }
            return changed;
          },
          distill: async () => {
            modelCalls++;
            return "Post-convergence Threshold: must not be distilled.";
          },
          writeRecovery: async (record) => {
            supersedingWrites++;
            return writeCompiledNoteRecoveryRecord(record);
          },
        },
      });
      expect(modelCalls).toBe(0);
      expect(supersedingWrites).toBe(0);
      expect(result.created).toBe(1);
      expect(result.failed).toBe(0);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
    });
  });

  test("a cited Sources tier rise after the initial floor reconverges once and reports tier two", async () => {
    await withPrivateDataDir(async (root) => {
      const source = await seedSingleMentionSource("Post-floor Sources Rise");
      const record = recoveryFixture("Post-floor Sources Rise", source.personId, 1);
      const body = `# Post-floor Sources Rise\n\n${COMPILED_NOTE_MARKER}\n\nDurable source body.\n\n## Sources\n- ${source.sourceChunkId}`;
      const archive = renderCompiledNoteArchive({ title: record.title, tier: 1, bodyMd: body });
      const [targetPage] = await sql`
        insert into pages
          (path, title, body_md, content_hash, tier, source, created_by, derived_from)
        values (${record.target_path}, ${record.title}, ${body}, ${archive.contentHash}, 1,
                ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR}, ${source.sourcePageId})
        returning id`;
      await writeCompiledNoteRecoveryRecord({
        ...record,
        expected_page_id: targetPage!.id,
        body_md: body,
        derived_from: source.sourcePageId,
        source_chunk_ids: [source.sourceChunkId],
        archive_sha256: archive.contentHash,
      });
      let retierCalls = 0;
      let archiveWrites = 0;
      const result = await compileNotes({
        deps: {
          retierEdges: async (pageId, tier) => {
            retierCalls++;
            const changed = await retierPageEdges(pageId, tier);
            if (retierCalls === 2) {
              await sql`update chunks set tier = 2 where id = ${source.sourceChunkId}`;
            }
            return changed;
          },
          writeArchive: async (target, bytes) => {
            archiveWrites++;
            return atomicWritePrivate(target, bytes);
          },
        },
      });
      expect(result.repaired).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.results[0]!.tier).toBe(2);
      expect(retierCalls).toBe(4);
      expect(archiveWrites).toBe(2);
      const target = resolve(root, "brain", record.target_path);
      expect(parseCompiledNoteArchive(await readFile(target, "utf8"))?.tier).toBe(2);
      const [page] = await sql`select tier from pages where path = ${record.target_path}`;
      expect(page!.tier).toBe(2);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
    });
  });

  test("missing or newly unresolved final Sources block without a tier-two fallback", async () => {
    for (const mode of ["missing", "unresolved"] as const) {
      await resetDb();
      await withPrivateDataDir(async (root) => {
        const name = `Post-floor ${mode} Sources`;
        const source = await seedSingleMentionSource(name);
        const record = recoveryFixture(name, source.personId, 1);
        const body =
          mode === "missing"
            ? `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\nDurable source body.`
            : `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\nDurable source body.\n\n## Sources\n- ${source.sourceChunkId}`;
        const archive = renderCompiledNoteArchive({ title: name, tier: 1, bodyMd: body });
        await writeCompiledNoteRecoveryRecord({
          ...record,
          body_md: body,
          derived_from: source.sourcePageId,
          source_chunk_ids: [source.sourceChunkId],
          archive_sha256: archive.contentHash,
        });
        let retierCalls = 0;
        const result = await compileNotes({
          deps: {
            retierEdges: async (pageId, tier) => {
              retierCalls++;
              const changed = await retierPageEdges(pageId, tier);
              if (mode === "unresolved" && retierCalls === 1) {
                await sql`delete from chunks where id = ${source.sourceChunkId}`;
              }
              return changed;
            },
          },
        });
        expect(result.created).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.results[0]!.code).toBe("source_evidence_unverifiable");
        expect("tier" in result.results[0]!).toBe(false);
        const target = resolve(root, "brain", record.target_path);
        const pages =
          await sql`select id, tier, status from pages where path = ${record.target_path}`;
        if (mode === "missing") {
          expect(retierCalls).toBe(0);
          expect(pages).toHaveLength(0);
          expect(
            await stat(target)
              .then(() => true)
              .catch(() => false),
          ).toBe(false);
        } else {
          expect(retierCalls).toBe(1);
          expect(pages).toHaveLength(1);
          expect(pages[0]).toMatchObject({ tier: 0, status: "deleted" });
          const representations = await sql`
            select tier, embedding, embed_model from chunks
            where parent_type = 'page' and parent_id = ${pages[0]!.id}`;
          expect(representations.length).toBeGreaterThan(0);
          expect(
            representations.every(
              (chunk) => chunk.tier === 0 && chunk.embedding === null && chunk.embed_model === null,
            ),
          ).toBe(true);
          expect(parseCompiledNoteArchive(await readFile(target, "utf8"))?.tier).toBe(1);
        }
        expect(
          (await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid),
        ).toHaveLength(0);
      });
    }
  });

  test("correction 3 cluster-only post-floor recursive failure reports tier two and retains recovery", async () => {
    await withPrivateDataDir(async (root) => {
      const source = await seedSingleMentionSource("Post-floor Cluster Rise");
      const record = recoveryFixture("Post-floor Cluster Rise", source.personId, 1);
      const body = `# Post-floor Cluster Rise\n\n${COMPILED_NOTE_MARKER}\n\nDurable cluster body.\n\n## Sources\n- ${source.sourceChunkId}`;
      const archive = renderCompiledNoteArchive({ title: record.title, tier: 1, bodyMd: body });
      await writeCompiledNoteRecoveryRecord({
        ...record,
        body_md: body,
        derived_from: source.sourcePageId,
        source_chunk_ids: [source.sourceChunkId],
        archive_sha256: archive.contentHash,
      });
      let retierCalls = 0;
      let archiveWrites = 0;
      const first = await compileNotes({
        deps: {
          retierEdges: async (pageId, tier) => {
            retierCalls++;
            const changed = await retierPageEdges(pageId, tier);
            if (retierCalls === 1) {
              const [clusterPage] = await sql`
                insert into pages (path, title, body_md, content_hash, tier, source, created_by)
                values (${`post-floor/${crypto.randomUUID()}.md`}, 'Cluster-only source',
                        'Post-floor Cluster Rise private cluster fact.',
                        ${`cluster-${crypto.randomUUID()}`}, 2, 'test:h1-recovery', 'test:h1-recovery')
                returning id`;
              const [clusterChunk] = await sql`
                insert into chunks (parent_type, parent_id, ord, text, tier)
                values ('page', ${clusterPage!.id}, 0,
                        'Post-floor Cluster Rise private cluster fact.', 2)
                returning id`;
              await sql`
                insert into edges
                  (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier, extracted_by)
                values ('page', ${clusterPage!.id}, 'mentions', 'person', ${source.personId},
                        'chunks', ${clusterChunk!.id}, 2, 'test:post-floor-cluster')`;
            }
            return changed;
          },
          writeArchive: async (target, bytes) => {
            archiveWrites++;
            if (archiveWrites === 2) throw new Error("tier-two archive unavailable");
            return atomicWritePrivate(target, bytes);
          },
        },
      });
      expect(first.failed).toBe(1);
      expect(first.results[0]!.code).toBe("archive_rename_failed");
      expect(first.results[0]!.tier).toBe(2);
      expect(archiveWrites).toBe(2);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        1,
      );
      const retried = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("durable recovery retry must not distill");
          },
        },
      });
      expect(retried.repaired).toBe(1);
      expect(retried.failed).toBe(0);
      expect(retried.results[0]!.tier).toBe(2);
      expect(
        parseCompiledNoteArchive(await readFile(resolve(root, "brain", record.target_path), "utf8"))
          ?.tier,
      ).toBe(2);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
    });
  });

  test("correction 3 stale-recovery recursive phase failure preserves its code at tier two", async () => {
    await withPrivateDataDir(async () => {
      const name = "Stale Recursive Failure";
      const personId = await seedCandidate(name);
      const sourceIds = await personSourceIds(personId);
      const [firstSource] = await sql`
        select parent_id from chunks where id = ${sourceIds[0]!}`;
      const body = `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\nStale recovery body.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({ title: name, tier: 1, bodyMd: body });
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture(name, personId, 1),
        body_md: body,
        source_chunk_ids: sourceIds,
        source_freshness_at: "2000-01-01T00:00:00.000Z",
        derived_from: firstSource!.parent_id,
        archive_sha256: archive.contentHash,
      });
      let retierCalls = 0;
      let clusterInserted = false;
      let modelCalls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            return "Stale Recursive Failure: refreshed durable body.";
          },
          retierEdges: async (pageId, tier) => {
            retierCalls++;
            const changed = await retierPageEdges(pageId, tier);
            if (retierCalls === 3 && !clusterInserted) {
              clusterInserted = true;
              await addMentionSource(personId, name, 2);
            }
            return changed;
          },
          writeArchive: async (target, bytes) => {
            const next = parseCompiledNoteArchive(Buffer.from(bytes).toString("utf8"));
            if (next?.tier === 2) throw new Error("tier-two stale archive unavailable");
            return atomicWritePrivate(target, bytes);
          },
        },
      });
      expect(modelCalls).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.results[0]!.code).toBe("archive_rename_failed");
      expect(result.results[0]!.tier).toBe(2);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        1,
      );
    });
  });

  test("correction 3 exact existing recovery cleanup is unchanged with zero target writes", async () => {
    await withPrivateDataDir(async (root) => {
      const name = "Exact Recovery Cleanup";
      const source = await seedSingleMentionSource(name);
      const body = `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\nExact recovery body.\n\n## Sources\n- ${source.sourceChunkId}`;
      const path = compiledNotePath("person", name, source.personId);
      const archive = renderCompiledNoteArchive({ title: name, tier: 1, bodyMd: body });
      const [page] = await sql`
        insert into pages
          (path, title, body_md, content_hash, tier, source, created_by, derived_from)
        values (${path}, ${name}, ${body}, ${archive.contentHash}, 1,
                ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR}, ${source.sourcePageId})
        returning id`;
      await indexParent("page", page!.id, body, name, 1, {
        extractEdges: false,
        tierMode: "promote-page-floor",
      });
      const target = resolve(root, "brain", path);
      await mkdir(resolve(root, "brain", "derived", "notes", "person"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(target, archive.text, { mode: 0o600 });
      await writeCompiledNoteRecoveryRecord({
        ...recoveryFixture(name, source.personId, 1),
        expected_page_id: page!.id,
        body_md: body,
        source_chunk_ids: [source.sourceChunkId],
        derived_from: source.sourcePageId,
        archive_sha256: archive.contentHash,
      });
      let targetWrites = 0;
      let retierMutations = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("exact recovery cleanup must not distill");
          },
          upsertPage: async (input, options) => {
            targetWrites++;
            return repoUpsertPage(input, options);
          },
          updateHash: async (pageId, hash) => {
            targetWrites++;
            return setPageContentHash(pageId, hash);
          },
          writeArchive: async (archiveTarget, bytes) => {
            targetWrites++;
            return atomicWritePrivate(archiveTarget, bytes);
          },
          replaceIndex: async (pageId, nextBody, title, tier) => {
            targetWrites++;
            return indexParent("page", pageId, nextBody, title, tier, {
              extractEdges: false,
              tierMode: "promote-page-floor",
            });
          },
          retierEdges: async (pageId, tier) => {
            const changed = await retierPageEdges(pageId, tier);
            retierMutations += changed;
            return changed;
          },
        },
      });
      expect(result.unchanged).toBe(1);
      expect(result.repaired).toBe(0);
      expect(result.failed).toBe(0);
      expect(targetWrites).toBe(0);
      expect(retierMutations).toBe(0);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
      expect(await readFile(target, "utf8")).toBe(archive.text);
    });
  });

  test("correction 3 one page-less rename reacquires the new target lease and writes only the new path", async () => {
    await withPrivateDataDir(async (root) => {
      const initialName = "First Lease Name";
      const renamedName = "First Lease Renamed";
      const personId = await seedCandidate(initialName);
      await sql`
        insert into person_aliases (person_id, alias)
        values (${personId}, ${initialName})`;
      const initialPath = compiledNotePath("person", initialName, personId);
      const renamedPath = compiledNotePath("person", renamedName, personId);
      const initialHolder = await holdCompiledTargetLease(initialPath);
      const renamedHolder = await holdCompiledTargetLease(renamedPath);
      let modelCalls = 0;
      let finished = false;
      const pending = compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            return "First Lease Renamed: durable fact.";
          },
        },
      }).then((value) => {
        finished = true;
        return value;
      });
      let sawInitialWaiter = false;
      let sawRenamedWaiter = false;
      let modelCallsBeforeRenamedRelease = -1;
      let finishedBeforeRenamedRelease = true;
      let result!: Awaited<ReturnType<typeof compileNotes>>;
      try {
        sawInitialWaiter = await observeTargetLeaseWaiter(initialPath);
        await sql`update people set canonical_name = ${renamedName} where id = ${personId}`;
        initialHolder.release();
        sawRenamedWaiter = await observeTargetLeaseWaiter(renamedPath);
        modelCallsBeforeRenamedRelease = modelCalls;
        finishedBeforeRenamedRelease = finished;
        renamedHolder.release();
        result = await pending;
      } finally {
        initialHolder.release();
        renamedHolder.release();
        await Promise.all([initialHolder.done, renamedHolder.done]);
      }
      const [page] =
        await sql`select path, title from pages where source = ${COMPILED_NOTE_SOURCE}`;
      const archiveExists = async (path: string): Promise<boolean> => {
        try {
          await stat(resolve(root, "brain", path));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      };
      expect(sawInitialWaiter).toBe(true);
      expect(sawRenamedWaiter).toBe(true);
      expect(modelCallsBeforeRenamedRelease).toBe(0);
      expect(finishedBeforeRenamedRelease).toBe(false);
      expect(modelCalls).toBe(1);
      expect(result!.created).toBe(1);
      expect(result!.results[0]!.target_hash).toBe(opaqueTargetHash(renamedPath));
      expect(page).toEqual({ path: renamedPath, title: renamedName });
      expect(await archiveExists(initialPath)).toBe(false);
      expect(await archiveExists(renamedPath)).toBe(true);
    });
  });

  test("correction 3 a page appearing under the first lease pins that original target", async () => {
    await withPrivateDataDir(async (root) => {
      const initialName = "Appearing Page Initial";
      const renamedName = "Appearing Page Renamed";
      const personId = await seedCandidate(initialName);
      await sql`
        insert into person_aliases (person_id, alias)
        values (${personId}, ${initialName})`;
      const sourceIds = await personSourceIds(personId);
      const [firstSource] = await sql`
        select parent_id from chunks where id = ${sourceIds[0]!}`;
      const initialPath = compiledNotePath("person", initialName, personId);
      const renamedPath = compiledNotePath("person", renamedName, personId);
      const initialHolder = await holdCompiledTargetLease(initialPath);
      const renamedHolder = await holdCompiledTargetLease(renamedPath);
      let modelCalls = 0;
      let finished = false;
      const pending = compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            return "Appearing Page Renamed: must not be distilled.";
          },
        },
      }).then((value) => {
        finished = true;
        return value;
      });
      let sawInitialWaiter = false;
      let sawRenamedWaiter = false;
      let finishedBeforeRenamedRelease = false;
      let result: Awaited<ReturnType<typeof compileNotes>>;
      try {
        sawInitialWaiter = await observeTargetLeaseWaiter(initialPath);
        const body = `# ${initialName}\n\n${COMPILED_NOTE_MARKER}\n\nAppearing page durable body.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
        const archive = renderCompiledNoteArchive({ title: initialName, tier: 1, bodyMd: body });
        const [page] = await sql`
          insert into pages
            (path, title, body_md, content_hash, tier, source, created_by, derived_from)
          values (${initialPath}, ${initialName}, ${body}, ${archive.contentHash}, 1,
                  ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR}, ${firstSource!.parent_id})
          returning id`;
        await indexParent("page", page!.id, body, initialName, 1, {
          extractEdges: false,
          tierMode: "promote-page-floor",
        });
        await mkdir(resolve(root, "brain", "derived", "notes", "person"), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(resolve(root, "brain", initialPath), archive.text, { mode: 0o600 });
        await sql`update people set canonical_name = ${renamedName} where id = ${personId}`;
        initialHolder.release();
        sawRenamedWaiter = await observeTargetLeaseWaiter(renamedPath);
        finishedBeforeRenamedRelease = finished;
        renamedHolder.release();
        result = await pending;
      } finally {
        initialHolder.release();
        renamedHolder.release();
        await Promise.all([initialHolder.done, renamedHolder.done]);
      }
      const pages = await sql`
        select path, title from pages
        where source = ${COMPILED_NOTE_SOURCE}
        order by path`;
      expect(sawInitialWaiter).toBe(true);
      expect(sawRenamedWaiter).toBe(false);
      expect(finishedBeforeRenamedRelease).toBe(true);
      expect(modelCalls).toBe(0);
      expect(result!.unchanged).toBe(1);
      expect(result!.results[0]!.target_hash).toBe(opaqueTargetHash(initialPath));
      expect([...pages]).toEqual([{ path: initialPath, title: initialName }]);
    });
  });

  test("critical closure rejects a human page materialized under the first candidate lease", async () => {
    await withPrivateDataDir(async (root) => {
      const initialName = "Reload Ownership Initial";
      const renamedName = "Reload Ownership Renamed";
      const personId = await seedCandidate(initialName);
      await sql`
        insert into person_aliases (person_id, alias)
        values (${personId}, ${initialName})`;
      const initialPath = compiledNotePath("person", initialName, personId);
      const renamedPath = compiledNotePath("person", renamedName, personId);
      const initialTarget = resolve(root, "brain", initialPath);
      const renamedTarget = resolve(root, "brain", renamedPath);
      const initialHolder = await holdCompiledTargetLease(initialPath);
      const renamedHolder = await holdCompiledTargetLease(renamedPath);
      const calls = {
        model: 0,
        recovery: 0,
        page: 0,
        hash: 0,
        edge: 0,
        archive: 0,
        index: 0,
      };
      const pending = compileNotes({
        deps: {
          distill: async () => {
            calls.model++;
            return "Reload Ownership Renamed: must not replace human content.";
          },
          writeRecovery: async (record) => {
            calls.recovery++;
            return writeCompiledNoteRecoveryRecord(record);
          },
          upsertPage: async (input, options) => {
            calls.page++;
            return repoUpsertPage(input, options);
          },
          updateHash: async (pageId, hash) => {
            calls.hash++;
            return setPageContentHash(pageId, hash);
          },
          retierEdges: async (pageId, tier) => {
            calls.edge++;
            return retierPageEdges(pageId, tier);
          },
          writeArchive: async (target, bytes) => {
            calls.archive++;
            return atomicWritePrivate(target, bytes);
          },
          replaceIndex: async (pageId, body, title, tier) => {
            calls.index++;
            return indexParent("page", pageId, body, title, tier, {
              extractEdges: false,
              tierMode: "promote-page-floor",
            });
          },
        },
      });
      let sawInitialWaiter = false;
      let sawRenamedWaiter = false;
      let humanPageId = "";
      let tupleBefore: Record<string, unknown> | undefined;
      let fileBefore:
        | { bytes: string; ino: number; size: number; mode: number; mtimeMs: number }
        | undefined;
      let result: Awaited<ReturnType<typeof compileNotes>>;
      try {
        sawInitialWaiter = await observeTargetLeaseWaiter(initialPath);
        const humanBody =
          "# Human collision\n\nThis file is owned by a person, not the compiled-note pipeline.";
        const [humanPage] = await sql`
          insert into pages
            (path, title, body_md, content_hash, tier, source, created_by)
          values (${initialPath}, 'Human collision', ${humanBody}, 'human-reload-hash', 1,
                  'human', 'human')
          returning id`;
        humanPageId = humanPage!.id as string;
        await mkdir(resolve(root, "brain", "derived", "notes", "person"), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(initialTarget, humanBody, { mode: 0o600 });
        [tupleBefore] =
          await sql`select *, xmin::text as xmin from pages where id = ${humanPageId}`;
        const initialStat = await stat(initialTarget);
        fileBefore = {
          bytes: (await readFile(initialTarget)).toString("hex"),
          ino: initialStat.ino,
          size: initialStat.size,
          mode: initialStat.mode,
          mtimeMs: initialStat.mtimeMs,
        };
        expect(
          await sql`select id from chunks where parent_type = 'page' and parent_id = ${humanPageId}`,
        ).toHaveLength(0);
        expect(
          await sql`
            select id from edges
            where (src_type = 'page' and src_id = ${humanPageId})
               or (source_table = 'pages' and source_id = ${humanPageId})`,
        ).toHaveLength(0);
        expect(
          (await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid),
        ).toHaveLength(0);
        await sql`update people set canonical_name = ${renamedName} where id = ${personId}`;
        initialHolder.release();
        sawRenamedWaiter = await observeTargetLeaseWaiter(renamedPath);
        renamedHolder.release();
        result = await pending;
      } finally {
        initialHolder.release();
        renamedHolder.release();
        await Promise.all([initialHolder.done, renamedHolder.done]);
      }
      const [tupleAfter] =
        await sql`select *, xmin::text as xmin from pages where id = ${humanPageId}`;
      const finalStat = await stat(initialTarget);
      const fileAfter = {
        bytes: (await readFile(initialTarget)).toString("hex"),
        ino: finalStat.ino,
        size: finalStat.size,
        mode: finalStat.mode,
        mtimeMs: finalStat.mtimeMs,
      };
      const renamedExists = await stat(renamedTarget)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
      expect(sawInitialWaiter).toBe(true);
      expect(sawRenamedWaiter).toBe(false);
      expect(result!.results[0]).toMatchObject({
        status: "failed",
        target_hash: opaqueTargetHash(initialPath),
        page_id: humanPageId,
        code: "identity_conflict",
        kind: "person",
        tier: 2,
      });
      expect(result!.failed).toBe(1);
      expect(calls).toEqual({
        model: 0,
        recovery: 0,
        page: 0,
        hash: 0,
        edge: 0,
        archive: 0,
        index: 0,
      });
      expect(tupleAfter).toEqual(tupleBefore);
      expect(fileAfter).toEqual(fileBefore);
      expect(
        parseCompiledNoteArchive(Buffer.from(fileAfter.bytes, "hex").toString("utf8")),
      ).toBeNull();
      expect(renamedExists).toBe(false);
      expect(
        await sql`select id from chunks where parent_type = 'page' and parent_id = ${humanPageId}`,
      ).toHaveLength(0);
      expect(
        await sql`
          select id from edges
          where (src_type = 'page' and src_id = ${humanPageId})
             or (source_table = 'pages' and source_id = ${humanPageId})`,
      ).toHaveLength(0);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
    });
  });

  test("correction 3 a second page-less rename exhausts the lease bound with zero writes", async () => {
    await withPrivateDataDir(async (root) => {
      const initialName = "Bounded Lease Initial";
      const secondName = "Bounded Lease Second";
      const latestName = "Bounded Lease Latest";
      const personId = await seedCandidate(initialName);
      await sql`
        insert into person_aliases (person_id, alias)
        values (${personId}, ${initialName})`;
      const initialPath = compiledNotePath("person", initialName, personId);
      const secondPath = compiledNotePath("person", secondName, personId);
      const latestPath = compiledNotePath("person", latestName, personId);
      const initialHolder = await holdCompiledTargetLease(initialPath);
      const secondHolder = await holdCompiledTargetLease(secondPath);
      let modelCalls = 0;
      let targetWrites = 0;
      const pending = compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            return "Bounded Lease Latest: must not be written.";
          },
          writeRecovery: async (record) => {
            targetWrites++;
            return writeCompiledNoteRecoveryRecord(record);
          },
          upsertPage: async (input, options) => {
            targetWrites++;
            return repoUpsertPage(input, options);
          },
          updateHash: async (pageId, hash) => {
            targetWrites++;
            return setPageContentHash(pageId, hash);
          },
          writeArchive: async (target, bytes) => {
            targetWrites++;
            return atomicWritePrivate(target, bytes);
          },
          replaceIndex: async (pageId, body, title, tier) => {
            targetWrites++;
            return indexParent("page", pageId, body, title, tier, {
              extractEdges: false,
              tierMode: "promote-page-floor",
            });
          },
          retierEdges: async (pageId, tier) => {
            targetWrites++;
            return retierPageEdges(pageId, tier);
          },
        },
      });
      let sawInitialWaiter = false;
      let sawSecondWaiter = false;
      let result: Awaited<ReturnType<typeof compileNotes>>;
      try {
        sawInitialWaiter = await observeTargetLeaseWaiter(initialPath);
        await sql`update people set canonical_name = ${secondName} where id = ${personId}`;
        initialHolder.release();
        sawSecondWaiter = await observeTargetLeaseWaiter(secondPath);
        await sql`update people set canonical_name = ${latestName} where id = ${personId}`;
        secondHolder.release();
        result = await pending;
      } finally {
        initialHolder.release();
        secondHolder.release();
        await Promise.all([initialHolder.done, secondHolder.done]);
      }
      const [pages] = await sql`
        select count(*)::int as count from pages where source = ${COMPILED_NOTE_SOURCE}`;
      const archiveExists = async (path: string): Promise<boolean> => {
        try {
          await stat(resolve(root, "brain", path));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      };
      expect(sawInitialWaiter).toBe(true);
      expect(sawSecondWaiter).toBe(true);
      expect(modelCalls).toBe(0);
      expect(targetWrites).toBe(0);
      expect(result!.failed).toBe(1);
      expect(result!.results[0]!.code).toBe("verification_failed");
      expect(result!.results[0]!.tier).toBe(2);
      expect(result!.results[0]!.target_hash).toBe(opaqueTargetHash(latestPath));
      expect(pages!.count).toBe(0);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
      expect(await archiveExists(initialPath)).toBe(false);
      expect(await archiveExists(secondPath)).toBe(false);
      expect(await archiveExists(latestPath)).toBe(false);
    });
  });

  test("a recovery that creates its missing canonical page reports created", async () => {
    await withPrivateDataDir(async () => {
      const personId = crypto.randomUUID();
      await sql`
        insert into people (id, canonical_name, tier)
        values (${personId}, 'Missing Recovery Page', 1)`;
      const record = await recoveryWithVerifiablePersonSource(
        recoveryFixture("Missing Recovery Page", personId, 1),
        personId,
        "Missing Recovery Page",
      );
      await writeCompiledNoteRecoveryRecord(record);
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("recovery-only creation must not distill");
          },
        },
      });
      expect(result.created).toBe(1);
      expect(result.repaired).toBe(0);
      expect(result.results[0]!.status).toBe("created");
    });
  });

  test("a stale recovery that creates its missing page remains created after redistillation", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Stale Missing Recovery Page");
      const sourceIds = await personSourceIds(personId);
      const record = recoveryFixture("Stale Missing Recovery Page", personId, 1);
      const body = `# Stale Missing Recovery Page\n\n${COMPILED_NOTE_MARKER}\n\nStale durable body.\n\n## Sources\n${sourceIds.map((id) => `- ${id}`).join("\n")}`;
      const archive = renderCompiledNoteArchive({ title: record.title, tier: 1, bodyMd: body });
      const [firstSource] = await sql`
        select parent_id from chunks where id = ${sourceIds[0]!}`;
      await writeCompiledNoteRecoveryRecord({
        ...record,
        body_md: body,
        derived_from: firstSource!.parent_id,
        source_chunk_ids: sourceIds,
        source_freshness_at: "2000-01-01T00:00:00.000Z",
        archive_sha256: archive.contentHash,
      });
      let modelCalls = 0;
      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            return "Stale Missing Recovery Page: refreshed durable body.";
          },
        },
      });
      expect(modelCalls).toBe(1);
      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.repaired).toBe(0);
      expect(result.results.find((entry) => entry.status !== "failed")!.status).toBe("created");
    });
  });

  test("tier-only prepromotion is counted as a repair", async () => {
    await withPrivateDataDir(async (root) => {
      const source = await seedSingleMentionSource("Tier-only Prepromotion", 2);
      const body = `# Tier-only Prepromotion\n\n${COMPILED_NOTE_MARKER}\n\nAlready aligned body.\n\n## Sources\n- ${source.sourceChunkId}`;
      const path = compiledNotePath("person", "Tier-only Prepromotion", source.personId);
      const archive = renderCompiledNoteArchive({
        title: "Tier-only Prepromotion",
        tier: 2,
        bodyMd: body,
      });
      const [page] = await sql`
        insert into pages
          (path, title, body_md, content_hash, tier, source, created_by, derived_from)
        values (${path}, 'Tier-only Prepromotion', ${body}, ${archive.contentHash}, 1,
                ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR}, ${source.sourcePageId})
        returning id`;
      await indexParent("page", page!.id, body, "Tier-only Prepromotion", 2, {
        extractEdges: false,
        tierMode: "promote-page-floor",
      });
      const target = resolve(root, "brain", path);
      await mkdir(resolve(root, "brain", "derived", "notes", "person"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(target, archive.text, { mode: 0o600 });
      const result = await compileNotes({
        deps: {
          distill: async () => {
            throw new Error("tier-only repair must not distill");
          },
        },
      });
      expect(result.repaired).toBe(1);
      expect(result.unchanged).toBe(0);
      expect(result.results[0]!.status).toBe("repaired");
      const [after] = await sql`select tier from pages where id = ${page!.id}`;
      expect(after!.tier).toBe(2);
    });
  });

  test("the private no-follow reader returns exact regular-file bytes", async () => {
    await withPrivateDataDir(async (root) => {
      const module = await import("../src/pipeline/compiled-note-recovery");
      const reader = (
        module as typeof module & {
          readPrivateRegularFileNoFollow?: (
            trustedRoot: string,
            target: string,
          ) => Promise<Uint8Array>;
        }
      ).readPrivateRegularFileNoFollow;
      expect(reader).toBeFunction();
      if (!reader) return;
      const target = resolve(root, "brain", "safe-read.md");
      await mkdir(resolve(root, "brain"), { recursive: true, mode: 0o700 });
      await writeFile(target, "safe archive bytes", { mode: 0o600 });
      expect(Buffer.from(await reader(root, target)).toString("utf8")).toBe("safe archive bytes");
    });
  });

  test("the private no-follow reader rejects a symlink without touching outside bytes", async () => {
    await withPrivateDataDir(async (root) => {
      const module = await import("../src/pipeline/compiled-note-recovery");
      const reader = (
        module as typeof module & {
          readPrivateRegularFileNoFollow?: (
            trustedRoot: string,
            target: string,
          ) => Promise<Uint8Array>;
        }
      ).readPrivateRegularFileNoFollow;
      expect(reader).toBeFunction();
      if (!reader) return;
      const outsideDir = await mkdtemp(join(tmpdir(), "minime-h1-safe-read-outside-"));
      const outside = resolve(outsideDir, "sentinel.md");
      const target = resolve(root, "brain", "unsafe-read.md");
      await mkdir(resolve(root, "brain"), { recursive: true, mode: 0o700 });
      await writeFile(outside, "outside sentinel", { mode: 0o600 });
      await symlink(outside, target);
      await expect(reader(root, target)).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe("outside sentinel");
      await rm(outsideDir, { recursive: true, force: true });
    });
  });

  test("exclusive install retries a collision between scan and publish", async () => {
    await withPrivateDataDir(async () => {
      const record = recoveryFixture("Exclusive Publish Collision", crypto.randomUUID(), 1);
      const collisionPath = join(
        compiledNoteRecoveryDir(),
        recoveryGenerationFilenameFor(record, 0),
      );
      const sentinel = Buffer.from("exclusive collision sentinel");
      let writes = 0;
      let collisionBefore: { bytes: Buffer; inode: number; mode: number } | undefined;

      const written = await writeRecoveryWithSeam(record, {
        writePrivate: async (target, bytes) => {
          writes++;
          await atomicWritePrivate(target, bytes);
          if (writes === 1) {
            await writeFile(collisionPath, sentinel, { flag: "wx", mode: 0o640 });
            await chmod(collisionPath, 0o640);
            collisionBefore = await recoveryFileSnapshot(collisionPath);
          }
        },
      });

      expect(writes).toBe(2);
      expect(written.file).toBe(recoveryGenerationFilenameFor(record, 1));
      expect(collisionBefore).toEqual({ bytes: sentinel, inode: expect.any(Number), mode: 0o640 });
      if (!collisionBefore) throw new Error("expected collision snapshot");
      expect(await recoveryFileSnapshot(collisionPath)).toEqual(collisionBefore);
      expect(
        (await listCompiledNoteRecoveryRecords()).filter(
          (listing) => listing.valid && listing.record.entity_id === record.entity_id,
        ),
      ).toEqual([
        {
          valid: true,
          file: recoveryGenerationFilenameFor(record, 1),
          filenameHash: opaqueTargetHash(recoveryGenerationFilenameFor(record, 1)),
          record,
        },
      ]);
    });
  });

  test("pre-publish failure exposes no empty parseable generation", async () => {
    await withPrivateDataDir(async () => {
      const original = recoveryFixture("Pre Publish Occupant", crypto.randomUUID(), 1);
      const replacement = recoveryWithFacts(original, "Pre-publish replacement facts.");
      const occupied = await writeCompiledNoteRecoveryRecord(original);
      const occupiedPath = join(compiledNoteRecoveryDir(), occupied.file);
      const occupiedBefore = await recoveryFileSnapshot(occupiedPath);
      let observedTarget = "";

      await expect(
        writeRecoveryWithSeam(replacement, {
          writePrivate: async (target) => {
            observedTarget = target;
            await writeFile(target, "partial staging bytes", { mode: 0o600 });
            throw new Error("pre-publish fixture failure");
          },
        }),
      ).rejects.toThrow("RECOVERY_GENERATION_PUBLISH_FAILED");

      expect(
        /^(person|org)--[0-9a-f-]+\.v1(?:\.g[0-9]{16})?\.json$/.test(basename(observedTarget)),
      ).toBe(false);
      expect(
        await stat(observedTarget)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      expect(await recoveryFileSnapshot(occupiedPath)).toEqual(occupiedBefore);
      const parseable = (await readdir(compiledNoteRecoveryDir())).filter((file) =>
        /^(person|org)--[0-9a-f-]+\.v1(?:\.g[0-9]{16})?\.json$/.test(file),
      );
      expect(parseable).toEqual([occupied.file]);
      for (const file of parseable) {
        expect((await stat(join(compiledNoteRecoveryDir(), file))).size).toBeGreaterThan(0);
      }
    });
  });

  test("pre-publish staging rejection preserves generation zero and leaves no newer generation", async () => {
    await withPrivateDataDir(async () => {
      const original = recoveryFixture("Generation Install Failure", crypto.randomUUID(), 1);
      const replacement = recoveryWithFacts(original, "Replacement generation facts.");
      const generationZero = await writeCompiledNoteRecoveryRecord(original);
      const generationZeroPath = join(compiledNoteRecoveryDir(), generationZero.file);
      const originalBytes = await readFile(generationZeroPath);
      const originalMode = (await stat(generationZeroPath)).mode & 0o777;

      await expect(
        writeRecoveryWithSeam(replacement, {
          writePrivate: async (target, bytes) => {
            await atomicWritePrivate(target, bytes);
            throw new Error("post-install directory sync rejected");
          },
        }),
      ).rejects.toThrow("RECOVERY_GENERATION_PUBLISH_FAILED");

      expect(await readFile(generationZeroPath)).toEqual(originalBytes);
      expect((await stat(generationZeroPath)).mode & 0o777).toBe(originalMode);
      expect(originalMode).toBe(0o600);
      const generationOnePath = join(
        compiledNoteRecoveryDir(),
        recoveryGenerationFilenameFor(replacement, 1),
      );
      expect(
        await stat(generationOnePath)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      const listings = await listCompiledNoteRecoveryRecords();
      expect(listings.filter((entry) => entry.valid)).toEqual([
        {
          valid: true,
          file: recoveryGenerationFilenameFor(original, 0),
          filenameHash: opaqueTargetHash(recoveryGenerationFilenameFor(original, 0)),
          record: original,
        },
      ]);
    });
  });

  test("listing emits only the highest valid generation for each entity", async () => {
    await withPrivateDataDir(async () => {
      const first = recoveryFixture("Highest Generation", crypto.randomUUID(), 1);
      const second = recoveryWithFacts(first, "Second generation facts.");
      const third = recoveryWithFacts(first, "Third generation facts.");
      const other = recoveryFixture("Other Generation Entity", crypto.randomUUID(), 2);
      await writeCompiledNoteRecoveryRecord(first);
      await writeCompiledNoteRecoveryRecord(second);
      await writeCompiledNoteRecoveryRecord(third);
      await writeCompiledNoteRecoveryRecord(other);

      const valid = (await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid);
      expect(valid).toHaveLength(2);
      expect(valid.find((entry) => entry.record.entity_id === first.entity_id)).toEqual({
        valid: true,
        file: recoveryGenerationFilenameFor(third, 2),
        filenameHash: opaqueTargetHash(recoveryGenerationFilenameFor(third, 2)),
        record: third,
      });
      expect(valid.find((entry) => entry.record.entity_id === other.entity_id)?.file).toBe(
        recoveryGenerationFilenameFor(other, 0),
      );
      expect(await readdir(compiledNoteRecoveryDir())).toEqual(
        expect.arrayContaining([
          recoveryGenerationFilenameFor(first, 0),
          recoveryGenerationFilenameFor(second, 1),
          recoveryGenerationFilenameFor(third, 2),
          recoveryGenerationFilenameFor(other, 0),
        ]),
      );
    });
  });

  test("compile blocks canonical writes after pre-publish rejection and redistills on retry", async () => {
    await withPrivateDataDir(async () => {
      const personId = await seedCandidate("Generation Supersession Retry");
      const sourceIds = await personSourceIds(personId);
      const oldRecord = recoveryWithFacts(
        {
          ...recoveryFixture("Generation Supersession Retry", personId, 1),
          derived_from: sourceIds[0]!,
          source_chunk_ids: sourceIds,
        },
        "Generation Supersession Retry recovery facts.",
      );
      const legacyPath = "legacy/generation-supersession-retry.md";
      const humanBody = "# Human generation conflict\n\nHuman-owned replacement.";
      const [humanPage] = await sql`
        insert into pages (path, title, body_md, content_hash, tier, source, created_by)
        values (${legacyPath}, 'Human generation conflict', ${humanBody}, 'human-hash', 1,
                'human', 'human')
        returning id`;
      const generationZero = await writeCompiledNoteRecoveryRecord({
        ...oldRecord,
        target_path: legacyPath,
        expected_page_id: humanPage!.id,
      });
      const generationZeroPath = join(compiledNoteRecoveryDir(), generationZero.file);
      const generationZeroBytes = await readFile(generationZeroPath);
      let modelCalls = 0;
      let canonicalWrites = 0;
      const first = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            return "Generation Supersession Retry: durable candidate.";
          },
          writeRecovery: async (next) =>
            writeRecoveryWithSeam(next, {
              writePrivate: async (target, bytes) => {
                await atomicWritePrivate(target, bytes);
                throw new Error("post-install generation rejection");
              },
            }),
          upsertPage: async (input, options) => {
            canonicalWrites++;
            return repoUpsertPage(input, options);
          },
          updateHash: async (pageId, hash) => {
            canonicalWrites++;
            return setPageContentHash(pageId, hash);
          },
          writeArchive: async (target, bytes) => {
            canonicalWrites++;
            return atomicWritePrivate(target, bytes);
          },
          replaceIndex: async (pageId, body, title, tier) => {
            canonicalWrites++;
            return indexParent("page", pageId, body, title, tier, {
              extractEdges: false,
              tierMode: "promote-page-floor",
            });
          },
          retierEdges: async (pageId, tier) => {
            canonicalWrites++;
            return retierPageEdges(pageId, tier);
          },
        },
      });
      expect(first.results.some((entry) => entry.code === "recovery_write_failed")).toBe(true);
      expect(canonicalWrites).toBe(0);
      expect(await readFile(generationZeroPath)).toEqual(generationZeroBytes);
      const persisted = (await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.file).toBe(generationZero.file);
      expect(persisted[0]!.record.target_path).toBe(legacyPath);
      const [beforeRetry] = await sql`
        select count(*)::int as n from pages
        where path = ${compiledNotePath("person", "Generation Supersession Retry", personId)}`;
      expect(beforeRetry!.n).toBe(0);

      const retried = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            return "Generation Supersession Retry: durable retry.";
          },
        },
      });
      expect(retried.created).toBe(1);
      expect(retried.failed).toBe(1);
      expect(modelCalls).toBe(2);
      expect((await listCompiledNoteRecoveryRecords()).filter((entry) => entry.valid)).toHaveLength(
        0,
      );
      expect(await readdir(compiledNoteRecoveryDir())).toHaveLength(0);
      const [humanAfter] = await sql`select body_md, source from pages where id = ${humanPage!.id}`;
      expect(humanAfter).toEqual({ body_md: humanBody, source: "human" });
    });
  });

  test("invalid higher generations are opaque and occupied while the next write skips to generation two", async () => {
    await withPrivateDataDir(async () => {
      const first = recoveryFixture("Invalid Occupied Generation", crypto.randomUUID(), 1);
      const next = recoveryWithFacts(first, "Valid generation after invalid occupied bytes.");
      await writeCompiledNoteRecoveryRecord(first);
      const recoveryDir = compiledNoteRecoveryDir();
      const invalidGenerationOne = recoveryGenerationFilenameFor(first, 1);
      await writeFile(join(recoveryDir, invalidGenerationOne), "tier-2 invalid sentinel", {
        mode: 0o600,
      });
      const malformed = [
        `${first.entity_kind}--${first.entity_id}.v1.g0000000000000000.json`,
        `${first.entity_kind}--${first.entity_id}.v1.g9007199254740992.json`,
        `${first.entity_kind}--${first.entity_id}.v1.g000000000000001.json`,
      ];
      for (const file of malformed) await writeFile(join(recoveryDir, file), "{", { mode: 0o600 });

      const before = await listCompiledNoteRecoveryRecords();
      expect(before.filter((entry) => entry.valid)).toEqual([
        {
          valid: true,
          file: recoveryGenerationFilenameFor(first, 0),
          filenameHash: opaqueTargetHash(recoveryGenerationFilenameFor(first, 0)),
          record: first,
        },
      ]);
      expect(before.filter((entry) => !entry.valid)).toHaveLength(4);
      expect(JSON.stringify(before)).not.toContain("tier-2 invalid sentinel");

      const written = await writeCompiledNoteRecoveryRecord(next);
      expect(written.file).toBe(recoveryGenerationFilenameFor(next, 2));
      const after = await listCompiledNoteRecoveryRecords();
      expect(after.filter((entry) => !entry.valid)).toHaveLength(4);
      expect(after.filter((entry) => entry.valid)).toEqual([
        {
          valid: true,
          file: recoveryGenerationFilenameFor(next, 2),
          filenameHash: opaqueTargetHash(recoveryGenerationFilenameFor(next, 2)),
          record: next,
        },
      ]);
      expect(await readFile(join(recoveryDir, invalidGenerationOne), "utf8")).toBe(
        "tier-2 invalid sentinel",
      );
    });
  });

  test("cleanup removes valid lower generations before active and never removes invalid generations", async () => {
    await withPrivateDataDir(async () => {
      const first = recoveryFixture("Ordered Generation Cleanup", crypto.randomUUID(), 1);
      const second = recoveryWithFacts(first, "Second cleanup generation.");
      const third = recoveryWithFacts(first, "Active cleanup generation.");
      await writeCompiledNoteRecoveryRecord(first);
      await writeCompiledNoteRecoveryRecord(second);
      await writeCompiledNoteRecoveryRecord(third);
      const invalidFile = recoveryGenerationFilenameFor(first, 3);
      await writeFile(join(compiledNoteRecoveryDir(), invalidFile), "invalid cleanup sentinel", {
        mode: 0o600,
      });
      const listed = await listCompiledNoteRecoveryRecords();
      const active = listed.find((entry) => entry.valid);
      expect(active?.file).toBe(recoveryGenerationFilenameFor(third, 2));
      if (!active?.valid) throw new Error("expected active recovery generation");
      const activePath = join(compiledNoteRecoveryDir(), active.file);
      const activeBytes = await readFile(activePath);
      const outsideDir = await mkdtemp(join(tmpdir(), "minime-h1-generation-cleanup-"));
      const outside = join(outsideDir, "active.json");
      await writeFile(outside, activeBytes, { mode: 0o600 });
      await rm(activePath);
      await symlink(outside, activePath);

      await expect(removeCompiledNoteRecoveryRecord(active)).rejects.toThrow();
      const afterFailure = await readdir(compiledNoteRecoveryDir());
      expect(afterFailure).toContain(recoveryGenerationFilenameFor(first, 0));
      expect(afterFailure).toContain(recoveryGenerationFilenameFor(second, 1));
      expect(afterFailure).toContain(active.file);
      expect(afterFailure).toContain(invalidFile);
      expect(await readFile(outside, "utf8")).toBe(Buffer.from(activeBytes).toString("utf8"));

      await rm(activePath);
      await writeFile(activePath, activeBytes, { mode: 0o600 });
      await removeCompiledNoteRecoveryRecord(active);
      expect(await readdir(compiledNoteRecoveryDir())).toEqual([invalidFile]);
      expect(await readFile(join(compiledNoteRecoveryDir(), invalidFile), "utf8")).toBe(
        "invalid cleanup sentinel",
      );
      await rm(outsideDir, { recursive: true, force: true });
    });
  });

  test("active corruption preserves every lower valid recovery generation", async () => {
    await withPrivateDataDir(async () => {
      const first = recoveryFixture("Corrupt Active Cleanup", crypto.randomUUID(), 1);
      const second = recoveryWithFacts(first, "Second cleanup generation.");
      const third = recoveryWithFacts(first, "Active cleanup generation.");
      await writeCompiledNoteRecoveryRecord(first);
      await writeCompiledNoteRecoveryRecord(second);
      await writeCompiledNoteRecoveryRecord(third);
      const active = (await listCompiledNoteRecoveryRecords()).find((entry) => entry.valid);
      expect(active?.file).toBe(recoveryGenerationFilenameFor(third, 2));
      if (!active?.valid) throw new Error("expected active recovery generation");
      const activePath = join(compiledNoteRecoveryDir(), active.file);
      await writeFile(activePath, "corrupt active sentinel", { mode: 0o600 });

      await expect(removeCompiledNoteRecoveryRecord(active)).rejects.toThrow();

      expect(await readdir(compiledNoteRecoveryDir())).toEqual(
        expect.arrayContaining([
          recoveryGenerationFilenameFor(first, 0),
          recoveryGenerationFilenameFor(second, 1),
          recoveryGenerationFilenameFor(third, 2),
        ]),
      );
      const listings = await listCompiledNoteRecoveryRecords();
      expect(listings.filter((entry) => !entry.valid).map((entry) => entry.file)).toEqual([
        recoveryGenerationFilenameFor(third, 2),
      ]);
      expect(listings.filter((entry) => entry.valid)).toEqual([
        {
          valid: true,
          file: recoveryGenerationFilenameFor(second, 1),
          filenameHash: opaqueTargetHash(recoveryGenerationFilenameFor(second, 1)),
          record: second,
        },
      ]);
      expect(JSON.stringify(listings)).not.toContain("corrupt active sentinel");
      expect(await readFile(activePath, "utf8")).toBe("corrupt active sentinel");
    });
  });

  test("cleanup accepts a semantically identical active listing with reordered record keys", async () => {
    await withPrivateDataDir(async () => {
      const first = recoveryFixture("Reordered Active Listing", crypto.randomUUID(), 1);
      const second = recoveryWithFacts(first, "Active reordered listing generation.");
      await writeCompiledNoteRecoveryRecord(first);
      await writeCompiledNoteRecoveryRecord(second);
      const active = (await listCompiledNoteRecoveryRecords()).find((entry) => entry.valid);
      expect(active?.file).toBe(recoveryGenerationFilenameFor(second, 1));
      if (!active?.valid) throw new Error("expected active recovery generation");
      const reorderedRecord = Object.fromEntries(
        Object.entries(active.record).reverse(),
      ) as unknown as CompiledNoteRecoveryV1;

      await removeCompiledNoteRecoveryRecord({ ...active, record: reorderedRecord });

      expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
    });
  });

  test("one tier-zero candidate chunk is excluded before every model, recovery, archive, page, index, and egress write", async () => {
    await withPrivateDataDir(async (root) => {
      const name = "Zero Candidate Sentinel";
      const personId = await seedCandidate(name, [0, 1, 1]);
      const writes = { model: 0, recovery: 0, page: 0, archive: 0, index: 0 };
      const result = await compileNotes({
        deps: {
          distill: async (_name, chunks) => {
            writes.model++;
            expect(JSON.stringify(chunks)).not.toContain(name);
            return "must not run";
          },
          writeRecovery: async (record) => {
            writes.recovery++;
            return { valid: true, file: "unexpected.json", filenameHash: "unexpected", record };
          },
          upsertPage: async (input, options) => {
            writes.page++;
            return repoUpsertPage(input, options);
          },
          writeArchive: async () => {
            writes.archive++;
          },
          replaceIndex: async () => {
            writes.index++;
            return 0;
          },
        },
      });

      expect(writes).toEqual({ model: 0, recovery: 0, page: 0, archive: 0, index: 0 });
      expect(result.candidates).toBe(0);
      expect(result.results).toEqual([]);
      expect(
        await sql`select id from pages where source = ${COMPILED_NOTE_SOURCE} and derived_from = ${personId}`,
      ).toHaveLength(0);
      expect(await readdir(join(root, "tmp", "compiled-notes"))).toEqual([]);
      const [egress] = await sql`select count(*)::int as n from events where verb like 'egress:%'`;
      expect(egress!.n).toBe(0);
    });
  });

  test("a tier-zero source parent excludes otherwise tier-one evidence before every effect", async () => {
    await withPrivateDataDir(async (root) => {
      await expectCandidateEvidenceExcluded(root, "Zero Parent Evidence", {
        parentTiers: [0, 1, 1],
      });
    });
  });

  test("a tier-zero target entity excludes otherwise tier-one evidence before every effect", async () => {
    await withPrivateDataDir(async (root) => {
      await expectCandidateEvidenceExcluded(root, "Zero Entity Evidence", {
        entityTier: 0,
      });
    });
  });

  test("a tier-zero organization target blocks an otherwise valid recovery before target writes", async () => {
    await withPrivateDataDir(async () => {
      const name = "Zero Organization Evidence";
      const [org] = await sql`
        insert into orgs (canonical_name, tier) values (${name}, 0) returning id`;
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier)
        values ('evidence/zero-org.md', ${name}, ${`${name} source fact.`},
                'zero-org-source', 1)
        returning id`;
      const [chunk] = await sql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${page!.id}, 0, ${`${name} source fact.`}, 1)
        returning id`;
      await sql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values ('page', ${page!.id}, 'mentions', 'org', ${org!.id},
                'chunks', ${chunk!.id}, 1)`;
      const body =
        `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\nOrganization recovery.\n\n## Sources\n` +
        `- ${chunk!.id}`;
      const archive = renderCompiledNoteArchive({ title: name, tier: 1, bodyMd: body });
      const base = recoveryFixture(name, org!.id, 1);
      const record: CompiledNoteRecoveryV1 = {
        ...base,
        entity_kind: "org",
        target_path: compiledNotePath("org", name, org!.id),
        derived_from: page!.id,
        source_chunk_ids: [chunk!.id],
        body_md: body,
        archive_sha256: archive.contentHash,
      };
      await writeCompiledNoteRecoveryRecord(record);
      const writes = { remove: 0, model: 0, page: 0, archive: 0, index: 0 };

      const result = await compileNotes({
        deps: {
          removeRecovery: async (listing) => {
            writes.remove++;
            await removeCompiledNoteRecoveryRecord(listing);
          },
          distill: async () => {
            writes.model++;
            return "must not run";
          },
          upsertPage: async (input, options) => {
            writes.page++;
            return repoUpsertPage(input, options);
          },
          writeArchive: async () => {
            writes.archive++;
          },
          replaceIndex: async () => {
            writes.index++;
            return 0;
          },
        },
      });

      expect(writes).toEqual({ remove: 1, model: 0, page: 0, archive: 0, index: 0 });
      expect(result.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(record.target_path),
          code: "source_evidence_unverifiable",
          kind: "org",
        },
      ]);
      expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
      expect(await sql`select id from pages where path = ${record.target_path}`).toHaveLength(0);
    });
  });

  test("a tier-zero source introduced while waiting for the target lease blocks before the prompt", async () => {
    await withPrivateDataDir(async () => {
      const name = "Lease Race Sentinel";
      const personId = await seedCandidate(name, [1, 1, 2]);
      const targetPath = compiledNotePath("person", name, personId);
      const held = await holdCompiledTargetLease(targetPath);
      let modelCalls = 0;
      const pending = compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            return "must not run";
          },
        },
      });
      expect(await observeTargetLeaseWaiter(targetPath)).toBe(true);
      const sourceId = (await personSourceIds(personId))[0]!;
      await sql`update chunks set tier = 0 where id = ${sourceId}`;
      await sql`
        update edges set tier = 0
        where rel = 'mentions' and dst_type = 'person' and dst_id = ${personId}
          and source_table = 'chunks' and source_id = ${sourceId}`;
      held.release();
      await held.done;

      const result = await pending;
      expect(modelCalls).toBe(0);
      expect(result.results).toContainEqual({
        status: "failed",
        target_hash: opaqueTargetHash(targetPath),
        code: "identity_conflict",
        kind: "person",
        tier: 2,
      });
    });
  });

  test("accepted mention-edge tiers participate in routing and tier zero remains absorbing", async () => {
    await withPrivateDataDir(async () => {
      const highName = "Edge Two Routing";
      const zeroName = "Edge Zero Routing";
      const highId = await seedCandidate(highName, [1, 1, 1]);
      const zeroId = await seedCandidate(zeroName, [1, 1, 1]);
      const highSource = (await personSourceIds(highId))[0]!;
      const zeroSource = (await personSourceIds(zeroId))[0]!;
      await sql`
        update edges set tier = 2
        where dst_id = ${highId} and source_table = 'chunks' and source_id = ${highSource}`;
      await sql`
        update edges set tier = 0
        where dst_id = ${zeroId} and source_table = 'chunks' and source_id = ${zeroSource}`;
      const prompts: string[] = [];

      const result = await compileNotes({
        deps: {
          distill: async (name) => {
            prompts.push(name);
            return `${name} facts.`;
          },
        },
      });
      const high = result.results.find(
        (entry) =>
          entry.target_hash === opaqueTargetHash(compiledNotePath("person", highName, highId)),
      );
      const zero = result.results.find(
        (entry) =>
          entry.target_hash === opaqueTargetHash(compiledNotePath("person", zeroName, zeroId)),
      );
      expect(high?.status).toBe("created");
      expect(high).toHaveProperty("tier", 2);
      expect(zero).toBeUndefined();
      expect(prompts).toEqual([highName]);
    });
  });

  test("ownership matching uses boundaries for Latin names and literal matching for punctuation and CJK", async () => {
    const seed = async (canonicalName: string, text: string): Promise<string> => {
      const [person] = await sql`
        insert into people (canonical_name, tier) values (${canonicalName}, 1) returning id`;
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier)
        values (${`matcher/${crypto.randomUUID()}.md`}, ${canonicalName}, ${text},
                ${crypto.randomUUID()}, 1) returning id`;
      await sql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${page!.id}, 0, ${text}, 1)`;
      await sql`
        insert into edges (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values ('page', ${page!.id}, 'mentions', 'person', ${person!.id},
                'pages', ${page!.id}, 1)`;
      return person!.id;
    };
    const ann = await seed("Ann", "The Annual planning cycle starts tomorrow.");
    const punctuation = await seed("C++", "C++ powers the parser implementation.");
    const cjk = await seed("小明", "王小明今天完成了这个项目。");

    expect(await noteSourceChunks("person", ann)).toEqual([]);
    expect((await noteSourceChunks("person", punctuation)).map((row) => row.text)).toEqual([
      "C++ powers the parser implementation.",
    ]);
    expect((await noteSourceChunks("person", cjk)).map((row) => row.text)).toEqual([
      "王小明今天完成了这个项目。",
    ]);
  });

  test("tier-zero and unverifiable generated recoveries are removed before convergence, with fixed failure on removal error", async () => {
    await withPrivateDataDir(async () => {
      const explicitZero = recoveryFixture("Explicit Zero Recovery", crypto.randomUUID(), 1);
      const zeroArchiveText =
        `---\ntitle: ${JSON.stringify(explicitZero.title)}\ntier: 0\n---\n` +
        `${normalizeCompiledNoteBody(explicitZero.body_md)}\n`;
      const zeroRecord = {
        ...explicitZero,
        tier: 0,
        archive_sha256: new Bun.CryptoHasher("sha256").update(zeroArchiveText).digest("hex"),
      };
      await mkdir(compiledNoteRecoveryDir(), { recursive: true, mode: 0o700 });
      const zeroFile = recoveryFilenameFor(explicitZero.target_path);
      await writeFile(
        join(compiledNoteRecoveryDir(), zeroFile),
        `${JSON.stringify(zeroRecord)}\n`,
        { mode: 0o600 },
      );
      const writes = { model: 0, recovery: 0, page: 0, archive: 0, index: 0 };
      const blocked = await compileNotes({
        deps: {
          distill: async () => {
            writes.model++;
            return "must not run";
          },
          writeRecovery: async (record) => {
            writes.recovery++;
            return { valid: true, file: "unexpected.json", filenameHash: "unexpected", record };
          },
          upsertPage: async (input, options) => {
            writes.page++;
            return repoUpsertPage(input, options);
          },
          writeArchive: async () => {
            writes.archive++;
          },
          replaceIndex: async () => {
            writes.index++;
            return 0;
          },
        },
      });
      expect(writes).toEqual({ model: 0, recovery: 0, page: 0, archive: 0, index: 0 });
      expect(blocked.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(explicitZero.target_path),
          code: "tier0_source_blocked",
          kind: "person",
        },
      ]);
      expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);

      const unresolved = recoveryFixture("Unresolved Recovery", crypto.randomUUID(), 1);
      const listing = await writeCompiledNoteRecoveryRecord(unresolved);
      let removeCalls = 0;
      const failed = await compileNotes({
        deps: {
          removeRecovery: async () => {
            removeCalls++;
            throw { code: "sentinel" };
          },
          distill: async () => {
            throw new Error("model must not run");
          },
          upsertPage: async () => {
            throw new Error("page must not run");
          },
          writeArchive: async () => {
            throw new Error("archive must not run");
          },
          replaceIndex: async () => {
            throw new Error("index must not run");
          },
        } as any,
      });
      expect(removeCalls).toBe(1);
      expect(failed.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(unresolved.target_path),
          code: "recovery_remove_failed",
          kind: "person",
        },
      ]);
      expect(JSON.stringify(failed.results)).not.toContain("sentinel");
      expect(JSON.stringify(failed.results)).not.toContain('"tier":');
      expect(await readdir(compiledNoteRecoveryDir())).toContain(listing.file);
    });
  });

  test("unverifiable recovery removal failure retains bytes and cannot leak an arbitrary error code", async () => {
    await withPrivateDataDir(async () => {
      const unresolved = recoveryFixture("Unverifiable Removal", crypto.randomUUID(), 1);
      const listing = await writeCompiledNoteRecoveryRecord(unresolved);
      const before = await readFile(join(compiledNoteRecoveryDir(), listing.file));
      const writes = { remove: 0, model: 0, page: 0, archive: 0, index: 0 };

      const result = await compileNotes({
        deps: {
          removeRecovery: async () => {
            writes.remove++;
            throw { code: "sentinel" };
          },
          distill: async () => {
            writes.model++;
            return "must not run";
          },
          upsertPage: async () => {
            writes.page++;
            throw new Error("must not run");
          },
          writeArchive: async () => {
            writes.archive++;
          },
          replaceIndex: async () => {
            writes.index++;
            return 0;
          },
        } as any,
      });

      expect(writes).toEqual({ remove: 1, model: 0, page: 0, archive: 0, index: 0 });
      expect(result.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(unresolved.target_path),
          code: "recovery_remove_failed",
          kind: "person",
        },
      ]);
      expect(JSON.stringify(result.results)).not.toContain("sentinel");
      expect(JSON.stringify(result.results)).not.toContain('"tier":');
      expect(await readFile(join(compiledNoteRecoveryDir(), listing.file))).toEqual(before);
    });
  });

  test("blocked recovery cleanup quarantines a generated mirror and preserves its archive bytes", async () => {
    await withPrivateDataDir(async (root) => {
      const name = "Blocked Mirror Quarantine Sentinel";
      const source = await seedSingleMentionSource(name);
      const record = await recoveryWithVerifiablePersonSource(
        recoveryFixture(name, source.personId, 1),
        source.personId,
        name,
      );
      const archive = renderCompiledNoteArchive({
        title: record.title,
        tier: 1,
        bodyMd: record.body_md,
      });
      const [page] = await sql`
        insert into pages
          (path, title, body_md, content_hash, tier, status, source, created_by, derived_from)
        values (${record.target_path}, ${record.title}, ${archive.bodyMd}, ${archive.contentHash},
                1, 'active', ${COMPILED_NOTE_SOURCE}, ${COMPILED_NOTE_CREATOR},
                ${record.derived_from})
        returning id`;
      await indexParent("page", page!.id, archive.bodyMd, record.title, 1, {
        extractEdges: false,
      });
      const [chunk] = await sql`
        update chunks set embedding = array_fill(0.02, array[768])::vector,
                          embed_model = 'blocked-mirror-model'
        where parent_type = 'page' and parent_id = ${page!.id}
        returning id`;
      await sql`
        insert into edges
          (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
        values
          ('page', ${page!.id}, 'page-source', 'person', ${source.personId},
           'pages', ${page!.id}, 1),
          ('page', ${page!.id}, 'canonical-parent', 'person', ${source.personId},
           null, null, 1),
          ('person', ${source.personId}, 'chunk-source', 'person', ${source.personId},
           'chunks', ${chunk!.id}, 1)`;
      const archiveTarget = resolve(root, "brain", record.target_path);
      await atomicWritePrivate(archiveTarget, archive.bytes);
      const beforeArchive = await readFile(archiveTarget);
      await writeTierZeroRecoveryGeneration(record, 0);
      const targetWrites = { model: 0, page: 0, archive: 0, index: 0 };

      const result = await compileNotes({
        deps: {
          distill: async () => {
            targetWrites.model++;
            return "must not run";
          },
          upsertPage: async (input, options) => {
            targetWrites.page++;
            return repoUpsertPage(input, options);
          },
          writeArchive: async () => {
            targetWrites.archive++;
          },
          replaceIndex: async () => {
            targetWrites.index++;
            return 0;
          },
        },
      });

      expect(targetWrites).toEqual({ model: 0, page: 0, archive: 0, index: 0 });
      expect(result.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(record.target_path),
          code: "tier0_source_blocked",
          kind: "person",
        },
      ]);
      expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
      const quarantinedPage = await sql`select tier, status from pages where id = ${page!.id}`;
      expect(quarantinedPage.map((row) => ({ tier: row.tier, status: row.status }))).toEqual([
        { tier: 0, status: "deleted" },
      ]);
      const quarantinedChunks = await sql`
        select tier, embedding, embed_model from chunks
        where parent_type = 'page' and parent_id = ${page!.id}`;
      expect(quarantinedChunks.length).toBeGreaterThan(0);
      expect(
        quarantinedChunks.every(
          (row) => row.tier === 0 && row.embedding === null && row.embed_model === null,
        ),
      ).toBe(true);
      const edgeRows = await sql`
        select tier from edges
        where (source_table = 'pages' and source_id = ${page!.id})
           or (src_type = 'page' and src_id = ${page!.id})
           or (source_table = 'chunks' and source_id = ${chunk!.id})`;
      expect(edgeRows).toHaveLength(3);
      expect(edgeRows.every((edge) => edge.tier === 0)).toBe(true);
      expect(await readFile(archiveTarget)).toEqual(beforeArchive);
      expect(
        await ftsCandidates("Blocked Mirror Quarantine Sentinel", ["page"], [page!.id]),
      ).toEqual([]);
    });
  });

  test("blocked recovery cleanup leaves a human target and archive byte-identical", async () => {
    await withPrivateDataDir(async (root) => {
      const name = "Blocked Human Target";
      const entityId = crypto.randomUUID();
      const record = recoveryFixture(name, entityId, 1);
      const [page] = await sql`
        insert into pages
          (path, title, body_md, content_hash, tier, status, source, created_by)
        values (${record.target_path}, 'Human title', 'Human owner body.', 'human-owner-hash',
                1, 'active', 'manual', 'human:owner')
        returning id`;
      await sql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${page!.id}, 0, 'Human owner body.', 1)`;
      const archiveTarget = resolve(root, "brain", record.target_path);
      await atomicWritePrivate(archiveTarget, "human archive bytes");
      const beforePage = (await sql`select * from pages where id = ${page!.id}`).map((row) => ({
        ...row,
      }));
      const beforeChunks = (await sql`select * from chunks where parent_id = ${page!.id}`).map(
        (row) => ({ ...row }),
      );
      const beforeArchive = await readFile(archiveTarget);
      await writeTierZeroRecoveryGeneration(record, 0);
      let modelCalls = 0;

      const result = await compileNotes({
        deps: {
          distill: async () => {
            modelCalls++;
            return "must not run";
          },
        },
      });

      expect(modelCalls).toBe(0);
      expect(result.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(record.target_path),
          code: "tier0_source_blocked",
          kind: "person",
        },
      ]);
      expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
      expect(
        (await sql`select * from pages where id = ${page!.id}`).map((row) => ({ ...row })),
      ).toEqual(beforePage);
      expect(
        (await sql`select * from chunks where parent_id = ${page!.id}`).map((row) => ({ ...row })),
      ).toEqual(beforeChunks);
      expect(await readFile(archiveTarget)).toEqual(beforeArchive);
    });
  });

  for (const block of ["tier0", "unverifiable"] as const) {
    test(`page-only generated mirror quarantines ${block} evidence without recovery`, async () => {
      await withPrivateDataDir(async (root) => {
        const fixture = await seedPageOnlyBlockedMirror(root, `Page Only ${block} Quarantine`, {
          block,
          owner: "generated",
        });
        const writes = { model: 0, recovery: 0, page: 0, archive: 0, index: 0 };

        const result = await compileNotes({
          deps: {
            distill: async () => {
              writes.model++;
              return "must not run";
            },
            writeRecovery: async (record) => {
              writes.recovery++;
              return { valid: true, file: "unexpected.json", filenameHash: "unexpected", record };
            },
            upsertPage: async (input, options) => {
              writes.page++;
              return repoUpsertPage(input, options);
            },
            writeArchive: async () => {
              writes.archive++;
            },
            replaceIndex: async () => {
              writes.index++;
              return 0;
            },
          },
        });

        expect(writes).toEqual({ model: 0, recovery: 0, page: 0, archive: 0, index: 0 });
        expect(result.results).toEqual([
          {
            status: "failed",
            target_hash: opaqueTargetHash(fixture.targetPath),
            code: block === "tier0" ? "tier0_source_blocked" : "source_evidence_unverifiable",
            kind: "person",
          },
        ]);
        expect(
          (await sql`select tier, status from pages where id = ${fixture.pageId}`).map((row) => ({
            tier: row.tier,
            status: row.status,
          })),
        ).toEqual([{ tier: 0, status: "deleted" }]);
        const quarantinedChunks = await sql`
          select tier, embedding, embed_model from chunks
          where parent_type = 'page' and parent_id = ${fixture.pageId}`;
        expect(
          quarantinedChunks.map((row) => ({
            tier: row.tier,
            embedding: row.embedding,
            embed_model: row.embed_model,
          })),
        ).toEqual([{ tier: 0, embedding: null, embed_model: null }]);
        const edges = await sql`
          select tier from edges
          where (source_table = 'pages' and source_id = ${fixture.pageId})
             or (src_type = 'page' and src_id = ${fixture.pageId})
             or (source_table = 'chunks' and source_id = ${fixture.chunkId})`;
        expect(edges).toHaveLength(3);
        expect(edges.every((edge) => edge.tier === 0)).toBe(true);
        expect(
          Buffer.from(await readFile(fixture.archiveTarget)).equals(
            Buffer.from(fixture.archiveBytes),
          ),
        ).toBe(true);
        expect(
          await ftsCandidates(`Page Only ${block} Quarantine`, ["page"], [fixture.pageId]),
        ).toEqual([]);
        expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
      });
    });
  }

  test("page-only blocked human mirrors remain row and archive byte-identical", async () => {
    await withPrivateDataDir(async (root) => {
      const fixture = await seedPageOnlyBlockedMirror(root, "Page Only Human Block", {
        block: "tier0",
        owner: "human",
      });
      const beforePage = (await sql`select * from pages where id = ${fixture.pageId}`).map(
        (row) => ({ ...row }),
      );
      const beforeChunks = (
        await sql`select * from chunks where parent_type = 'page' and parent_id = ${fixture.pageId}`
      ).map((row) => ({ ...row }));
      const beforeEdges = (
        await sql`
          select * from edges
          where (source_table = 'pages' and source_id = ${fixture.pageId})
             or (src_type = 'page' and src_id = ${fixture.pageId})
             or (source_table = 'chunks' and source_id = ${fixture.chunkId})
          order by id`
      ).map((row) => ({ ...row }));

      const result = await compileNotes();

      expect(result.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(fixture.targetPath),
          code: "tier0_source_blocked",
          kind: "person",
        },
      ]);
      expect(
        (await sql`select * from pages where id = ${fixture.pageId}`).map((row) => ({
          ...row,
        })),
      ).toEqual(beforePage);
      expect(
        (
          await sql`
            select * from chunks
            where parent_type = 'page' and parent_id = ${fixture.pageId}`
        ).map((row) => ({ ...row })),
      ).toEqual(beforeChunks);
      expect(
        (
          await sql`
            select * from edges
            where (source_table = 'pages' and source_id = ${fixture.pageId})
               or (src_type = 'page' and src_id = ${fixture.pageId})
               or (source_table = 'chunks' and source_id = ${fixture.chunkId})
            order by id`
        ).map((row) => ({ ...row })),
      ).toEqual(beforeEdges);
      expect(
        Buffer.from(await readFile(fixture.archiveTarget)).equals(
          Buffer.from(fixture.archiveBytes),
        ),
      ).toBe(true);
    });
  });

  test("tier-zero recovery dominates a valid generation in both generation orders", async () => {
    for (const order of ["zero-first", "zero-last"] as const) {
      await resetDb();
      await withPrivateDataDir(async (root) => {
        const name = `Mixed Recovery ${order}`;
        const source = await seedSingleMentionSource(name);
        const valid = await recoveryWithVerifiablePersonSource(
          recoveryFixture(name, source.personId, 1),
          source.personId,
          name,
        );
        if (order === "zero-first") {
          await writeTierZeroRecoveryGeneration(valid, 0);
          await writeCompiledNoteRecoveryRecord(valid);
        } else {
          await writeCompiledNoteRecoveryRecord(valid);
          await writeTierZeroRecoveryGeneration(valid, 1);
        }
        const writes = { model: 0, page: 0, archive: 0, index: 0 };

        const result = await compileNotes({
          deps: {
            distill: async () => {
              writes.model++;
              return "must not run";
            },
            upsertPage: async (input, options) => {
              writes.page++;
              return repoUpsertPage(input, options);
            },
            writeArchive: async () => {
              writes.archive++;
            },
            replaceIndex: async () => {
              writes.index++;
              return 0;
            },
          },
        });

        expect(writes).toEqual({ model: 0, page: 0, archive: 0, index: 0 });
        expect(result.results).toEqual([
          {
            status: "failed",
            target_hash: opaqueTargetHash(valid.target_path),
            code: "tier0_source_blocked",
            kind: "person",
          },
        ]);
        expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
        expect(await sql`select id from pages where path = ${valid.target_path}`).toHaveLength(0);
        expect(
          await stat(resolve(root, "brain", valid.target_path))
            .then(() => true)
            .catch(() => false),
        ).toBe(false);
      });
    }
  });

  test("cleanup failure for identity A does not strand identity B refreshed generation", async () => {
    await withPrivateDataDir(async () => {
      const identityA = "00000000-0000-4000-8000-000000000001";
      const identityB = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      await sql`
        insert into people (id, canonical_name, tier)
        values
          (${identityA}, 'Alpha Failure Identity', 1),
          (${identityB}, 'Beta Settled Identity', 1)`;
      const validA = await recoveryWithVerifiablePersonSource(
        recoveryFixture("Alpha Failure Identity", identityA, 1),
        identityA,
        "Alpha Failure Identity",
      );
      const validB = await recoveryWithVerifiablePersonSource(
        recoveryFixture("Beta Settled Identity", identityB, 1),
        identityB,
        "Beta Settled Identity",
      );
      await writeCompiledNoteRecoveryRecord(validA);
      await writeTierZeroRecoveryGeneration(validA, 1);
      await writeCompiledNoteRecoveryRecord(validB);
      await writeTierZeroRecoveryGeneration(validB, 1);
      const removals: string[] = [];
      let injectedB = false;

      const first = await compileNotes({
        deps: {
          removeRecovery: async (listing) => {
            const identity = listing.record.entity_id === identityA ? "A" : "B";
            removals.push(`${identity}:${listing.valid ? "valid" : "tier0"}`);
            if (identity === "A" && !listing.valid) {
              throw new Error("identity A blocker retained");
            }
            await removeCompiledNoteRecoveryRecord(listing);
            if (identity === "B" && !listing.valid && !injectedB) {
              injectedB = true;
              await writeCompiledNoteRecoveryRecord(validB);
            }
          },
        },
      });

      expect(removals).toEqual(["A:valid", "A:tier0", "B:valid", "B:tier0", "B:valid"]);
      expect(first.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(validA.target_path),
          code: "recovery_remove_failed",
          kind: "person",
        },
        {
          status: "failed",
          target_hash: opaqueTargetHash(validB.target_path),
          code: "tier0_source_blocked",
          kind: "person",
        },
      ]);
      const afterFirst = await listCompiledNoteRecoveryRecords();
      expect(
        afterFirst.filter((listing) => recoveryListingEntityId(listing) === identityB),
      ).toEqual([]);

      const writes = { model: 0, page: 0, archive: 0, index: 0 };
      const second = await compileNotes({
        deps: {
          distill: async () => {
            writes.model++;
            return "must not run";
          },
          upsertPage: async (input, options) => {
            writes.page++;
            return repoUpsertPage(input, options);
          },
          writeArchive: async () => {
            writes.archive++;
          },
          replaceIndex: async () => {
            writes.index++;
            return 0;
          },
        },
      });
      expect(second.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(validA.target_path),
          code: "tier0_source_blocked",
          kind: "person",
        },
      ]);
      expect(writes).toEqual({ model: 0, page: 0, archive: 0, index: 0 });
      expect(await sql`select id from pages where path = ${validB.target_path}`).toHaveLength(0);
    });
  });

  test("blocker restoration never overwrites occupied generation zero", async () => {
    await withPrivateDataDir(async () => {
      const name = "Occupied Generation Zero Blocker";
      const source = await seedSingleMentionSource(name);
      const valid = await recoveryWithVerifiablePersonSource(
        recoveryFixture(name, source.personId, 1),
        source.personId,
        name,
      );
      await writeTierZeroRecoveryGeneration(valid, 0);
      await writeCompiledNoteRecoveryRecord(valid);
      const generationZeroPath = join(
        compiledNoteRecoveryDir(),
        recoveryGenerationFilenameFor(valid, 0),
      );
      const sentinel = Buffer.from("occupied generation zero sentinel");
      let occupiedBefore: { bytes: Buffer; inode: number; mode: number } | undefined;
      let removalCount = 0;

      const result = await compileNotes({
        deps: {
          removeRecovery: async (listing) => {
            removalCount++;
            if (removalCount === 3) throw new Error("refreshed valid removal failed");
            await removeCompiledNoteRecoveryRecord(listing);
            if (!listing.valid) {
              await writeFile(generationZeroPath, sentinel, { flag: "wx", mode: 0o640 });
              await chmod(generationZeroPath, 0o640);
              occupiedBefore = await recoveryFileSnapshot(generationZeroPath);
              await writeCompiledNoteRecoveryRecord(valid);
            }
          },
        },
      });

      expect(removalCount).toBe(3);
      expect(result.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(valid.target_path),
          code: "recovery_remove_failed",
          kind: "person",
        },
      ]);
      expect(occupiedBefore).toEqual({
        bytes: sentinel,
        inode: expect.any(Number),
        mode: 0o640,
      });
      if (!occupiedBefore) throw new Error("expected occupied snapshot");
      expect(await recoveryFileSnapshot(generationZeroPath)).toEqual(occupiedBefore);
      const retained = await listCompiledNoteRecoveryRecords();
      const successor = retained.find(
        (listing) => !listing.valid && listing.code === "tier0_recovery_record",
      );
      expect(successor?.file).toBe(recoveryGenerationFilenameFor(valid, 2));
      expect(await sql`select id from pages where path = ${valid.target_path}`).toHaveLength(0);
    });
  });

  test("post-publish caller failure retains durable blocked evidence", async () => {
    await withPrivateDataDir(async () => {
      const name = "Post Publish Durable Block";
      const source = await seedSingleMentionSource(name);
      const valid = await recoveryWithVerifiablePersonSource(
        recoveryFixture(name, source.personId, 1),
        source.personId,
        name,
      );
      await writeCompiledNoteRecoveryRecord(valid);
      await writeTierZeroRecoveryGeneration(valid, 1);
      let removalCount = 0;
      let publisherCalls = 0;
      const writes = { model: 0, page: 0, archive: 0, index: 0 };
      const deps = {
        removeRecovery: async (listing: Parameters<typeof removeCompiledNoteRecoveryRecord>[0]) => {
          removalCount++;
          if (removalCount === 3) throw new Error("refreshed valid removal failed");
          await removeCompiledNoteRecoveryRecord(listing);
          if (!listing.valid) await writeCompiledNoteRecoveryRecord(valid);
        },
        writeRecoveryBlock: async (record: CompiledNoteRecoveryV1 | TierZeroRecoveryRecord) => {
          publisherCalls++;
          const writer = await recoveryBlockWriter();
          await writer(record);
          throw new Error("post-publish caller rejection");
        },
        distill: async () => {
          writes.model++;
          return "must not run";
        },
        upsertPage: async (
          input: Parameters<typeof repoUpsertPage>[0],
          options: NonNullable<Parameters<typeof repoUpsertPage>[1]>,
        ) => {
          writes.page++;
          return repoUpsertPage(input, options);
        },
        writeArchive: async () => {
          writes.archive++;
        },
        replaceIndex: async () => {
          writes.index++;
          return 0;
        },
      };

      const first = await compileNotes({ deps });

      expect(publisherCalls).toBe(1);
      expect(writes).toEqual({ model: 0, page: 0, archive: 0, index: 0 });
      expect(first.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(valid.target_path),
          code: "recovery_remove_failed",
          kind: "person",
        },
      ]);
      expect(
        (await listCompiledNoteRecoveryRecords()).some(
          (listing) => !listing.valid && listing.code === "tier0_recovery_record",
        ),
      ).toBe(true);

      const second = await compileNotes({
        deps: {
          distill: async () => {
            writes.model++;
            return "must not run";
          },
          upsertPage: async (input, options) => {
            writes.page++;
            return repoUpsertPage(input, options);
          },
          writeArchive: async () => {
            writes.archive++;
          },
          replaceIndex: async () => {
            writes.index++;
            return 0;
          },
        },
      });
      expect(second.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(valid.target_path),
          code: "tier0_source_blocked",
          kind: "person",
        },
      ]);
      expect(writes).toEqual({ model: 0, page: 0, archive: 0, index: 0 });
      expect(await sql`select id from pages where path = ${valid.target_path}`).toHaveLength(0);
    });
  });

  test("bounded refreshed generations end in durable block", async () => {
    await withPrivateDataDir(async () => {
      const name = "Bounded Refreshed Generations";
      const source = await seedSingleMentionSource(name);
      const valid = await recoveryWithVerifiablePersonSource(
        recoveryFixture(name, source.personId, 1),
        source.personId,
        name,
      );
      await writeCompiledNoteRecoveryRecord(valid);
      await writeTierZeroRecoveryGeneration(valid, 1);
      let inject = false;
      let injections = 0;
      let removals = 0;
      const writes = { model: 0, page: 0, archive: 0, index: 0 };

      const result = await compileNotes({
        deps: {
          removeRecovery: async (listing) => {
            removals++;
            await removeCompiledNoteRecoveryRecord(listing);
            if (!listing.valid) inject = true;
            if (inject) {
              injections++;
              await writeCompiledNoteRecoveryRecord(valid);
            }
          },
          distill: async () => {
            writes.model++;
            return "must not run";
          },
          upsertPage: async (input, options) => {
            writes.page++;
            return repoUpsertPage(input, options);
          },
          writeArchive: async () => {
            writes.archive++;
          },
          replaceIndex: async () => {
            writes.index++;
            return 0;
          },
        },
      });

      expect(removals).toBe(5);
      expect(injections).toBe(4);
      expect(result.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(valid.target_path),
          code: "recovery_remove_failed",
          kind: "person",
        },
      ]);
      expect(writes).toEqual({ model: 0, page: 0, archive: 0, index: 0 });
      const retained = await listCompiledNoteRecoveryRecords();
      expect(
        retained.some((listing) => !listing.valid && listing.code === "tier0_recovery_record"),
      ).toBe(true);
      expect(await sql`select id from pages where path = ${valid.target_path}`).toHaveLength(0);
    });
  });

  test("stable empty requires two identity-local scans", async () => {
    await withPrivateDataDir(async () => {
      const name = "Two Empty Confirmations";
      const source = await seedSingleMentionSource(name);
      const valid = await recoveryWithVerifiablePersonSource(
        recoveryFixture(name, source.personId, 1),
        source.personId,
        name,
      );
      await writeCompiledNoteRecoveryRecord(valid);
      await writeTierZeroRecoveryGeneration(valid, 1);
      const removals: string[] = [];
      let emptySnapshots = 0;
      const recoveryDir = compiledNoteRecoveryDir();
      const injectedPath = join(recoveryDir, recoveryGenerationFilenameFor(valid, 0));
      const realReaddir = fsPromises.readdir;
      const readdirSpy = spyOn(fsPromises, "readdir").mockImplementation((async (
        ...args: unknown[]
      ) => {
        const entries = await (realReaddir as (...input: unknown[]) => Promise<unknown[]>)(...args);
        const requested = resolve(String(args[0]));
        const names = entries.map((entry) =>
          typeof entry === "string" ? entry : (entry as { name: string }).name,
        );
        if (
          requested === resolve(recoveryDir) &&
          !names.some((file) => file.includes(valid.entity_id)) &&
          emptySnapshots++ === 0
        ) {
          queueMicrotask(() => {
            writeFileSync(injectedPath, `${JSON.stringify(valid)}\n`, {
              flag: "wx",
              mode: 0o600,
            });
          });
        }
        return entries;
      }) as typeof fsPromises.readdir);
      let result: Awaited<ReturnType<typeof compileNotes>>;
      try {
        result = await compileNotes({
          deps: {
            removeRecovery: async (listing) => {
              removals.push(listing.valid ? "valid" : "tier0");
              await removeCompiledNoteRecoveryRecord(listing);
            },
          },
        });
      } finally {
        readdirSpy.mockRestore();
      }

      expect(removals).toEqual(["valid", "tier0", "valid"]);
      expect(emptySnapshots).toBeGreaterThanOrEqual(2);
      expect(result.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(valid.target_path),
          code: "tier0_source_blocked",
          kind: "person",
        },
      ]);
      expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
      expect(await sql`select id from pages where path = ${valid.target_path}`).toHaveLength(0);
    });
  });

  test("blocked-group cleanup removes valid generations first and retains the blocker on failure", async () => {
    await withPrivateDataDir(async () => {
      const name = "Blocked Removal Ordering";
      const source = await seedSingleMentionSource(name);
      const valid = await recoveryWithVerifiablePersonSource(
        recoveryFixture(name, source.personId, 1),
        source.personId,
        name,
      );
      const validListing = await writeCompiledNoteRecoveryRecord(valid);
      const zero = await writeTierZeroRecoveryGeneration(valid, 1);
      const removals: string[] = [];
      const writes = { model: 0, page: 0, archive: 0, index: 0 };

      const result = await compileNotes({
        deps: {
          removeRecovery: async (
            listing: Parameters<typeof removeCompiledNoteRecoveryRecord>[0],
          ) => {
            removals.push(listing.valid ? "valid" : "tier0");
            if (!listing.valid) throw new Error("blocked removal sentinel");
            await removeCompiledNoteRecoveryRecord(listing);
          },
          distill: async () => {
            writes.model++;
            return "must not run";
          },
          upsertPage: async (input, options) => {
            writes.page++;
            return repoUpsertPage(input, options);
          },
          writeArchive: async () => {
            writes.archive++;
          },
          replaceIndex: async () => {
            writes.index++;
            return 0;
          },
        },
      });

      expect(removals).toEqual(["valid", "tier0"]);
      expect(writes).toEqual({ model: 0, page: 0, archive: 0, index: 0 });
      expect(result.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(valid.target_path),
          code: "recovery_remove_failed",
          kind: "person",
        },
      ]);
      expect(await readdir(compiledNoteRecoveryDir())).toEqual([zero.file]);
      expect(
        await stat(join(compiledNoteRecoveryDir(), validListing.file))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      expect(await sql`select id from pages where path = ${valid.target_path}`).toHaveLength(0);
    });
  });

  test("continuous concurrent generations retain the blocker and end bounded durable", async () => {
    await withPrivateDataDir(async () => {
      const name = "Concurrent Blocked Generation";
      const source = await seedSingleMentionSource(name);
      const valid = await recoveryWithVerifiablePersonSource(
        recoveryFixture(name, source.personId, 1),
        source.personId,
        name,
      );
      await writeCompiledNoteRecoveryRecord(valid);
      const zero = await writeTierZeroRecoveryGeneration(valid, 1);
      const removals: string[] = [];
      let concurrentFile = "";
      const writes = { model: 0, page: 0, archive: 0, index: 0 };

      const result = await compileNotes({
        deps: {
          removeRecovery: async (
            listing: Parameters<typeof removeCompiledNoteRecoveryRecord>[0],
          ) => {
            removals.push(listing.valid ? "valid" : "tier0");
            await removeCompiledNoteRecoveryRecord(listing);
            if (listing.valid) {
              concurrentFile = (await writeCompiledNoteRecoveryRecord(valid)).file;
            }
          },
          distill: async () => {
            writes.model++;
            return "must not run";
          },
          upsertPage: async (input, options) => {
            writes.page++;
            return repoUpsertPage(input, options);
          },
          writeArchive: async () => {
            writes.archive++;
          },
          replaceIndex: async () => {
            writes.index++;
            return 0;
          },
        },
      });

      expect(removals).toEqual(["valid", "valid", "valid", "valid"]);
      expect(writes).toEqual({ model: 0, page: 0, archive: 0, index: 0 });
      expect(result.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(valid.target_path),
          code: "recovery_remove_failed",
          kind: "person",
        },
      ]);
      expect(await readdir(compiledNoteRecoveryDir())).toEqual(
        expect.arrayContaining([zero.file, concurrentFile]),
      );
      expect(await sql`select id from pages where path = ${valid.target_path}`).toHaveLength(0);
    });
  });

  test("a valid generation injected after blocker removal is cleaned before stability and never converges", async () => {
    await withPrivateDataDir(async () => {
      const name = "Post Blocker Removal Generation";
      const source = await seedSingleMentionSource(name);
      const valid = await recoveryWithVerifiablePersonSource(
        recoveryFixture(name, source.personId, 1),
        source.personId,
        name,
      );
      await writeCompiledNoteRecoveryRecord(valid);
      await writeTierZeroRecoveryGeneration(valid, 1);
      const removals: string[] = [];
      let injected = false;
      const writes = { model: 0, page: 0, archive: 0, index: 0 };

      const first = await compileNotes({
        deps: {
          removeRecovery: async (listing) => {
            removals.push(listing.valid ? "valid" : "tier0");
            await removeCompiledNoteRecoveryRecord(listing);
            if (!listing.valid && !injected) {
              injected = true;
              await writeCompiledNoteRecoveryRecord(valid);
            }
          },
          distill: async () => {
            writes.model++;
            return "must not run";
          },
          upsertPage: async (input, options) => {
            writes.page++;
            return repoUpsertPage(input, options);
          },
          writeArchive: async () => {
            writes.archive++;
          },
          replaceIndex: async () => {
            writes.index++;
            return 0;
          },
        },
      });

      expect(removals).toEqual(["valid", "tier0", "valid"]);
      expect(writes).toEqual({ model: 0, page: 0, archive: 0, index: 0 });
      expect(first.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(valid.target_path),
          code: "tier0_source_blocked",
          kind: "person",
        },
      ]);
      expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
      expect(await sql`select id from pages where path = ${valid.target_path}`).toHaveLength(0);

      const second = await compileNotes();
      expect(second.results).toEqual([]);
      expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
      expect(await sql`select id from pages where path = ${valid.target_path}`).toHaveLength(0);
    });
  });

  test("post-blocker injected removal failure restores durable blocker after valid-first ordering", async () => {
    await withPrivateDataDir(async () => {
      const name = "Post Blocker Removal Failure";
      const source = await seedSingleMentionSource(name);
      const valid = await recoveryWithVerifiablePersonSource(
        recoveryFixture(name, source.personId, 1),
        source.personId,
        name,
      );
      await writeCompiledNoteRecoveryRecord(valid);
      await writeTierZeroRecoveryGeneration(valid, 1);
      const removals: string[] = [];
      let injected = false;

      const first = await compileNotes({
        deps: {
          removeRecovery: async (
            listing: Parameters<typeof removeCompiledNoteRecoveryRecord>[0],
          ) => {
            removals.push(listing.valid ? "valid" : "tier0");
            if (removals.length === 3) throw new Error("injected removal failure");
            await removeCompiledNoteRecoveryRecord(listing);
            if (!listing.valid && !injected) {
              injected = true;
              await writeCompiledNoteRecoveryRecord(valid);
            }
          },
          distill: async () => {
            throw new Error("model must not run");
          },
          upsertPage: async () => {
            throw new Error("page must not run");
          },
          writeArchive: async () => {
            throw new Error("archive must not run");
          },
          replaceIndex: async () => {
            throw new Error("index must not run");
          },
        } as any,
      });

      expect(removals).toEqual(["valid", "tier0", "valid"]);
      expect(first.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(valid.target_path),
          code: "recovery_remove_failed",
          kind: "person",
        },
      ]);
      const retained = await listCompiledNoteRecoveryRecords();
      expect(
        retained.some((listing) => !listing.valid && listing.code === "tier0_recovery_record"),
      ).toBe(true);
      expect(await sql`select id from pages where path = ${valid.target_path}`).toHaveLength(0);

      const second = await compileNotes();
      expect(second.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(valid.target_path),
          code: "tier0_source_blocked",
          kind: "person",
        },
      ]);
      expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
      expect(await sql`select id from pages where path = ${valid.target_path}`).toHaveLength(0);
    });
  });

  test("ownerless and wrong-owner present sources are removed as unverifiable before target work", async () => {
    for (const mode of ["ownerless", "wrong-owner"] as const) {
      await resetDb();
      await withPrivateDataDir(async (root) => {
        const name = `Present ${mode} source`;
        const [expected] = await sql`
          insert into people (canonical_name, tier) values (${name}, 1) returning id`;
        const [page] = await sql`
          insert into pages (path, title, body_md, content_hash, tier)
          values (${`owner-evidence/${mode}.md`}, ${name}, ${`${name} source.`},
                  ${`owner-evidence-${mode}`}, 1)
          returning id`;
        const [chunk] = await sql`
          insert into chunks (parent_type, parent_id, ord, text, tier)
          values ('page', ${page!.id}, 0, ${`${name} source.`}, 1)
          returning id`;
        if (mode === "wrong-owner") {
          const [wrong] = await sql`
            insert into people (canonical_name, tier) values ('Wrong Owner Sentinel', 1)
            returning id`;
          await sql`
            insert into edges
              (src_type, src_id, rel, dst_type, dst_id, source_table, source_id, tier)
            values ('page', ${page!.id}, 'mentions', 'person', ${wrong!.id},
                    'chunks', ${chunk!.id}, 1)`;
        }
        const base = recoveryFixture(name, expected!.id, 1);
        const body =
          `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\nUnverifiable source body.\n\n` +
          `## Sources\n- ${chunk!.id}`;
        const archive = renderCompiledNoteArchive({ title: name, tier: 1, bodyMd: body });
        const record: CompiledNoteRecoveryV1 = {
          ...base,
          derived_from: page!.id,
          source_chunk_ids: [chunk!.id],
          body_md: body,
          archive_sha256: archive.contentHash,
        };
        await writeCompiledNoteRecoveryRecord(record);
        const writes = { remove: 0, model: 0, page: 0, archive: 0, index: 0 };

        const result = await compileNotes({
          deps: {
            removeRecovery: async (listing) => {
              writes.remove++;
              await removeCompiledNoteRecoveryRecord(listing);
            },
            distill: async () => {
              writes.model++;
              return "must not run";
            },
            upsertPage: async (input, options) => {
              writes.page++;
              return repoUpsertPage(input, options);
            },
            writeArchive: async () => {
              writes.archive++;
            },
            replaceIndex: async () => {
              writes.index++;
              return 0;
            },
          },
        });

        expect(writes).toEqual({ remove: 1, model: 0, page: 0, archive: 0, index: 0 });
        expect(result.results).toEqual([
          {
            status: "failed",
            target_hash: opaqueTargetHash(record.target_path),
            code: "source_evidence_unverifiable",
            kind: "person",
          },
        ]);
        expect(await readdir(compiledNoteRecoveryDir())).toEqual([]);
        expect(await sql`select id from pages where path = ${record.target_path}`).toHaveLength(0);
        expect(
          await stat(resolve(root, "brain", record.target_path))
            .then(() => true)
            .catch(() => false),
        ).toBe(false);
      });
    }
  });

  test("unverifiable owner evidence removal failure retains the blocker and performs zero target writes", async () => {
    await withPrivateDataDir(async () => {
      const name = "Owner Evidence Removal Failure";
      const [person] = await sql`
        insert into people (canonical_name, tier) values (${name}, 1) returning id`;
      const [page] = await sql`
        insert into pages (path, title, body_md, content_hash, tier)
        values ('owner-evidence/failure.md', ${name}, ${`${name} ownerless source.`},
                'owner-evidence-failure', 1)
        returning id`;
      const [chunk] = await sql`
        insert into chunks (parent_type, parent_id, ord, text, tier)
        values ('page', ${page!.id}, 0, ${`${name} ownerless source.`}, 1)
        returning id`;
      const base = recoveryFixture(name, person!.id, 1);
      const body = `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\nOwnerless source.\n\n## Sources\n- ${chunk!.id}`;
      const archive = renderCompiledNoteArchive({ title: name, tier: 1, bodyMd: body });
      const record: CompiledNoteRecoveryV1 = {
        ...base,
        derived_from: page!.id,
        source_chunk_ids: [chunk!.id],
        body_md: body,
        archive_sha256: archive.contentHash,
      };
      const listing = await writeCompiledNoteRecoveryRecord(record);
      const before = await readFile(join(compiledNoteRecoveryDir(), listing.file));
      const writes = { remove: 0, model: 0, page: 0, archive: 0, index: 0 };

      const result = await compileNotes({
        deps: {
          removeRecovery: async () => {
            writes.remove++;
            throw new Error("owner evidence removal failure");
          },
          distill: async () => {
            writes.model++;
            return "must not run";
          },
          upsertPage: async (input, options) => {
            writes.page++;
            return repoUpsertPage(input, options);
          },
          writeArchive: async () => {
            writes.archive++;
          },
          replaceIndex: async () => {
            writes.index++;
            return 0;
          },
        },
      });

      expect(writes).toEqual({ remove: 1, model: 0, page: 0, archive: 0, index: 0 });
      expect(result.results).toEqual([
        {
          status: "failed",
          target_hash: opaqueTargetHash(record.target_path),
          code: "recovery_remove_failed",
          kind: "person",
        },
      ]);
      expect(await readFile(join(compiledNoteRecoveryDir(), listing.file))).toEqual(before);
      expect(await sql`select id from pages where path = ${record.target_path}`).toHaveLength(0);
    });
  });
});
