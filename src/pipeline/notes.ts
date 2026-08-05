import { join } from "node:path";
import {
  type NoteCandidate,
  type PageSnapshot,
  activePagesForCompiledNoteReconciliation,
  compiledEntityClusterEvidence,
  compiledRepresentationTierEvidence,
  compiledSourceEvidence,
  noteCandidates,
  noteSourceChunks,
  pageByPath,
  pageChunkSnapshot,
  quarantineGeneratedPageByPath,
  retierPageEdges,
  setPageChunkTiers,
  setPageContentHash,
  setPageTier,
  upsertPage,
  withCompiledNoteTargetLease,
  withCompiledNotesLease,
} from "../db/repo";
import { chunkMarkdown } from "../search/chunker";
import { indexParent } from "../search/index-parent";
import {
  assertNoSymlinkComponents,
  atomicWritePrivate,
  preflightPrivateRoot,
} from "../util/atomic-file";
import {
  COMPILED_NOTE_CREATOR,
  COMPILED_NOTE_MARKER,
  COMPILED_NOTE_SOURCE,
  type CompiledNoteKind,
  type NoteTier,
  compiledNoteIdentityFromPath,
  compiledNotePath,
  opaqueTargetHash,
  parseCompiledNoteSourceIds,
  recognizeCompiledNote,
  renderCompiledNoteArchive,
  resolveCompiledNoteArchiveTarget,
} from "../util/compiled-note-archive";
import { config } from "../util/config";
import {
  type BlockerRecoveryRecord,
  type CompiledNoteRecoveryV1,
  type RecoveryListing,
  listCompiledNoteRecoveryRecords,
  readPrivateRegularFileNoFollow,
  removeCompiledNoteRecoveryRecord,
  writeCompiledNoteRecoveryBlockRecord,
  writeCompiledNoteRecoveryRecord,
} from "./compiled-note-recovery";

const MIN_CHUNKS = 3;
const MAX_WORDS = 300;

export interface SourceChunk {
  id: string;
  parent_type: "page" | "journal" | "decision" | "interaction" | "task";
  parent_id: string;
  text: string;
  tier: number;
  edge_tier?: number;
  min_tier?: number;
  max_tier?: number;
  evidence_unresolved?: boolean;
}

export type NoteOperationCode =
  | "invalid_recovery_record"
  | "legacy_path_ambiguous"
  | "identity_conflict"
  | "model_distill_failed"
  | "recovery_write_failed"
  | "page_upsert_failed"
  | "hash_update_failed"
  | "archive_rename_failed"
  | "chunk_replace_failed"
  | "edge_retier_failed"
  | "verification_failed"
  | "recovery_remove_failed"
  | "unsafe_archive_path"
  | "source_changed_deferred"
  | "tier0_source_blocked"
  | "source_evidence_unverifiable";

class ConvergenceFailure extends Error {
  constructor(
    readonly code: NoteOperationCode,
    readonly failClosedTier: NoteTier,
  ) {
    super(code);
    this.name = "ConvergenceFailure";
  }
}

function convergenceFailure(
  error: unknown,
  fallbackCode: NoteOperationCode,
  fallbackTier: NoteTier,
): ConvergenceFailure {
  if (error instanceof ConvergenceFailure) return error;
  return new ConvergenceFailure(fallbackCode, fallbackTier);
}

class EvidenceBlock extends Error {
  constructor(readonly code: "tier0_source_blocked" | "source_evidence_unverifiable") {
    super(code);
    this.name = "EvidenceBlock";
  }
}

export type NoteResult =
  | {
      status: "created" | "updated" | "repaired" | "unchanged";
      page_id: string;
      target_hash: string;
      kind: CompiledNoteKind;
      tier: NoteTier;
      code?: "legacy_path_ambiguous" | "model_distill_failed" | "source_changed_deferred";
    }
  | {
      status: "failed";
      target_hash: string;
      page_id?: string;
      code: NoteOperationCode;
      kind?: CompiledNoteKind;
      tier?: NoteTier;
    };

export interface CompileNotesSummary {
  candidates: number;
  created: number;
  updated: number;
  repaired: number;
  unchanged: number;
  failed: number;
  results: NoteResult[];
}

export interface NoteReconcileDeps {
  distill(name: string, chunks: SourceChunk[], tier: NoteTier): Promise<string>;
  writeRecovery(record: CompiledNoteRecoveryV1): Promise<RecoveryListing & { valid: true }>;
  writeRecoveryBlock(
    record: BlockerRecoveryRecord,
  ): ReturnType<typeof writeCompiledNoteRecoveryBlockRecord>;
  upsertPage(
    input: Parameters<typeof upsertPage>[0],
    options: NonNullable<Parameters<typeof upsertPage>[1]>,
  ): ReturnType<typeof upsertPage>;
  updateHash(pageId: string, hash: string): Promise<void>;
  writeArchive(path: string, bytes: Uint8Array): Promise<void>;
  retierEdges(pageId: string, tier: NoteTier): Promise<number>;
  replaceIndex(pageId: string, bodyMd: string, title: string, tier: NoteTier): Promise<number>;
  removeRecovery(listing: Parameters<typeof removeCompiledNoteRecoveryRecord>[0]): Promise<void>;
}

// Trim to a bounded word count without inventing claims.
function capWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords ? text.trim() : `${words.slice(0, maxWords).join(" ")} …`;
}

