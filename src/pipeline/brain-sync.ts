// Brain sync (spec §10): data/brain/**/*.md → pages (+ chunks). Frontmatter: title, tier?,
// status?. Hash-diff upserts; files removed from disk are soft-deleted (rows stay, I4).

import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  activePagesForCompiledNoteReconciliation,
  compiledEntityClusterEvidence,
  compiledRepresentationTierEvidence,
  compiledSourceEvidence,
  listActivePages,
  pageById,
  pageByPath,
  pageChunkSnapshot,
  quarantineGeneratedPageByPath,
  replaceChunks,
  retierPageEdges,
  setPageChunkTiers,
  setPageTier,
  softDeletePagesNotIn,
  upsertPage,
  withCompiledNoteTargetLease,
} from "../db/repo";
import { indexParent } from "../search/index-parent";
import {
  UNSAFE_PRIVATE_ROOT,
  assertNoSymlinkComponents,
  preflightPrivateRoot,
} from "../util/atomic-file";
import {
  COMPILED_NOTE_SOURCE,
  classifyFrontmatterTier,
  normalizeCompiledNoteBody,
  opaqueTargetHash,
  parseCompiledNoteSourceIds,
  parseFrontmatterDocument,
  recognizeCompiledNote,
  resolveCompiledNoteArchiveTarget,
} from "../util/compiled-note-archive";
import { config } from "../util/config";

export interface Frontmatter {
  title?: string;
  tier?: number;
  status?: string;
  body: string;
}

export function parseFrontmatter(md: string): Frontmatter {
  return parseFrontmatterDocument(md);
}

function titleFrom(fm: Frontmatter, relPath: string): string {
  if (fm.title) return fm.title;
  const h1 = fm.body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1]!.trim();
  return relPath.replace(/\.md$/, "").split("/").pop()!;
}

async function walkMd(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error(UNSAFE_PRIVATE_ROOT);
    if (stat.isDirectory()) out.push(...(await walkMd(full, base)));
    else if (stat.isFile() && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

export interface SyncStats {
  scanned: number;
  changed: number;
  unchanged: number;
  deleted: number;
  quarantined: number;
  issues: {
    target_hash: string;
    code:
      | "tier0_quarantined"
      | "invalid_tier_quarantined"
      | "source_evidence_unverifiable"
      | "protected_page_requires_owner";
  }[];
}

type TierBlockCode =
  | "tier0_quarantined"
  | "invalid_tier_quarantined"
  | "source_evidence_unverifiable";

function tierBlock(values: (number | null | undefined)[]): TierBlockCode | null {
  if (values.some((tier) => tier === 0)) return "tier0_quarantined";
  if (values.some((tier) => tier !== null && tier !== undefined && tier !== 1 && tier !== 2)) {
    return "invalid_tier_quarantined";
  }
  return null;
}

function noteTierEvidence(
  recognition: ReturnType<typeof recognizeCompiledNote>,
  sourceIds: string[],
  sourceEvidence: Awaited<ReturnType<typeof compiledSourceEvidence>>,
  cluster: Awaited<ReturnType<typeof compiledEntityClusterEvidence>>,
): number {
  const block = tierBlock([
    sourceEvidence.min_tier,
    sourceEvidence.max_tier,
    cluster.min_tier,
    cluster.max_tier,
    ...sourceEvidence.resolved.flatMap((source) => [source.min_tier, source.max_tier]),
  ]);
  if (block === "tier0_quarantined") throw new Error("TIER0_PROSE_BLOCKED");
  if (block) throw new Error("INVALID_CONTENT_TIER");
  if (cluster.evidence_unresolved) throw new Error("SOURCE_EVIDENCE_UNVERIFIABLE");
  if (!recognition.recognized) throw new Error("SOURCE_EVIDENCE_UNVERIFIABLE");
  const sourceBlock = unresolvedCompiledEvidence(recognition, sourceIds, sourceEvidence);
  if (sourceBlock) throw new Error("SOURCE_EVIDENCE_UNVERIFIABLE");
  return Math.max(sourceEvidence.max_tier!, cluster.max_tier ?? 1, 1) as 1 | 2;
}

function unresolvedCompiledEvidence(
  recognition: ReturnType<typeof recognizeCompiledNote>,
  sourceIds: string[],
  sourceEvidence: Awaited<ReturnType<typeof compiledSourceEvidence>>,
): "source_evidence_unverifiable" | null {
  if (
    !recognition.recognized ||
    sourceIds.length === 0 ||
    sourceEvidence.unresolved_ids.length > 0 ||
    sourceEvidence.resolved.length === 0 ||
    sourceEvidence.min_tier === null ||
    sourceEvidence.max_tier === null
  ) {
    return "source_evidence_unverifiable";
  }
  const pathIdentity = recognition.pathIdentity;
  const owners = sourceEvidence.owner_entities;
  if (pathIdentity) {
    if (
      owners.length === 0 ||
      owners.some(
        (owner) => owner.kind !== pathIdentity.kind || owner.entityId !== pathIdentity.entityId,
      )
    )
      return "source_evidence_unverifiable";
  } else if (owners.length !== 1) {
    return "source_evidence_unverifiable";
  }
  return null;
}

async function reconcileCompilerOwned(
  page: NonNullable<Awaited<ReturnType<typeof pageByPath>>>,
  recognition: ReturnType<typeof recognizeCompiledNote>,
): Promise<boolean> {
  const sourceIds = parseCompiledNoteSourceIds(page.body_md).ids;
  const evidence = await compiledSourceEvidence(sourceIds);
  const identities =
    recognition.recognized && recognition.pathIdentity
      ? [recognition.pathIdentity]
      : evidence.owner_entities;
  const cluster = await compiledEntityClusterEvidence(identities);
  const representations = await compiledRepresentationTierEvidence(page.id);
  const chunks = await pageChunkSnapshot(page.id);
  const target = Math.max(
    noteTierEvidence(recognition, sourceIds, evidence, cluster),
    representations.max_tier,
    page.tier,
    ...chunks.map((chunk) => chunk.tier),
  ) as 1 | 2;
  let changed = false;
  changed = (await retierPageEdges(page.id, target)) > 0 || changed;
  changed = (await setPageChunkTiers(page.id, target)) > 0 || changed;
  changed = (await setPageTier(page.id, target)) || changed;
  if (chunks.length === 0) {
    await indexParent("page", page.id, page.body_md, page.title, target, {
      extractEdges: false,
      tierMode: "promote-page-floor",
    });
    changed = true;
  }
  return changed;
}

async function reconcileCompiledFloor(
  pageId: string,
  recognition: ReturnType<typeof recognizeCompiledNote>,
): Promise<boolean> {
  if (!recognition.recognized) return false;
  const page = await pageById(pageId);
  if (!page) return false;
  const sourceIds = parseCompiledNoteSourceIds(page.body_md).ids;
  const evidence = await compiledSourceEvidence(sourceIds);
  const identities = recognition.pathIdentity
    ? [recognition.pathIdentity]
    : evidence.owner_entities;
  const cluster = await compiledEntityClusterEvidence(identities);
  const representations = await compiledRepresentationTierEvidence(pageId);
  const target = Math.max(
    page.tier,
    representations.max_tier,
    noteTierEvidence(recognition, sourceIds, evidence, cluster),
  ) as 1 | 2;
  let changed = false;
  changed = (await retierPageEdges(pageId, target)) > 0 || changed;
  changed = (await setPageChunkTiers(pageId, target)) > 0 || changed;
  changed = (await setPageTier(pageId, target)) || changed;
  const chunks = await pageChunkSnapshot(pageId);
  if (chunks.length === 0 || target > page.tier) {
    await indexParent("page", pageId, page.body_md, page.title, target, {
      extractEdges: false,
      tierMode: "promote-page-floor",
    });
    changed = true;
  }
  return changed;
}

export async function brainSync(): Promise<SyncStats> {
  const brainDir = join(config.dataDir, "brain");
  // Validate the private root before the first readdir. Any failure is deliberately reduced
  // to the fixed unsafe-root code so callers cannot infer filesystem details.
  await preflightPrivateRoot(config.dataDir, brainDir);
  const files = await walkMd(brainDir, brainDir);
  const stats: SyncStats = {
    scanned: 0,
    changed: 0,
    unchanged: 0,
    deleted: 0,
    quarantined: 0,
    issues: [],
  };
  const seenPaths: string[] = [];
  const protectedPageIds: string[] = [];

  for (const file of files) {
    const relPath = relative(brainDir, file).replaceAll("\\", "/");
    const archiveTarget = resolveCompiledNoteArchiveTarget(brainDir, relPath);
    if (!archiveTarget) throw new Error(UNSAFE_PRIVATE_ROOT);
    await assertNoSymlinkComponents(config.dataDir, archiveTarget);
    const stat = await lstat(archiveTarget);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(UNSAFE_PRIVATE_ROOT);
    const raw = await Bun.file(archiveTarget).text();
    const rawTier = classifyFrontmatterTier(raw);
    if (rawTier.kind === "tier0" || rawTier.kind === "invalid") {
      stats.scanned++;
      await withCompiledNoteTargetLease(relPath, async () => {
        const quarantined = await quarantineGeneratedPageByPath(relPath);
        if (quarantined.status === "protected") {
          protectedPageIds.push(quarantined.pageId);
          stats.issues.push({
            target_hash: opaqueTargetHash(relPath),
            code: "protected_page_requires_owner",
          });
          return;
        }
        stats.quarantined++;
        stats.issues.push({
          target_hash: opaqueTargetHash(relPath),
          code: rawTier.kind === "tier0" ? "tier0_quarantined" : "invalid_tier_quarantined",
        });
      });
      continue;
    }
    const fm = parseFrontmatterDocument(raw);
    if (fm.status === "deleted") continue;
    stats.scanned++;
    seenPaths.push(relPath);

    await withCompiledNoteTargetLease(relPath, async () => {
      const current = await pageByPath(relPath);
      const incomingBody = normalizeCompiledNoteBody(fm.body);
      const existingRepresentation = current
        ? await compiledRepresentationTierEvidence(current.id)
        : null;
      const existingBlock = tierBlock([
        current?.tier,
        existingRepresentation?.min_tier,
        existingRepresentation?.page_tier,
        existingRepresentation?.chunk_min_tier,
        existingRepresentation?.chunk_max_tier,
        existingRepresentation?.edge_min_tier,
        existingRepresentation?.edge_max_tier,
        existingRepresentation?.entity_min_tier,
        existingRepresentation?.entity_max_tier,
      ]);
      const existingEvidenceBlock =
        existingBlock ??
        (existingRepresentation?.evidence_unresolved ? "source_evidence_unverifiable" : null);
      if (existingEvidenceBlock) {
        seenPaths.pop();
        const quarantined = await quarantineGeneratedPageByPath(relPath);
        if (quarantined.status === "protected") {
          protectedPageIds.push(quarantined.pageId);
          stats.issues.push({
            target_hash: opaqueTargetHash(relPath),
            code: "protected_page_requires_owner",
          });
          return;
        }
        stats.quarantined++;
        stats.issues.push({ target_hash: opaqueTargetHash(relPath), code: existingEvidenceBlock });
        return;
      }
      const currentRecognition = recognizeCompiledNote({
        path: relPath,
        source: current?.source,
        bodyMd: current?.source === COMPILED_NOTE_SOURCE ? current.body_md : incomingBody,
      });
      const sourceIds = currentRecognition.recognized
        ? current?.source === COMPILED_NOTE_SOURCE
          ? parseCompiledNoteSourceIds(current.body_md).ids
          : parseCompiledNoteSourceIds(incomingBody).ids
        : [];
      const sourceEvidence = currentRecognition.recognized
        ? await compiledSourceEvidence(sourceIds)
        : null;
      const identities =
        currentRecognition.recognized && currentRecognition.pathIdentity
          ? [currentRecognition.pathIdentity]
          : (sourceEvidence?.owner_entities ?? []);
      const cluster = currentRecognition.recognized
        ? await compiledEntityClusterEvidence(identities)
        : {
            source_chunk_ids: [],
            min_tier: null,
            max_tier: null,
            evidence_unresolved: true,
            latest_mention_at: null,
          };
      const representations = existingRepresentation;
      const compiledBlock = tierBlock([
        sourceEvidence?.min_tier,
        sourceEvidence?.max_tier,
        cluster.min_tier,
        cluster.max_tier,
        representations?.min_tier,
        representations?.chunk_min_tier,
        representations?.chunk_max_tier,
        representations?.edge_min_tier,
        representations?.edge_max_tier,
        representations?.entity_min_tier,
        representations?.entity_max_tier,
      ]);
      const sourceBlock =
        currentRecognition.recognized && sourceEvidence
          ? unresolvedCompiledEvidence(currentRecognition, sourceIds, sourceEvidence)
          : null;
      const evidenceBlock =
        compiledBlock ??
        ((currentRecognition.recognized && cluster.evidence_unresolved) ||
        representations?.evidence_unresolved
          ? "source_evidence_unverifiable"
          : sourceBlock);
      if (evidenceBlock) {
        seenPaths.pop();
        const quarantined = await quarantineGeneratedPageByPath(relPath);
        if (quarantined.status === "protected") {
          protectedPageIds.push(quarantined.pageId);
          stats.issues.push({
            target_hash: opaqueTargetHash(relPath),
            code: "protected_page_requires_owner",
          });
          return;
        }
        stats.quarantined++;
        stats.issues.push({ target_hash: opaqueTargetHash(relPath), code: evidenceBlock });
        return;
      }
      if (current?.source === COMPILED_NOTE_SOURCE) {
        let changed = await reconcileCompilerOwned(current, currentRecognition);
        changed = (await reconcileCompiledFloor(current.id, currentRecognition)) || changed;
        if (changed) stats.changed++;
        else stats.unchanged++;
        return;
      }
      const effectiveTier =
        currentRecognition.recognized && sourceEvidence
          ? Math.max(
              noteTierEvidence(currentRecognition, sourceIds, sourceEvidence, cluster),
              representations?.max_tier ?? 1,
              current?.tier ?? 1,
            )
          : (fm.tier ?? 1);
      const hash = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
      const bodyMd = currentRecognition.recognized ? incomingBody : fm.body;
      let changed = false;
      if (current && currentRecognition.recognized) {
        changed = (await retierPageEdges(current.id, effectiveTier as 1 | 2)) > 0 || changed;
        changed = (await setPageChunkTiers(current.id, effectiveTier as 1 | 2)) > 0 || changed;
      }
      const result = await upsertPage(
        {
          path: relPath,
          title: titleFrom(fm, relPath),
          bodyMd,
          contentHash: hash,
          tier: effectiveTier as 1 | 2,
          source: current?.source ?? "brain-sync",
        },
        currentRecognition.recognized ? { tierMode: "promote" } : undefined,
      );
      if (result.changed) {
        await indexParent(
          "page",
          result.id,
          bodyMd,
          titleFrom(fm, relPath),
          effectiveTier,
          currentRecognition.recognized
            ? { extractEdges: false, tierMode: "promote-page-floor" }
            : undefined,
        );
        if (currentRecognition.recognized) {
          await retierPageEdges(result.id, effectiveTier as 1 | 2);
          await setPageChunkTiers(result.id, effectiveTier as 1 | 2);
          await setPageTier(result.id, effectiveTier as 1 | 2);
        }
      }
      changed = result.changed || changed;
      if (currentRecognition.recognized) {
        changed = (await reconcileCompiledFloor(result.id, currentRecognition)) || changed;
      }
      if (changed) stats.changed++;
      else stats.unchanged++;
    });
  }

  const activePages = await activePagesForCompiledNoteReconciliation();
  const preservePageIds = [
    ...protectedPageIds,
    ...activePages
      .filter(
        (page) =>
          recognizeCompiledNote({
            path: page.path,
            source: page.source,
            bodyMd: page.body_md,
          }).recognized,
      )
      .map((page) => page.id),
  ];
  const deletedIds = await softDeletePagesNotIn(seenPaths, {
    preserveSources: [COMPILED_NOTE_SOURCE],
    preservePageIds,
  });
  for (const id of deletedIds) await replaceChunks("page", id, [], 1);
  stats.deleted = deletedIds.length;
  return stats;
}

// re-export for callers that only need page listing alongside sync
export { listActivePages };