export function heuristicDistill(name: string, chunks: SourceChunk[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const chunk of chunks) {
    const plain = chunk.text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`#>]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const sentence = (plain.split(/(?<=[.!?])\s+/)[0] ?? plain).trim();
    const key = sentence.toLowerCase();
    if (sentence.length < 8 || seen.has(key)) continue;
    seen.add(key);
    lines.push(sentence);
  }
  return capWords(`${name}: ${lines.join(" ")}`, MAX_WORDS);
}

async function modelDistill(
  name: string,
  chunks: SourceChunk[],
  effectiveTier: NoteTier,
): Promise<string> {
  const { classifyProviderForTier, classifyIsCloudForTier } = await import("../llm");
  const cloudRoute = classifyIsCloudForTier(effectiveTier);
  if (cloudRoute && effectiveTier > config.cloudMaxTier) {
    throw new Error("source tier above cloud ceiling");
  }
  const usable = chunks;
  if (usable.length === 0) throw new Error("source tier above cloud ceiling");
  const sources = usable
    .map((chunk, index) => `[S${index + 1}] ${chunk.text.slice(0, 1200)}`)
    .join("\n\n");
  const prompt = `You are compiling a factual reference note about "${name}" from the source excerpts below. Write a neutral, ${MAX_WORDS}-word-or-fewer distillation.\n\nSTRICT RULES:\n- Use ONLY facts stated in the sources. Invent NOTHING.\n- No speculation, opinions, or filler.\n\nSOURCES:\n${sources}\n\nReply with ONLY {"note": "<the distillation>"}.`;
  const raw = await classifyProviderForTier(effectiveTier).completeJson(prompt);
  const note = (JSON.parse(raw).note ?? "").toString().trim();
  if (!note) throw new Error("empty distillation");
  return capWords(note, MAX_WORDS);
}

function renderNote(name: string, distillation: string, chunks: SourceChunk[]): string {
  return `# ${name}\n\n${COMPILED_NOTE_MARKER}\n\n${distillation}\n\n## Sources\n${chunks
    .map((chunk) => `- ${chunk.id.toLowerCase()}`)
    .join("\n")}`;
}

function targetHash(path: string): string {
  return opaqueTargetHash(path);
}

function identityKey(kind: CompiledNoteKind, id: string): string {
  return `entity:${kind}:${id}`;
}

type WorkItem = {
  key: string;
  kind: CompiledNoteKind;
  entityId?: string;
  name: string;
  page?: PageSnapshot;
  candidate?: NoteCandidate;
  recovery?: RecoveryListing & { valid: true };
  conflict?: NoteOperationCode;
  ambiguous?: boolean;
};

function pageSources(page: PageSnapshot): string[] {
  return parseCompiledNoteSourceIds(page.body_md).ids;
}

function orderedSourceIds(chunks: SourceChunk[]): string[] {
  return chunks.map((chunk) => chunk.id.toLowerCase());
}

function dedupeSourceChunks(chunks: SourceChunk[]): SourceChunk[] {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    const id = chunk.id.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function sourceChunksForCandidate(kind: "person", id: string): Promise<SourceChunk[]> {
  return dedupeSourceChunks((await noteSourceChunks(kind, id)) as SourceChunk[]);
}

function sameOrderedSourceIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id.toLowerCase() === right[index]!.toLowerCase())
  );
}

function composeTier(values: number[]): NoteTier {
  if (values.some((tier) => tier === 0)) throw new EvidenceBlock("tier0_source_blocked");
  if (values.some((tier) => tier !== 1 && tier !== 2)) {
    throw new EvidenceBlock("source_evidence_unverifiable");
  }
  return (Math.max(...values) >= 2 ? 2 : 1) as NoteTier;
}

function sourceTier(chunks: SourceChunk[], floor: NoteTier = 1): NoteTier {
  if (chunks.some((chunk) => chunk.evidence_unresolved)) {
    throw new EvidenceBlock("source_evidence_unverifiable");
  }
  return composeTier([
    floor,
    ...chunks.flatMap((chunk) => [
      chunk.tier,
      chunk.edge_tier ?? chunk.tier,
      chunk.min_tier ?? chunk.tier,
      chunk.max_tier ?? chunk.tier,
    ]),
  ]);
}

function derivedFromChunks(chunks: SourceChunk[] | null, fallback: string | null): string | null {
  return chunks?.[0]?.parent_id ?? fallback;
}

async function sourceFreshness(sourceIds: string[]): Promise<Date | null> {
  if (sourceIds.length === 0) return null;
  return (await compiledSourceEvidence(sourceIds)).latest_mention_at;
}

async function authoritativeTier(
  item: WorkItem,
  sourceIds: string[],
  chunks: SourceChunk[],
  floor: NoteTier = 1,
): Promise<NoteTier> {
  const levels = [
    floor,
    ...(item.page ? [item.page.tier] : []),
    ...(item.recovery ? [item.recovery.record.tier] : []),
    ...(item.candidate ? [item.candidate.min_tier, item.candidate.max_tier] : []),
    ...chunks.flatMap((chunk) => [
      chunk.tier,
      chunk.edge_tier ?? chunk.tier,
      chunk.min_tier ?? chunk.tier,
      chunk.max_tier ?? chunk.tier,
    ]),
  ];
  if (item.candidate?.evidence_unresolved || chunks.some((chunk) => chunk.evidence_unresolved)) {
    throw new EvidenceBlock("source_evidence_unverifiable");
  }
  if (sourceIds.length > 0) {
    const evidence = await compiledSourceEvidence(sourceIds);
    if (
      evidence.unresolved_ids.length > 0 ||
      evidence.resolved.length === 0 ||
      evidence.min_tier === null ||
      evidence.max_tier === null
    ) {
      throw new EvidenceBlock("source_evidence_unverifiable");
    }
    if (
      item.entityId &&
      (evidence.owner_entities.length !== 1 ||
        evidence.owner_entities[0]!.kind !== item.kind ||
        evidence.owner_entities[0]!.entityId !== item.entityId)
    ) {
      throw new EvidenceBlock("source_evidence_unverifiable");
    }
    levels.push(evidence.min_tier, evidence.max_tier);
  } else if (item.page || item.recovery || item.candidate) {
    throw new EvidenceBlock("source_evidence_unverifiable");
  }
  if (item.entityId) {
    const cluster = await compiledEntityClusterEvidence([
      { kind: item.kind, entityId: item.entityId },
    ]);
    if (cluster.evidence_unresolved || cluster.min_tier === null || cluster.max_tier === null) {
      throw new EvidenceBlock("source_evidence_unverifiable");
    }
    if (cluster.min_tier !== null) levels.push(cluster.min_tier);
    if (cluster.max_tier !== null) levels.push(cluster.max_tier);
  }
  if (item.page) {
    const representation = await compiledRepresentationTierEvidence(item.page.id);
    if (representation.evidence_unresolved) {
      throw new EvidenceBlock("source_evidence_unverifiable");
    }
    levels.push(
      representation.min_tier,
      representation.page_tier,
      ...(representation.chunk_min_tier === null ? [] : [representation.chunk_min_tier]),
      ...(representation.chunk_max_tier === null ? [] : [representation.chunk_max_tier]),
      ...(representation.edge_min_tier === null ? [] : [representation.edge_min_tier]),
      ...(representation.edge_max_tier === null ? [] : [representation.edge_max_tier]),
      ...(representation.entity_min_tier === null ? [] : [representation.entity_min_tier]),
      ...(representation.entity_max_tier === null ? [] : [representation.entity_max_tier]),
    );
    const pageChunks = await pageChunkSnapshot(item.page.id);
    levels.push(...pageChunks.map((chunk) => chunk.tier));
  }
  return composeTier(levels);
}

async function pageIdentity(page: PageSnapshot): Promise<{
  identity: { kind: CompiledNoteKind; entityId: string } | null;
  ambiguous: boolean;
}> {
  const pathIdentity = compiledNoteIdentityFromPath(page.path);
  const ids = pageSources(page);
  if (pathIdentity) {
    if (ids.length > 0) {
      const evidence = await compiledSourceEvidence(ids);
      if (
        evidence.owner_entities.some(
          (owner) => owner.kind !== pathIdentity.kind || owner.entityId !== pathIdentity.entityId,
        )
      ) {
        return { identity: null, ambiguous: true };
      }
    }
    return { identity: pathIdentity, ambiguous: false };
  }
  if (ids.length === 0) return { identity: null, ambiguous: false };
  const evidence = await compiledSourceEvidence(ids);
  if (evidence.owner_entities.length === 1) {
    return { identity: evidence.owner_entities[0]!, ambiguous: false };
  }
  return { identity: null, ambiguous: evidence.owner_entities.length > 1 };
}

function ownerMatchesWorkItem(
  item: WorkItem,
  owner: { kind: CompiledNoteKind; entityId: string },
): boolean {
  return owner.kind === item.kind && owner.entityId === item.entityId;
}

async function reloadedNonRecoveryPageMatches(
  item: WorkItem,
  page: PageSnapshot,
): Promise<boolean> {
  if (!item.entityId) {
    if (!item.page || page.id !== item.page.id) return false;
    const recognized = recognizeCompiledNote({
      path: page.path,
      source: page.source,
      bodyMd: page.body_md,
    });
    if (!recognized.recognized) return false;
    const resolved = await pageIdentity(page);
    const currentKey = resolved.identity
      ? identityKey(resolved.identity.kind, resolved.identity.entityId)
      : `page:${page.id}`;
    return currentKey === item.key;
  }

  const pathIdentity = compiledNoteIdentityFromPath(page.path);
  const parsed = parseCompiledNoteSourceIds(page.body_md);
  if (pathIdentity) {
    if (!ownerMatchesWorkItem(item, pathIdentity)) return false;
    if (page.source === COMPILED_NOTE_SOURCE) {
      if (parsed.ids.length === 0) return true;
      const evidence = await compiledSourceEvidence(parsed.ids);
      return evidence.owner_entities.every((owner) => ownerMatchesWorkItem(item, owner));
    }
    const independentlyRecognized = recognizeCompiledNote({
      path: "reloaded-canonical.md",
      source: null,
      bodyMd: page.body_md,
    });
    if (
      !independentlyRecognized.recognized ||
      !parsed.hasSourcesHeading ||
      parsed.ids.length === 0
    ) {
      return false;
    }
    const evidence = await compiledSourceEvidence(parsed.ids);
    return (
      evidence.unresolved_ids.length === 0 &&
      evidence.owner_entities.length === 1 &&
      ownerMatchesWorkItem(item, evidence.owner_entities[0]!)
    );
  }

  const independentlyRecognized = recognizeCompiledNote({
    path: "reloaded-legacy.md",
    source: null,
    bodyMd: page.body_md,
  });
  if (!independentlyRecognized.recognized || !parsed.hasSourcesHeading || parsed.ids.length === 0) {
    return false;
  }
  const evidence = await compiledSourceEvidence(parsed.ids);
  return (
    evidence.owner_entities.length === 1 && ownerMatchesWorkItem(item, evidence.owner_entities[0]!)
  );
}

async function recoveryOwnership(
  listing: RecoveryListing & { valid: true },
): Promise<{ page: PageSnapshot | null; conflict: boolean }> {
  const record = listing.record;
  const page = await pageByPath(record.target_path);
  const pathIdentity = compiledNoteIdentityFromPath(record.target_path);

  // Current page Sources are the only ownership authority during recovery.
  // Historical source ids in the record are evidence for reconstruction, not
  // permission to overwrite a page that now belongs to somebody else.
  const currentOwnershipMatches = async (current: PageSnapshot): Promise<boolean> => {
    const parsed = parseCompiledNoteSourceIds(current.body_md);
    if (current.source === COMPILED_NOTE_SOURCE) {
      // Compiler-owned pages remain authoritative through a crash even when
      // their source rows have since been deleted.  Resolvable contradictory
      // ownership is still a conflict.
      if (!parsed.hasSourcesHeading || parsed.ids.length === 0) return false;
      const evidence = await compiledSourceEvidence(parsed.ids);
      return (
        evidence.owner_entities.length === 0 ||
        (evidence.unresolved_ids.length === 0 &&
          evidence.owner_entities.length === 1 &&
          evidence.owner_entities[0]!.kind === record.entity_kind &&
          evidence.owner_entities[0]!.entityId === record.entity_id)
      );
    }
    const recognized = recognizeCompiledNote({
      path: "recovery-current.md",
      source: current.source === COMPILED_NOTE_SOURCE ? current.source : null,
      bodyMd: current.body_md,
    });
    if (!recognized.recognized || !parsed.hasSourcesHeading || parsed.ids.length === 0)
      return false;
    const evidence = await compiledSourceEvidence(parsed.ids);
    if (evidence.unresolved_ids.length > 0 || evidence.owner_entities.length !== 1) return false;
    const owner = evidence.owner_entities[0]!;
    return owner.kind === record.entity_kind && owner.entityId === record.entity_id;
  };
  const legacyOwnershipMatches = async (current: PageSnapshot): Promise<boolean> => {
    const parsed = parseCompiledNoteSourceIds(current.body_md);
    const recognized = recognizeCompiledNote({
      path: "recovery-current.md",
      source: current.source === COMPILED_NOTE_SOURCE ? current.source : null,
      bodyMd: current.body_md,
    });
    if (!recognized.recognized || !parsed.hasSourcesHeading || parsed.ids.length === 0)
      return false;
    const evidence = await compiledSourceEvidence(parsed.ids);
    if (evidence.unresolved_ids.length > 0 || evidence.owner_entities.length !== 1) return false;
    const owner = evidence.owner_entities[0]!;
    return owner.kind === record.entity_kind && owner.entityId === record.entity_id;
  };

  if (pathIdentity) {
    if (pathIdentity.kind !== record.entity_kind || pathIdentity.entityId !== record.entity_id) {
      return { page, conflict: true };
    }
    if (!page) return { page, conflict: record.expected_page_id !== null };
    if (record.expected_page_id !== null && record.expected_page_id !== page.id)
      return { page, conflict: true };
    if (!(await currentOwnershipMatches(page))) return { page, conflict: true };
    return { page, conflict: false };
  }
  if (!page || page.id !== record.expected_page_id) return { page, conflict: true };
  return { page, conflict: !(await legacyOwnershipMatches(page)) };
}

async function buildWorkUnion(
  recovery: RecoveryListing[],
  pages: PageSnapshot[],
  candidates: NoteCandidate[],
): Promise<{ invalid: NoteResult[]; conflicts: NoteResult[]; work: WorkItem[] }> {
  const invalid: NoteResult[] = [];
  const conflicts: NoteResult[] = [];
  const conflictPageIds = new Set<string>();
  const conflictKeys = new Set<string>();
  const work = new Map<string, WorkItem>();
  for (const listing of recovery) {
    if (!listing.valid) {
      invalid.push({
        status: "failed",
        target_hash: listing.filenameHash,
        code: "invalid_recovery_record",
      });
      continue;
    }
    const own = await recoveryOwnership(listing);
    const record = listing.record;
    const key = identityKey(record.entity_kind, record.entity_id);
    if (own.conflict) {
      if (own.page) conflictPageIds.add(own.page.id);
      if (record.expected_page_id) conflictPageIds.add(record.expected_page_id);
      // A legacy-path recovery conflict belongs to that path only; an
      // otherwise eligible canonical candidate must still converge.  A
      // canonical-path conflict remains a claim on the canonical identity.
      if (compiledNoteIdentityFromPath(record.target_path)) conflictKeys.add(key);
      conflicts.push({
        status: "failed",
        target_hash: targetHash(record.target_path),
        page_id: own.page?.id,
        code: "identity_conflict",
        kind: record.entity_kind,
        tier: record.tier,
      });
      continue;
    }
    work.set(key, {
      key,
      kind: record.entity_kind,
      entityId: record.entity_id,
      name: record.title,
      page: own.page ?? undefined,
      recovery: listing,
    });
  }
  for (const page of pages) {
    if (conflictPageIds.has(page.id)) continue;
    const recognized = recognizeCompiledNote({
      path: page.path,
      source: page.source,
      bodyMd: page.body_md,
    });
    if (!recognized.recognized) continue;
    const canonicalPathIdentity = compiledNoteIdentityFromPath(page.path);
    if (canonicalPathIdentity && page.source !== COMPILED_NOTE_SOURCE) {
      const bodyRecognition = recognizeCompiledNote({
        path: "canonical-current.md",
        source: page.source,
        bodyMd: page.body_md,
      });
      if (!bodyRecognition.recognized) {
        const key = identityKey(canonicalPathIdentity.kind, canonicalPathIdentity.entityId);
        conflictKeys.add(key);
        conflictPageIds.add(page.id);
        conflicts.push({
          status: "failed",
          target_hash: targetHash(page.path),
          page_id: page.id,
          code: "identity_conflict",
          kind: canonicalPathIdentity.kind,
          tier: 2,
        });
        continue;
      }
    }
    const resolved = await pageIdentity(page);
    const pathIdentity = resolved.identity;
    if (resolved.ambiguous && !pathIdentity) {
      const canonical = compiledNoteIdentityFromPath(page.path);
      if (canonical) {
        const key = identityKey(canonical.kind, canonical.entityId);
        conflictKeys.add(key);
        conflictPageIds.add(page.id);
        conflicts.push({
          status: "failed",
          target_hash: targetHash(page.path),
          page_id: page.id,
          code: "identity_conflict",
          kind: canonical.kind,
          tier: 2,
        });
        continue;
      }
    }
    const key = pathIdentity
      ? identityKey(pathIdentity.kind, pathIdentity.entityId)
      : `page:${page.id}`;
    const existing = work.get(key);
    if (existing) {
      existing.page = existing.page ?? page;
      continue;
    }
    work.set(key, {
      key,
      kind: pathIdentity?.kind ?? "person",
      entityId: pathIdentity?.entityId,
      name: page.title,
      page,
      ambiguous: resolved.ambiguous,
    });
  }
  for (const candidate of candidates) {
    const key = identityKey(candidate.kind, candidate.id);
    if (conflictKeys.has(key)) continue;
    const existing = work.get(key);
    if (existing) {
      existing.candidate = candidate;
    } else {
      work.set(key, {
        key,
        kind: candidate.kind,
        entityId: candidate.id,
        name: candidate.name,
        candidate,
      });
    }
  }
  return {
    invalid,
    conflicts,
    work: [...work.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function defaults(overrides?: Partial<NoteReconcileDeps>): NoteReconcileDeps {
  return {
    distill: async (name, chunks, tier) =>
      config.mockOllama ? heuristicDistill(name, chunks) : modelDistill(name, chunks, tier),
    writeRecovery: writeCompiledNoteRecoveryRecord,
    writeRecoveryBlock: writeCompiledNoteRecoveryBlockRecord,
    upsertPage,
    updateHash: setPageContentHash,
    writeArchive: async (path, bytes) => atomicWritePrivate(path, bytes),
    retierEdges: retierPageEdges,
    replaceIndex: async (pageId, body, title, tier) =>
      indexParent("page", pageId, body, title, tier, {
        extractEdges: false,
        tierMode: "promote-page-floor",
      }),
    removeRecovery: removeCompiledNoteRecoveryRecord,
    ...overrides,
  };
}

async function convergePage(
  item: WorkItem,
  leasedTargetPath: string,
  body: string,
  title: string,
  requestedTier: NoteTier,
  derivedFrom: string | null,
  deps: NoteReconcileDeps,
  allowRaise = true,
): Promise<{ pageId: string; changed: boolean; tier: NoteTier }> {
  const path = leasedTargetPath;
  const tier = await authoritativeTier(
    item,
    parseCompiledNoteSourceIds(body).ids,
    [],
    requestedTier,
  );
  const archive = renderCompiledNoteArchive({ title, tier, bodyMd: body });
  const archiveTarget = resolveCompiledNoteArchiveTarget(join(config.dataDir, "brain"), path);
  if (!archiveTarget) {
    const existing = await pageByPath(path);
    if (existing) {
      try {
        await deps.retierEdges(existing.id, 2);
        await setPageChunkTiers(existing.id, 2);
        await setPageTier(existing.id, 2);
        const promoted = await deps.upsertPage(
          {
            path,
            title: existing.title,
            bodyMd: existing.body_md,
            contentHash: existing.content_hash,
            tier: 2,
            source: existing.source,
            createdBy: existing.created_by,
            derivedFrom: existing.derived_from,
          },
          { provenanceMode: "preserve", contentHashMode: "preserve-existing", tierMode: "promote" },
        );
        await deps.replaceIndex(promoted.id, existing.body_md, existing.title, 2);
        await deps.retierEdges(promoted.id, 2);
      } catch {
        // The unsafe-path result remains the only externally visible failure code.
      }
    }
    throw new ConvergenceFailure("unsafe_archive_path", 2);
  }
  try {
    await assertNoSymlinkComponents(config.dataDir, archiveTarget);
  } catch {
    throw new ConvergenceFailure("unsafe_archive_path", 2);
  }
  const observedPage = await pageByPath(path);
  let changed = false;
  let edgeRows = 0;
  if (observedPage) {
    try {
      // Retier existing representations before page upsert so no mixed-tier
      // state can be observed between the two writes.
      edgeRows += await deps.retierEdges(observedPage.id, tier);
      const chunkRows = await setPageChunkTiers(observedPage.id, tier);
      const pageRaised = await setPageTier(observedPage.id, tier);
      if (edgeRows > 0 || chunkRows > 0 || pageRaised) changed = true;
    } catch {
      throw new ConvergenceFailure("edge_retier_failed", tier);
    }
  }
  const existingChunks = observedPage ? await pageChunkSnapshot(observedPage.id) : [];
  const pageNeedsUpsert =
    !observedPage ||
    observedPage.title !== title ||
    observedPage.body_md !== archive.bodyMd ||
    observedPage.tier < tier ||
    observedPage.status !== "active" ||
    observedPage.content_hash !== archive.contentHash ||
    observedPage.source !== COMPILED_NOTE_SOURCE ||
    observedPage.created_by !== COMPILED_NOTE_CREATOR ||
    (observedPage.derived_from ?? null) !== (derivedFrom ?? null);
  let page: { id: string; changed: boolean; created: boolean };
  if (!pageNeedsUpsert && observedPage) {
    page = { id: observedPage.id, changed: false, created: false };
  } else {
    try {
      page = await deps.upsertPage(
        {
          path,
          title,
          bodyMd: archive.bodyMd,
          contentHash: archive.contentHash,
          tier,
          source: COMPILED_NOTE_SOURCE,
          createdBy: COMPILED_NOTE_CREATOR,
          derivedFrom,
        },
        { provenanceMode: "replace", contentHashMode: "preserve-existing", tierMode: "promote" },
      );
    } catch {
      throw new ConvergenceFailure("page_upsert_failed", tier);
    }
  }
  if (page.changed) changed = true;
  if (observedPage && observedPage.content_hash !== archive.contentHash) {
    try {
      await deps.updateHash(page.id, archive.contentHash);
    } catch {
      throw new ConvergenceFailure("hash_update_failed", tier);
    }
    changed = true;
  }
  let archiveBytes: Uint8Array | null = null;
  try {
    archiveBytes = await readPrivateRegularFileNoFollow(config.dataDir, archiveTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConvergenceFailure("unsafe_archive_path", 2);
    }
  }
  if (!archiveBytes || Buffer.from(archiveBytes).compare(Buffer.from(archive.bytes)) !== 0) {
    try {
      await assertNoSymlinkComponents(config.dataDir, archiveTarget);
      await deps.writeArchive(archiveTarget, archive.bytes);
    } catch {
      throw new ConvergenceFailure("archive_rename_failed", tier);
    }
    changed = true;
  }
  let needsIndex =
    existingChunks.length === 0 ||
    existingChunks.length !== chunkMarkdown(archive.bodyMd, title).length;
  if (!needsIndex) {
    const expected = chunkMarkdown(archive.bodyMd, title);
    needsIndex = existingChunks.some(
      (chunk, index) => chunk.ord !== index || chunk.text !== expected[index] || chunk.tier < tier,
    );
  }
  if (needsIndex) {
    try {
      await deps.replaceIndex(page.id, archive.bodyMd, title, tier);
    } catch {
      throw new ConvergenceFailure("chunk_replace_failed", tier);
    }
    changed = true;
  }
  try {
    edgeRows += await deps.retierEdges(page.id, tier);
  } catch {
    throw new ConvergenceFailure("edge_retier_failed", tier);
  }
  if (edgeRows > 0) changed = true;
  let verifiedPage: PageSnapshot | null = null;
  let verifiedChunks: Awaited<ReturnType<typeof pageChunkSnapshot>> = [];
  let verifiedArchive: Uint8Array | null = null;
  let representation: Awaited<ReturnType<typeof compiledRepresentationTierEvidence>> | null = null;
  let sourceFloor = 1;
  let clusterFloor = 1;
  try {
    verifiedArchive = await readPrivateRegularFileNoFollow(config.dataDir, archiveTarget);
  } catch {
    throw new ConvergenceFailure("unsafe_archive_path", 2);
  }
  try {
    verifiedPage = await pageByPath(path);
    verifiedChunks = await pageChunkSnapshot(page.id);
    representation = await compiledRepresentationTierEvidence(page.id);
    const parsedSources = parseCompiledNoteSourceIds(archive.bodyMd);
    const sourceEvidence = await compiledSourceEvidence(parsedSources.ids);
    if (
      !parsedSources.hasSourcesHeading ||
      parsedSources.ids.length === 0 ||
      sourceEvidence.unresolved_ids.length > 0 ||
      sourceEvidence.resolved.length === 0 ||
      sourceEvidence.min_tier === null ||
      sourceEvidence.max_tier === null ||
      (item.entityId !== undefined &&
        (sourceEvidence.owner_entities.length !== 1 ||
          sourceEvidence.owner_entities[0]!.kind !== item.kind ||
          sourceEvidence.owner_entities[0]!.entityId !== item.entityId))
    ) {
      throw new EvidenceBlock("source_evidence_unverifiable");
    }
    sourceFloor = composeTier([sourceEvidence.min_tier, sourceEvidence.max_tier]);
    if (item.entityId) {
      const clusterEvidence = await compiledEntityClusterEvidence([
        { kind: item.kind, entityId: item.entityId },
      ]);
      if (
        clusterEvidence.evidence_unresolved ||
        clusterEvidence.min_tier === null ||
        clusterEvidence.max_tier === null
      ) {
        throw new EvidenceBlock("source_evidence_unverifiable");
      }
      clusterFloor = composeTier([clusterEvidence.min_tier, clusterEvidence.max_tier]);
    }
    if (representation?.evidence_unresolved) {
      throw new EvidenceBlock("source_evidence_unverifiable");
    }
  } catch (error) {
    if (error instanceof EvidenceBlock) throw error;
    throw new ConvergenceFailure("verification_failed", 2);
  }
  const expectedChunks = chunkMarkdown(archive.bodyMd, title);
  const exactChunks =
    verifiedChunks.length === expectedChunks.length &&
    verifiedChunks.every(
      (chunk, index) =>
        chunk.ord === index && chunk.text === expectedChunks[index] && chunk.tier >= tier,
    );
  const verifiedFloor = composeTier([
    verifiedPage?.tier ?? 1,
    ...verifiedChunks.map((chunk) => chunk.tier),
    representation?.min_tier ?? 1,
    representation?.page_tier ?? 1,
    ...(representation?.chunk_min_tier === null || representation?.chunk_min_tier === undefined
      ? []
      : [representation.chunk_min_tier]),
    ...(representation?.chunk_max_tier === null || representation?.chunk_max_tier === undefined
      ? []
      : [representation.chunk_max_tier]),
    ...(representation?.edge_min_tier === null || representation?.edge_min_tier === undefined
      ? []
      : [representation.edge_min_tier]),
    ...(representation?.edge_max_tier === null || representation?.edge_max_tier === undefined
      ? []
      : [representation.edge_max_tier]),
    ...(representation?.entity_min_tier === null || representation?.entity_min_tier === undefined
      ? []
      : [representation.entity_min_tier]),
    ...(representation?.entity_max_tier === null || representation?.entity_max_tier === undefined
      ? []
      : [representation.entity_max_tier]),
    sourceFloor,
    clusterFloor,
  ]);
  if (verifiedFloor > tier) {
    if (!allowRaise) {
      throw new ConvergenceFailure("verification_failed", verifiedFloor);
    }
    try {
      const raised = await convergePage(
        item,
        leasedTargetPath,
        body,
        title,
        verifiedFloor,
        derivedFrom,
        deps,
        false,
      );
      return { ...raised, changed: changed || raised.changed };
    } catch (error) {
      if (error instanceof EvidenceBlock) throw error;
      const failure = convergenceFailure(error, "verification_failed", verifiedFloor);
      throw new ConvergenceFailure(failure.code, verifiedFloor);
    }
  }
  if (
    !verifiedPage ||
    verifiedPage.id !== page.id ||
    verifiedPage.status !== "active" ||
    verifiedPage.title !== title ||
    verifiedPage.body_md !== archive.bodyMd ||
    verifiedPage.content_hash !== archive.contentHash ||
    verifiedPage.source !== COMPILED_NOTE_SOURCE ||
    verifiedPage.created_by !== COMPILED_NOTE_CREATOR ||
    (verifiedPage.derived_from ?? null) !== (derivedFrom ?? null) ||
    verifiedPage.tier < tier ||
    !exactChunks ||
    !representation ||
    representation.max_tier < tier ||
    (representation.edge_count > 0 &&
      (representation.edge_min_tier !== tier || representation.edge_max_tier !== tier)) ||
    !verifiedArchive ||
    Buffer.from(verifiedArchive).compare(Buffer.from(archive.bytes)) !== 0
  ) {
    throw new ConvergenceFailure("verification_failed", tier);
  }
  return { pageId: page.id, changed, tier };
}

async function reconcileAllowedLocked(
  item: WorkItem,
  leasedTargetPath: string,
  deps: NoteReconcileDeps,
): Promise<NoteResult> {
  const targetPath = leasedTargetPath;
  const hash = targetHash(targetPath);
  if (item.conflict)
    return {
      status: "failed",
      target_hash: hash,
      page_id: item.page?.id,
      code: item.conflict,
      kind: item.kind,
      tier: 2,
    };
  let body: string;
  let title = item.name;
  let tier: NoteTier = 1;
  let distilled = false;
  let statusBase: "created" | "updated" | "repaired" | "unchanged" = item.page
    ? "repaired"
    : "created";
  let modelCode: "model_distill_failed" | undefined;
  let sourceChangedDeferred = false;
  let distilledChunks: SourceChunk[] | null = null;
  let distilledFreshnessAt: Date | null = null;
  let recoveryToRemove: (RecoveryListing & { valid: true }) | null = item.recovery ?? null;

  const runDistill = async (
    chunks: SourceChunk[],
    effectiveTier: NoteTier,
  ): Promise<string | null> => {
    try {
      return await deps.distill(item.candidate?.name ?? title, chunks, effectiveTier);
    } catch {
      console.error(`[dream:notes] model_distill_failed target=${hash}`);
      try {
        modelCode = "model_distill_failed";
        return heuristicDistill(item.candidate?.name ?? title, chunks);
      } catch {
        return null;
      }
    }
  };

  if (item.recovery) {
    body = item.recovery.record.body_md;
    title = item.recovery.record.title;
    tier = item.recovery.record.tier;
    const evidence = await compiledSourceEvidence(item.recovery.record.source_chunk_ids);
    if (
      evidence.unresolved_ids.length > 0 ||
      evidence.owner_entities.length !== 1 ||
      evidence.owner_entities[0]!.kind !== item.kind ||
      evidence.owner_entities[0]!.entityId !== item.entityId
    ) {
      throw new EvidenceBlock("source_evidence_unverifiable");
    }
    tier = await authoritativeTier(
      item,
      item.recovery.record.source_chunk_ids,
      [],
      sourceTier([], Math.max(tier, evidence.max_tier ?? 1) as NoteTier),
    );
  } else if (item.page && !item.candidate) {
    body = item.page.body_md;
    title = item.page.title;
    const evidence = await compiledSourceEvidence(pageSources(item.page));
    tier = await authoritativeTier(
      item,
      pageSources(item.page),
      [],
      Math.max(
        item.page.tier,
        evidence.max_tier ?? item.page.tier,
        item.ambiguous ? 2 : 1,
      ) as NoteTier,
    );
  } else if (item.page && item.candidate) {
    body = item.page.body_md;
    title = item.page.title;
    let staleDistillTier = false;
    const chunks = await sourceChunksForCandidate(item.candidate.kind, item.candidate.id);
    const ids = orderedSourceIds(chunks);
    const freshness = await sourceFreshness(ids);
    tier = await authoritativeTier(
      item,
      ids,
      chunks,
      composeTier([item.page.tier, item.candidate.min_tier, item.candidate.max_tier]),
    );
    const latest = item.candidate.latest_mention_at.getTime();
    const stale =
      latest > item.page.updated_at.getTime() || !sameOrderedSourceIds(pageSources(item.page), ids);
    if (stale) {
      const distilledText = await runDistill(chunks, tier);
      if (distilledText !== null) {
        body = renderNote(item.candidate.name, distilledText, chunks);
        distilled = true;
        distilledChunks = chunks;
        distilledFreshnessAt = freshness;
        statusBase = "updated";
        const afterChunks = await sourceChunksForCandidate(item.candidate.kind, item.candidate.id);
        const afterIds = orderedSourceIds(afterChunks);
        const afterFreshness = await sourceFreshness(afterIds);
        sourceChangedDeferred =
          !sameOrderedSourceIds(ids, afterIds) ||
          (!!freshness && !!afterFreshness && afterFreshness.getTime() > freshness.getTime());
        tier = await authoritativeTier(
          item,
          afterIds,
          afterChunks,
          Math.max(item.page.tier, item.candidate.max_tier, 1) as NoteTier,
        );
        staleDistillTier = true;
      }
    }
    if (!staleDistillTier) {
      const evidence = await compiledSourceEvidence(pageSources(item.page));
      tier = await authoritativeTier(
        item,
        ids,
        chunks,
        Math.max(item.page.tier, item.candidate.max_tier, evidence.max_tier ?? 1) as NoteTier,
      );
    }
    if (!resolveCompiledNoteArchiveTarget(join(config.dataDir, "brain"), item.page.path)) tier = 2;
  } else if (item.candidate) {
    const chunks = await sourceChunksForCandidate(item.candidate.kind, item.candidate.id);
    const beforeIds = orderedSourceIds(chunks);
    const beforeFreshness = await sourceFreshness(beforeIds);
    tier = await authoritativeTier(item, beforeIds, chunks, sourceTier(chunks));
    const distilledText = await runDistill(chunks, tier);
    if (distilledText !== null) {
      body = renderNote(item.candidate.name, distilledText, chunks);
      distilled = true;
      distilledChunks = chunks;
      distilledFreshnessAt = beforeFreshness;
      const afterChunks = await sourceChunksForCandidate(item.candidate.kind, item.candidate.id);
      const afterIds = orderedSourceIds(afterChunks);
      const afterFreshness = await sourceFreshness(afterIds);
      sourceChangedDeferred =
        !sameOrderedSourceIds(beforeIds, afterIds) ||
        (!!beforeFreshness &&
          !!afterFreshness &&
          afterFreshness.getTime() > beforeFreshness.getTime());
      tier = await authoritativeTier(item, afterIds, afterChunks, sourceTier(afterChunks));
      statusBase = "created";
    } else {
      return {
        status: "failed",
        target_hash: hash,
        code: "model_distill_failed",
        kind: item.kind,
        tier: 2,
      };
    }
  } else {
    return {
      status: "failed",
      target_hash: hash,
      code: "identity_conflict",
      kind: item.kind,
      tier: 2,
    };
  }

  const writeDistilledRecovery = async (
    expectedPageId: string | null,
  ): Promise<(RecoveryListing & { valid: true }) | null> => {
    const archive = renderCompiledNoteArchive({ title, tier, bodyMd: body! });
    const sourceIds = distilledChunks
      ? orderedSourceIds(distilledChunks)
      : parseCompiledNoteSourceIds(archive.bodyMd).ids;
    if (sourceIds.length === 0) return null;
    const freshness = distilledFreshnessAt ?? (await sourceFreshness(sourceIds));
    const evidence = await compiledSourceEvidence(sourceIds);
    const record: CompiledNoteRecoveryV1 = {
      version: 1,
      entity_kind: item.kind,
      entity_id: item.entityId!,
      expected_page_id: expectedPageId,
      target_path: targetPath,
      title,
      tier,
      derived_from:
        evidence.representative_parent_id ?? derivedFromChunks(distilledChunks, sourceIds[0]!)!,
      source_chunk_ids: sourceIds,
      source_freshness_at:
        freshness?.toISOString() ??
        item.candidate?.latest_mention_at.toISOString() ??
        new Date().toISOString(),
      body_md: archive.bodyMd,
      archive_sha256: archive.contentHash,
    };
    try {
      return await deps.writeRecovery(record);
    } catch {
      return null;
    }
  };

  if (distilled && !item.recovery) {
    const listing = await writeDistilledRecovery(item.page?.id ?? null);
    if (!listing)
      return {
        status: "failed",
        target_hash: hash,
        page_id: item.page?.id,
        code: "recovery_write_failed",
        kind: item.kind,
        tier,
      };
    recoveryToRemove = listing;
  }

  let converged: { pageId: string; changed: boolean; tier: NoteTier };
  try {
    const bodySourceIds = parseCompiledNoteSourceIds(body!).ids;
    const bodyEvidence = await compiledSourceEvidence(bodySourceIds);
    converged = await convergePage(
      item,
      targetPath,
      body!,
      title,
      tier!,
      bodyEvidence.representative_parent_id ??
        item.recovery?.record.derived_from ??
        derivedFromChunks(distilledChunks, item.page?.derived_from ?? bodySourceIds[0] ?? null),
      deps,
    );
    tier = converged.tier;
  } catch (error) {
    if (error instanceof EvidenceBlock) throw error;
    const failure = convergenceFailure(error, "page_upsert_failed", tier);
    return {
      status: "failed",
      target_hash: hash,
      page_id: item.page?.id,
      code: failure.code,
      kind: item.kind,
      tier: failure.failClosedTier,
    };
  }

  if (item.recovery && item.kind === "person" && item.entityId) {
    let chunks: SourceChunk[];
    let beforeIds: string[];
    let beforeFreshness: Date | null;
    try {
      chunks = await sourceChunksForCandidate(item.kind, item.entityId);
      beforeIds = orderedSourceIds(chunks);
      beforeFreshness = await sourceFreshness(beforeIds);
    } catch {
      return {
        status: "failed",
        target_hash: hash,
        page_id: converged.pageId,
        code: "verification_failed",
        kind: item.kind,
        tier: 2,
      };
    }
    const recordedFreshness = new Date(item.recovery.record.source_freshness_at);
    const recoveryStale =
      !sameOrderedSourceIds(item.recovery.record.source_chunk_ids, beforeIds) ||
      (!!beforeFreshness && beforeFreshness.getTime() > recordedFreshness.getTime());
    if (recoveryStale && chunks.length >= MIN_CHUNKS) {
      statusBase = "updated";
      tier = await authoritativeTier(item, beforeIds, chunks, sourceTier(chunks, tier));
      const distilledText = await runDistill(chunks, tier);
      if (distilledText !== null) {
        body = renderNote(item.candidate?.name ?? item.name, distilledText, chunks);
        distilled = true;
        distilledChunks = chunks;
        distilledFreshnessAt = beforeFreshness;
        let derivedFrom: string | null;
        try {
          tier = await authoritativeTier(item, beforeIds, chunks, sourceTier(chunks, tier));
          derivedFrom =
            (await compiledSourceEvidence(beforeIds)).representative_parent_id ??
            derivedFromChunks(chunks, beforeIds[0] ?? null);
        } catch {
          return {
            status: "failed",
            target_hash: hash,
            page_id: converged.pageId,
            code: "verification_failed",
            kind: item.kind,
            tier: 2,
          };
        }
        const listing = await writeDistilledRecovery(converged.pageId);
        if (!listing)
          return {
            status: "failed",
            target_hash: hash,
            page_id: converged.pageId,
            code: "recovery_write_failed",
            kind: item.kind,
            tier,
          };
        recoveryToRemove = listing;
        try {
          converged = await convergePage(item, targetPath, body, title, tier, derivedFrom, deps);
          tier = converged.tier;
        } catch (error) {
          if (error instanceof EvidenceBlock) throw error;
          const failure = convergenceFailure(error, "page_upsert_failed", tier);
          return {
            status: "failed",
            target_hash: hash,
            page_id: converged.pageId,
            code: failure.code,
            kind: item.kind,
            tier: failure.failClosedTier,
          };
        }
        try {
          const afterChunks = await sourceChunksForCandidate(item.kind, item.entityId);
          const afterIds = orderedSourceIds(afterChunks);
          const afterFreshness = await sourceFreshness(afterIds);
          sourceChangedDeferred =
            !sameOrderedSourceIds(beforeIds, afterIds) ||
            (!!beforeFreshness &&
              !!afterFreshness &&
              afterFreshness.getTime() > beforeFreshness.getTime());
        } catch {
          return {
            status: "failed",
            target_hash: hash,
            page_id: converged.pageId,
            code: "verification_failed",
            kind: item.kind,
            tier: 2,
          };
        }
      }
    }
  }

  if (recoveryToRemove) {
    try {
      await deps.removeRecovery(recoveryToRemove);
    } catch {
      return {
        status: "failed",
        target_hash: hash,
        page_id: converged.pageId,
        code: "recovery_remove_failed",
        kind: item.kind,
        tier: converged.tier,
      };
    }
  }
  const status = distilled
    ? !item.page
      ? "created"
      : "updated"
    : item.recovery
      ? item.page
        ? converged.changed
          ? "repaired"
          : "unchanged"
        : "created"
      : statusBase === "created" && !item.page
        ? "created"
        : converged.changed
          ? "repaired"
          : "unchanged";
  return {
    status,
    page_id: converged.pageId,
    target_hash: hash,
    kind: item.kind,
    tier: converged.tier,
    ...(sourceChangedDeferred
      ? { code: "source_changed_deferred" as const }
      : modelCode
        ? { code: modelCode }
        : item.ambiguous
          ? { code: "legacy_path_ambiguous" as const }
          : {}),
  };
}

async function reconcileLocked(
  item: WorkItem,
  leasedTargetPath: string,
  deps: NoteReconcileDeps,
): Promise<NoteResult> {
  try {
    return await reconcileAllowedLocked(item, leasedTargetPath, deps);
  } catch (error) {
    if (!(error instanceof EvidenceBlock)) throw error;
    if (item.recovery) {
      try {
        await deps.removeRecovery(item.recovery);
      } catch {
        return {
          status: "failed",
          target_hash: targetHash(leasedTargetPath),
          code: "recovery_remove_failed",
          kind: item.kind,
        };
      }
    }
    if (item.page || item.recovery) {
      await quarantineGeneratedPageByPath(leasedTargetPath);
    }
    return {
      status: "failed",
      target_hash: targetHash(leasedTargetPath),
      code: error.code,
      kind: item.kind,
    };
  }
}

async function reconcile(item: WorkItem, deps: NoteReconcileDeps): Promise<NoteResult> {
  let leasedTargetPath =
    item.recovery?.record.target_path ??
    item.page?.path ??
    compiledNotePath(item.kind, item.name, item.entityId!);
  if (item.conflict) return reconcileLocked(item, leasedTargetPath, deps);
  const mayRetarget = !item.recovery && !item.page && !!item.candidate && !!item.entityId;
  for (let attempt = 0; attempt < 2; attempt++) {
    const targetPathForAttempt = leasedTargetPath;
    const outcome = await withCompiledNoteTargetLease(targetPathForAttempt, async () => {
      // Everything that can change while waiting for the lease is reloaded under
      // it: page, candidate/chunks, source ownership, and representation floors.
      const currentPage = await pageByPath(targetPathForAttempt);
      if (
        currentPage &&
        !item.recovery &&
        !(await reloadedNonRecoveryPageMatches(item, currentPage))
      ) {
        return {
          result: {
            status: "failed",
            target_hash: targetHash(targetPathForAttempt),
            page_id: currentPage.id,
            code: "identity_conflict",
            kind: item.kind,
            tier: 2,
          } satisfies NoteResult,
        } as const;
      }
      const currentCandidates = await noteCandidates(MIN_CHUNKS);
      const currentCandidate = currentCandidates.find(
        (candidate) => candidate.kind === item.kind && candidate.id === item.entityId,
      );
      const currentItem: WorkItem = {
        ...item,
        name: currentCandidate?.name ?? item.name,
        page: currentPage ?? undefined,
        candidate: currentCandidate,
      };
      if (mayRetarget && !currentPage && currentCandidate) {
        const desiredTargetPath = compiledNotePath(
          currentCandidate.kind,
          currentCandidate.name,
          currentCandidate.id,
        );
        if (desiredTargetPath !== targetPathForAttempt) {
          if (attempt === 0) return { retryTargetPath: desiredTargetPath } as const;
          return {
            result: {
              status: "failed",
              target_hash: targetHash(desiredTargetPath),
              code: "verification_failed",
              kind: item.kind,
              tier: 2,
            } satisfies NoteResult,
          } as const;
        }
      }
      if (item.recovery) {
        const ownership = await recoveryOwnership(item.recovery);
        if (ownership.conflict) {
          return {
            result: await reconcileLocked(
              {
                ...currentItem,
                page: ownership.page ?? currentPage ?? undefined,
                candidate: undefined,
                conflict: "identity_conflict",
              },
              targetPathForAttempt,
              deps,
            ),
          } as const;
        }
      }
      return {
        result: await reconcileLocked(currentItem, targetPathForAttempt, deps),
      } as const;
    });
    if ("result" in outcome && outcome.result) return outcome.result;
    leasedTargetPath = outcome.retryTargetPath;
  }
  return {
    status: "failed",
    target_hash: targetHash(leasedTargetPath),
    code: "verification_failed",
    kind: item.kind,
    tier: 2,
  };
}

function unsafeRootSummary(): CompileNotesSummary {
  return {
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
  };
}

type RemovableRecoveryListing = Parameters<NoteReconcileDeps["removeRecovery"]>[0];
type BlockedRecoveryCode = "tier0_source_blocked" | "source_evidence_unverifiable";
type BlockedRecoveryPhase = "cleaning" | "stable_empty" | "durable_blocked";
type BlockedRecoveryState = {
  key: string;
  kind: CompiledNoteKind;
  entityId: string;
  code: BlockedRecoveryCode;
  resultCode: BlockedRecoveryCode | "recovery_remove_failed";
  blockerRecord: BlockerRecoveryRecord;
  paths: Set<string>;
  phase: BlockedRecoveryPhase;
  emptyConfirmations: number;
};

const MAX_BLOCKED_DISCOVERY_ROUNDS = 3;
const MAX_BLOCKED_IDENTITY_PASSES = 4;
const REQUIRED_EMPTY_CONFIRMATIONS = 2;
const RECOVERY_ENTITY_FILENAME_RE =
  /^(person|org)--([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.v1(?:\.g[0-9]{16})?\.json$/;

function recoveryGroupIdentity(
  listing: RecoveryListing,
): { key: string; kind: CompiledNoteKind; entityId: string; targetPath: string } | null {
  if (!listing.valid && listing.code !== "tier0_recovery_record") return null;
  return {
    key: identityKey(listing.record.entity_kind, listing.record.entity_id),
    kind: listing.record.entity_kind,
    entityId: listing.record.entity_id,
    targetPath: listing.record.target_path,
  };
}

function recoveryListingKey(listing: RecoveryListing): string | null {
  const identity = recoveryGroupIdentity(listing);
  if (identity) return identity.key;
  const match = RECOVERY_ENTITY_FILENAME_RE.exec(listing.file);
  if (!match) return null;
  return identityKey(match[1] as CompiledNoteKind, match[2]!);
}

async function recoveryBlockCode(
  listing: RecoveryListing & { valid: true },
): Promise<BlockedRecoveryCode | null> {
  const parsedSources = parseCompiledNoteSourceIds(listing.record.body_md);
  const sourceIds = parsedSources.ids;
  if (
    !parsedSources.hasSourcesHeading ||
    sourceIds.length === 0 ||
    !sameOrderedSourceIds(sourceIds, listing.record.source_chunk_ids)
  ) {
    return "source_evidence_unverifiable";
  }
  const evidence = await compiledSourceEvidence(sourceIds);
  const levels = evidence.resolved.flatMap((source) => [source.min_tier, source.max_tier]);
  if (evidence.min_tier === 0 || levels.some((tier) => tier === 0)) {
    return "tier0_source_blocked";
  }
  if (
    evidence.unresolved_ids.length > 0 ||
    evidence.resolved.length === 0 ||
    evidence.min_tier === null ||
    evidence.max_tier === null ||
    evidence.owner_entities.length !== 1 ||
    evidence.owner_entities[0]!.kind !== listing.record.entity_kind ||
    evidence.owner_entities[0]!.entityId !== listing.record.entity_id ||
    [evidence.min_tier, evidence.max_tier, ...levels].some((tier) => tier !== 1 && tier !== 2)
  ) {
    return "source_evidence_unverifiable";
  }
  return null;
}

async function listingBlockCode(
  listing: RemovableRecoveryListing,
): Promise<BlockedRecoveryCode | null> {
  if (!listing.valid) return "tier0_source_blocked";
  return recoveryBlockCode(listing);
}

async function allListingsForBlockedIdentity(key: string): Promise<RecoveryListing[]> {
  return (await listCompiledNoteRecoveryRecords()).filter(
    (listing) => recoveryListingKey(listing) === key,
  );
}

async function listingsForBlockedIdentity(key: string): Promise<RemovableRecoveryListing[]> {
  return (await allListingsForBlockedIdentity(key)).filter(
    (listing): listing is RemovableRecoveryListing =>
      listing.valid || listing.code === "tier0_recovery_record",
  );
}

async function selectBlocker(
  listings: RemovableRecoveryListing[],
): Promise<{ listing: RemovableRecoveryListing; code: BlockedRecoveryCode } | null> {
  const blockers: { listing: RemovableRecoveryListing; code: BlockedRecoveryCode }[] = [];
  for (const listing of listings) {
    const code = await listingBlockCode(listing);
    if (code) blockers.push({ listing, code });
  }
  blockers.sort((left, right) => {
    const codeOrder =
      Number(left.code !== "tier0_source_blocked") - Number(right.code !== "tier0_source_blocked");
    return codeOrder || left.listing.file.localeCompare(right.listing.file);
  });
  return blockers[0] ?? null;
}

async function refreshBlockedState(
  state: BlockedRecoveryState,
  listings: RemovableRecoveryListing[],
): Promise<RemovableRecoveryListing | null> {
  for (const listing of listings) {
    const identity = recoveryGroupIdentity(listing);
    if (identity) state.paths.add(identity.targetPath);
  }
  const selected = await selectBlocker(listings);
  if (!selected) return null;
  if (state.code !== "tier0_source_blocked" || selected.code === "tier0_source_blocked") {
    state.code = selected.code;
    state.blockerRecord = selected.listing.record;
    if (state.resultCode !== "recovery_remove_failed") state.resultCode = selected.code;
  }
  return selected.listing;
}

async function hasVerifiedRecoveryBlock(state: BlockedRecoveryState): Promise<boolean> {
  for (const listing of await listingsForBlockedIdentity(state.key)) {
    const code = await listingBlockCode(listing);
    if (
      code === "tier0_source_blocked" ||
      (state.code === "source_evidence_unverifiable" && code === state.code)
    ) {
      return true;
    }
  }
  return false;
}

async function ensureDurableRecoveryBlock(
  state: BlockedRecoveryState,
  deps: NoteReconcileDeps,
): Promise<void> {
  if (await hasVerifiedRecoveryBlock(state)) return;
  try {
    await deps.writeRecoveryBlock(state.blockerRecord);
  } catch {
    state.resultCode = "recovery_remove_failed";
    if (await hasVerifiedRecoveryBlock(state)) return;
    throw new Error("RECOVERY_BLOCK_DURABILITY_FAILED");
  }
  if (!(await hasVerifiedRecoveryBlock(state))) {
    throw new Error("RECOVERY_BLOCK_DURABILITY_FAILED");
  }
}

async function failBlockedSettlement(
  state: BlockedRecoveryState,
  deps: NoteReconcileDeps,
): Promise<void> {
  state.resultCode = "recovery_remove_failed";
  if (!(await hasVerifiedRecoveryBlock(state))) {
    await ensureDurableRecoveryBlock(state, deps);
  }
  state.phase = "durable_blocked";
  if (!(await verifyBlockedRecoveryExit(state))) {
    throw new Error("RECOVERY_BLOCK_DURABILITY_FAILED");
  }
}

function removalOrder(listings: RemovableRecoveryListing[]): RemovableRecoveryListing[] {
  return [...listings].sort((left, right) => {
    if (left.valid !== right.valid) return left.valid ? -1 : 1;
    return left.file.localeCompare(right.file);
  });
}

async function settleBlockedRecoveryIdentity(
  state: BlockedRecoveryState,
  deps: NoteReconcileDeps,
): Promise<void> {
  state.phase = "cleaning";
  for (let pass = 0; pass < MAX_BLOCKED_IDENTITY_PASSES; pass++) {
    const allAtStart = await allListingsForBlockedIdentity(state.key);
    const atStart = allAtStart.filter(
      (listing): listing is RemovableRecoveryListing =>
        listing.valid || listing.code === "tier0_recovery_record",
    );
    const anchor = await refreshBlockedState(state, atStart);
    if (allAtStart.length === 0) {
      state.emptyConfirmations++;
      if (state.emptyConfirmations >= REQUIRED_EMPTY_CONFIRMATIONS) {
        state.phase = "stable_empty";
        return;
      }
      continue;
    }
    state.emptyConfirmations = 0;
    const others = anchor ? atStart.filter((listing) => listing.file !== anchor.file) : atStart;
    try {
      for (const listing of removalOrder(others)) await deps.removeRecovery(listing);
    } catch {
      await failBlockedSettlement(state, deps);
      return;
    }
    const allAfterOthers = await allListingsForBlockedIdentity(state.key);
    const afterOthers = allAfterOthers.filter(
      (listing): listing is RemovableRecoveryListing =>
        listing.valid || listing.code === "tier0_recovery_record",
    );
    const refreshedAnchor = await refreshBlockedState(state, afterOthers);
    if (
      allAfterOthers.length === 1 &&
      refreshedAnchor &&
      afterOthers[0]!.file === refreshedAnchor.file
    ) {
      try {
        await deps.removeRecovery(refreshedAnchor);
      } catch {
        await failBlockedSettlement(state, deps);
        return;
      }
    } else if (allAfterOthers.length > 0) {
      continue;
    }
    const afterRemoval = await allListingsForBlockedIdentity(state.key);
    if (afterRemoval.length === 0) {
      state.emptyConfirmations++;
      if (state.emptyConfirmations >= REQUIRED_EMPTY_CONFIRMATIONS) {
        state.phase = "stable_empty";
        return;
      }
    } else {
      state.emptyConfirmations = 0;
    }
  }
  state.resultCode = "recovery_remove_failed";
  await ensureDurableRecoveryBlock(state, deps);
  state.phase = "durable_blocked";
  if (!(await verifyBlockedRecoveryExit(state))) {
    throw new Error("RECOVERY_BLOCK_DURABILITY_FAILED");
  }
}

async function verifyBlockedRecoveryExit(state: BlockedRecoveryState): Promise<boolean> {
  if (state.phase === "stable_empty") {
    return (await allListingsForBlockedIdentity(state.key)).length === 0;
  }
  return state.phase === "durable_blocked" && hasVerifiedRecoveryBlock(state);
}

async function discoverBlockedRecoveryStates(
  listings: RecoveryListing[],
  blocked: Map<string, BlockedRecoveryState>,
): Promise<void> {
  const groups = new Map<string, RemovableRecoveryListing[]>();
  for (const listing of listings) {
    const identity = recoveryGroupIdentity(listing);
    if (!identity) continue;
    const group = groups.get(identity.key) ?? [];
    group.push(listing as RemovableRecoveryListing);
    groups.set(identity.key, group);
    const state = blocked.get(identity.key);
    if (state) state.paths.add(identity.targetPath);
  }
  for (const [key, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    if (blocked.has(key)) continue;
    const selected = await selectBlocker(group);
    if (!selected) continue;
    const identity = recoveryGroupIdentity(selected.listing)!;
    blocked.set(key, {
      key,
      kind: identity.kind,
      entityId: identity.entityId,
      code: selected.code,
      resultCode: selected.code,
      blockerRecord: selected.listing.record,
      paths: new Set(
        group.flatMap((listing) => {
          const member = recoveryGroupIdentity(listing);
          return member ? [member.targetPath] : [];
        }),
      ),
      phase: "cleaning",
      emptyConfirmations: 0,
    });
  }
}

async function settleBlockedRecoveries(
  initial: RecoveryListing[],
  deps: NoteReconcileDeps,
): Promise<{ blocked: Map<string, BlockedRecoveryState>; listings: RecoveryListing[] }> {
  const blocked = new Map<string, BlockedRecoveryState>();
  const settledFiles = new Map<string, string[]>();
  let listings = initial;
  for (let round = 0; round < MAX_BLOCKED_DISCOVERY_ROUNDS; round++) {
    await discoverBlockedRecoveryStates(listings, blocked);
    for (const [key, state] of [...blocked].sort(([left], [right]) => left.localeCompare(right))) {
      const beforeFiles = (await allListingsForBlockedIdentity(key))
        .map((listing) => listing.file)
        .sort();
      const previousFiles = settledFiles.get(key);
      const safe = await verifyBlockedRecoveryExit(state);
      if (!previousFiles || !sameOrderedSourceIds(previousFiles, beforeFiles) || !safe) {
        if (previousFiles && !sameOrderedSourceIds(previousFiles, beforeFiles)) {
          state.phase = "cleaning";
          state.emptyConfirmations = 0;
        }
        await settleBlockedRecoveryIdentity(state, deps);
      }
      settledFiles.set(
        key,
        (await allListingsForBlockedIdentity(key)).map((listing) => listing.file).sort(),
      );
    }
    listings = await listCompiledNoteRecoveryRecords();
  }
  for (const state of blocked.values()) {
    if (!(await verifyBlockedRecoveryExit(state))) {
      throw new Error("RECOVERY_BLOCK_DURABILITY_FAILED");
    }
    for (const path of [...state.paths].sort()) {
      await withCompiledNoteTargetLease(path, () => quarantineGeneratedPageByPath(path));
    }
  }
  listings = (await listCompiledNoteRecoveryRecords()).filter((listing) => {
    const key = recoveryListingKey(listing);
    return !key || !blocked.has(key);
  });
  return { blocked, listings };
}

export async function compileNotes(
  options: { deps?: Partial<NoteReconcileDeps> } = {},
): Promise<CompileNotesSummary> {
  return withCompiledNotesLease(async () => {
    // This is the compile boundary: no SQL, enumeration, or writes happen if
    // either private root is unsafe.  Callers receive one fixed opaque result.
    try {
      await preflightPrivateRoot(config.dataDir, join(config.dataDir, "brain"), {
        create: true,
        mode: 0o700,
      });
    } catch {
      return unsafeRootSummary();
    }
    let listings: RecoveryListing[];
    try {
      listings = await listCompiledNoteRecoveryRecords();
    } catch {
      return unsafeRootSummary();
    }
    const deps = defaults(options.deps);
    const settled = await settleBlockedRecoveries(listings, deps);
    const blocked = settled.blocked;
    listings = settled.listings;
    const blockedKeys = new Set(blocked.keys());
    const blockedPaths = new Set<string>();
    const blockedResults: NoteResult[] = [...blocked.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, state]) => {
        for (const path of state.paths) blockedPaths.add(path);
        return {
          status: "failed" as const,
          target_hash: targetHash([...state.paths].sort()[0]!),
          code: state.resultCode,
          kind: state.kind,
        };
      });
    const pages = (await activePagesForCompiledNoteReconciliation()).filter((page) => {
      if (blockedPaths.has(page.path)) return false;
      const identity = compiledNoteIdentityFromPath(page.path);
      return !identity || !blockedKeys.has(identityKey(identity.kind, identity.entityId));
    });
    const candidates = (await noteCandidates(MIN_CHUNKS)).filter(
      (candidate) => !blockedKeys.has(identityKey(candidate.kind, candidate.id)),
    );
    const union = await buildWorkUnion(listings, pages, candidates);
    const results: NoteResult[] = [...blockedResults, ...union.invalid, ...union.conflicts];
    for (const item of union.work) results.push(await reconcile(item, deps));
    const summary: CompileNotesSummary = {
      candidates: candidates.length,
      created: results.filter((result) => result.status === "created").length,
      updated: results.filter((result) => result.status === "updated").length,
      repaired: results.filter((result) => result.status === "repaired").length,
      unchanged: results.filter((result) => result.status === "unchanged").length,
      failed: results.filter((result) => result.status === "failed").length,
      results,
    };
    return summary;
  });
}
