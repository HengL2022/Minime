import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  assertNoSymlinkComponents,
  atomicWritePrivate,
  preflightPrivateRoot,
} from "../util/atomic-file";
import {
  type CompiledNoteKind,
  type NoteTier,
  compiledNoteIdentityFromPath,
  normalizeCompiledNoteBody,
  opaqueTargetHash,
  renderCompiledNoteArchive,
} from "../util/compiled-note-archive";
import { config } from "../util/config";

export const COMPILED_NOTE_RECOVERY_VERSION = 1 as const;

export interface CompiledNoteRecoveryV1 {
  version: 1;
  entity_kind: CompiledNoteKind;
  entity_id: string;
  expected_page_id: string | null;
  target_path: string;
  title: string;
  tier: NoteTier;
  derived_from: string;
  source_chunk_ids: string[];
  source_freshness_at: string;
  body_md: string;
  archive_sha256: string;
}

export type TierZeroCompiledNoteRecoveryV1 = Omit<CompiledNoteRecoveryV1, "tier"> & { tier: 0 };
export type BlockerRecoveryRecord = CompiledNoteRecoveryV1 | TierZeroCompiledNoteRecoveryV1;

export type RecoveryListing =
  | { valid: true; file: string; filenameHash: string; record: CompiledNoteRecoveryV1 }
  | {
      valid: false;
      file: string;
      filenameHash: string;
      code: "tier0_recovery_record";
      record: TierZeroCompiledNoteRecoveryV1;
    }
  | { valid: false; file: string; filenameHash: string; code: "invalid_recovery_record" };

export interface RecoveryWriteOptions {
  writePrivate?: (target: string, bytes: Uint8Array | string) => Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const RECOVERY_FILENAME_RE =
  /^(person|org)--([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.v1(?:\.g([0-9]{16}))?\.json$/;
const RECOVERY_STAGING_RE = /^\.compiled-note-recovery-[0-9a-f-]+\.stage$/;
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;
const MAX_PUBLISH_ATTEMPTS = 16;
const EXPECTED_KEYS = [
  "version",
  "entity_kind",
  "entity_id",
  "expected_page_id",
  "target_path",
  "title",
  "tier",
  "derived_from",
  "source_chunk_ids",
  "source_freshness_at",
  "body_md",
  "archive_sha256",
] as const;

export function compiledNoteRecoveryDir(): string {
  return resolve(config.dataDir, "tmp", "compiled-notes");
}

function brainRoot(): string {
  return resolve(config.dataDir, "brain");
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value) && value === value.toLowerCase();
}

type RecoveryFilename = {
  kind: CompiledNoteKind;
  entityId: string;
  generation: number;
};

function parseRecoveryFilename(file: string): RecoveryFilename | null {
  const match = RECOVERY_FILENAME_RE.exec(file);
  if (!match || !canonicalUuid(match[2])) return null;
  if (match[3] === undefined) {
    return { kind: match[1] as CompiledNoteKind, entityId: match[2], generation: 0 };
  }
  const generation = Number(match[3]);
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION)
    return null;
  return { kind: match[1] as CompiledNoteKind, entityId: match[2], generation };
}

function filenameFor(
  record: Pick<CompiledNoteRecoveryV1, "entity_kind" | "entity_id">,
  generation = 0,
): string {
  const base = `${record.entity_kind}--${record.entity_id}.v1`;
  return generation === 0
    ? `${base}.json`
    : `${base}.g${generation.toString().padStart(16, "0")}.json`;
}

function invalid(file: string): RecoveryListing {
  return {
    valid: false,
    file,
    filenameHash: opaqueTargetHash(file),
    code: "invalid_recovery_record",
  };
}

function strictObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...EXPECTED_KEYS].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function targetContained(targetPath: string): boolean {
  if (!targetPath || isAbsolute(targetPath)) return false;
  const root = resolve(brainRoot());
  const target = resolve(root, targetPath);
  const rel = relative(root, target);
  return !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
}

function validateRecord(value: unknown, file: string): value is CompiledNoteRecoveryV1 {
  if (!strictObject(value)) return false;
  const record = value as Record<string, unknown>;
  const filename = parseRecoveryFilename(file);
  if (!filename) return false;
  if (record.version !== COMPILED_NOTE_RECOVERY_VERSION) return false;
  if (record.entity_kind !== "person" && record.entity_kind !== "org") return false;
  if (!canonicalUuid(record.entity_id)) return false;
  if (record.expected_page_id !== null && !canonicalUuid(record.expected_page_id)) return false;
  if (typeof record.target_path !== "string" || !targetContained(record.target_path)) return false;
  const identity = compiledNoteIdentityFromPath(record.target_path);
  if (identity) {
    if (identity.kind !== record.entity_kind || identity.entityId !== record.entity_id)
      return false;
  } else if (record.expected_page_id === null) {
    return false;
  }
  if (typeof record.title !== "string" || record.title.length === 0) return false;
  if (record.tier !== 1 && record.tier !== 2) return false;
  if (!canonicalUuid(record.derived_from)) return false;
  if (!Array.isArray(record.source_chunk_ids) || record.source_chunk_ids.length === 0) return false;
  const ids = record.source_chunk_ids;
  if (!ids.every(canonicalUuid) || new Set(ids).size !== ids.length) return false;
  if (!validTimestamp(record.source_freshness_at)) return false;
  if (
    typeof record.body_md !== "string" ||
    normalizeCompiledNoteBody(record.body_md) !== record.body_md
  )
    return false;
  if (!HASH_RE.test(String(record.archive_sha256))) return false;
  const archive = renderCompiledNoteArchive({
    title: record.title,
    tier: record.tier,
    bodyMd: record.body_md,
  });
  if (archive.contentHash !== record.archive_sha256) return false;
  if (filename.kind !== record.entity_kind || filename.entityId !== record.entity_id) return false;
  return true;
}

function validateTierZeroRecord(
  value: unknown,
  file: string,
): value is TierZeroCompiledNoteRecoveryV1 {
  if (!strictObject(value)) return false;
  const record = value as Record<string, unknown>;
  const filename = parseRecoveryFilename(file);
  if (!filename || record.tier !== 0) return false;
  if (record.version !== COMPILED_NOTE_RECOVERY_VERSION) return false;
  if (record.entity_kind !== "person" && record.entity_kind !== "org") return false;
  if (!canonicalUuid(record.entity_id)) return false;
  if (record.expected_page_id !== null && !canonicalUuid(record.expected_page_id)) return false;
  if (typeof record.target_path !== "string" || !targetContained(record.target_path)) return false;
  const identity = compiledNoteIdentityFromPath(record.target_path);
  if (!identity || identity.kind !== record.entity_kind || identity.entityId !== record.entity_id) {
    return false;
  }
  if (typeof record.title !== "string" || record.title.length === 0) return false;
  if (!canonicalUuid(record.derived_from)) return false;
  if (!Array.isArray(record.source_chunk_ids) || record.source_chunk_ids.length === 0) return false;
  if (
    !record.source_chunk_ids.every(canonicalUuid) ||
    new Set(record.source_chunk_ids).size !== record.source_chunk_ids.length
  ) {
    return false;
  }
  if (!validTimestamp(record.source_freshness_at)) return false;
  if (
    typeof record.body_md !== "string" ||
    normalizeCompiledNoteBody(record.body_md) !== record.body_md
  ) {
    return false;
  }
  if (!HASH_RE.test(String(record.archive_sha256))) return false;
  const archive = `---\ntitle: ${JSON.stringify(record.title)}\ntier: 0\n---\n${record.body_md}\n`;
  if (createHash("sha256").update(archive).digest("hex") !== record.archive_sha256) return false;
  return filename.kind === record.entity_kind && filename.entityId === record.entity_id;
}

function sameRecoveryRecord(left: CompiledNoteRecoveryV1, right: CompiledNoteRecoveryV1): boolean {
  return (
    left.version === right.version &&
    left.entity_kind === right.entity_kind &&
    left.entity_id === right.entity_id &&
    left.expected_page_id === right.expected_page_id &&
    left.target_path === right.target_path &&
    left.title === right.title &&
    left.tier === right.tier &&
    left.derived_from === right.derived_from &&
    left.source_chunk_ids.length === right.source_chunk_ids.length &&
    left.source_chunk_ids.every((id, index) => id === right.source_chunk_ids[index]) &&
    left.source_freshness_at === right.source_freshness_at &&
    left.body_md === right.body_md &&
    left.archive_sha256 === right.archive_sha256
  );
}

async function preflightRecoveryRoot(): Promise<string> {
  const dir = compiledNoteRecoveryDir();
  await preflightPrivateRoot(config.dataDir, dir, { create: true, mode: 0o700 });
  return dir;
}

export async function readPrivateRegularFileNoFollow(
  trustedRoot: string,
  target: string,
): Promise<Uint8Array> {
  await assertNoSymlinkComponents(trustedRoot, target);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleStat = await handle.stat();
    if (!handleStat.isFile()) throw new Error("unsafe private file");
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function syncRecoveryDirectory(dir: string): Promise<void> {
  await assertNoSymlinkComponents(config.dataDir, dir);
  const handle = await open(dir, "r");
  try {
    const handleStat = await handle.stat();
    if (!handleStat.isDirectory()) throw new Error("unsafe recovery directory");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type ValidRecoveryScan = {
  listing: RecoveryListing & { valid: true };
  generation: number;
  kind: CompiledNoteKind;
  entityId: string;
};

async function scanRecoveryDirectory(
  dir: string,
  options: { skipFile?: string } = {},
): Promise<{ invalid: RecoveryListing[]; valid: ValidRecoveryScan[] }> {
  const entries = await readdir(dir, { withFileTypes: true });
  const invalidListings: RecoveryListing[] = [];
  const valid: ValidRecoveryScan[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const file = entry.name;
    if (file === options.skipFile) continue;
    if (RECOVERY_STAGING_RE.test(file)) continue;
    const invalidListing = invalid(file);
    const filename = parseRecoveryFilename(file);
    if (!filename) {
      invalidListings.push(invalidListing);
      continue;
    }
    try {
      const absolute = join(dir, file);
      const bytes = await readPrivateRegularFileNoFollow(config.dataDir, absolute);
      const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (validateTierZeroRecord(parsed, file)) {
        invalidListings.push({
          valid: false,
          file,
          filenameHash: opaqueTargetHash(file),
          code: "tier0_recovery_record",
          record: parsed,
        });
        continue;
      }
      if (!validateRecord(parsed, file)) {
        invalidListings.push(invalidListing);
        continue;
      }
      valid.push({
        listing: { valid: true, file, filenameHash: opaqueTargetHash(file), record: parsed },
        generation: filename.generation,
        kind: filename.kind,
        entityId: filename.entityId,
      });
    } catch {
      invalidListings.push(invalidListing);
    }
  }
  return { invalid: invalidListings, valid };
}

export async function listCompiledNoteRecoveryRecords(): Promise<RecoveryListing[]> {
  const dir = await preflightRecoveryRoot();
  await syncRecoveryDirectory(dir);
  const scanned = await scanRecoveryDirectory(dir);
  const highest = new Map<string, ValidRecoveryScan>();
  for (const entry of scanned.valid) {
    const key = `${entry.kind}:${entry.entityId}`;
    const current = highest.get(key);
    if (!current || entry.generation > current.generation) highest.set(key, entry);
  }
  return [...scanned.invalid, ...[...highest.values()].map((entry) => entry.listing)].sort((a, b) =>
    a.file.localeCompare(b.file),
  );
}

export async function writeCompiledNoteRecoveryRecord(
  record: CompiledNoteRecoveryV1,
  options: RecoveryWriteOptions = {},
): Promise<RecoveryListing & { valid: true }> {
  const listing = await publishRecoveryRecord(record, options);
  if (!listing.valid) throw new Error("RECOVERY_GENERATION_PUBLISH_FAILED");
  return listing;
}

export async function writeCompiledNoteRecoveryBlockRecord(
  record: BlockerRecoveryRecord,
  options: RecoveryWriteOptions = {},
): Promise<
  | (RecoveryListing & { valid: true })
  | (RecoveryListing & { valid: false; code: "tier0_recovery_record" })
> {
  return publishRecoveryRecord(record, options);
}

function recordValidForFilename(record: BlockerRecoveryRecord, file: string): boolean {
  return record.tier === 0 ? validateTierZeroRecord(record, file) : validateRecord(record, file);
}

function recoveryListing(
  record: BlockerRecoveryRecord,
  file: string,
):
  | (RecoveryListing & { valid: true })
  | (RecoveryListing & { valid: false; code: "tier0_recovery_record" }) {
  if (record.tier === 0) {
    return {
      valid: false,
      file,
      filenameHash: opaqueTargetHash(file),
      code: "tier0_recovery_record",
      record,
    };
  }
  return { valid: true, file, filenameHash: opaqueTargetHash(file), record };
}

async function verifyOwnedStaging(target: string, expected: Uint8Array): Promise<void> {
  await assertNoSymlinkComponents(config.dataDir, target);
  const handle = await open(target, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("unsafe recovery staging");
    const bytes = new Uint8Array(await handle.readFile());
    if (!Buffer.from(bytes).equals(Buffer.from(expected))) {
      throw new Error("invalid recovery staging");
    }
    await handle.chmod(0o600);
    await handle.sync();
    if (((await handle.stat()).mode & 0o777) !== 0o600) {
      throw new Error("invalid recovery staging mode");
    }
  } finally {
    await handle.close();
  }
}

async function verifyPublishedRecovery(
  target: string,
  expected: Uint8Array,
  record: BlockerRecoveryRecord,
  file: string,
): Promise<void> {
  const bytes = await readPrivateRegularFileNoFollow(config.dataDir, target);
  if (!Buffer.from(bytes).equals(Buffer.from(expected))) {
    throw new Error("invalid published recovery");
  }
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!recordValidForFilename(parsed as BlockerRecoveryRecord, file)) {
    throw new Error("invalid published recovery");
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (((await handle.stat()).mode & 0o777) !== 0o600) {
      throw new Error("invalid published recovery mode");
    }
  } finally {
    await handle.close();
  }
}

async function nextRecoveryGeneration(dir: string, record: BlockerRecoveryRecord): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let highest = -1;
  for (const entry of entries) {
    const parsed = parseRecoveryFilename(entry.name);
    if (
      parsed &&
      parsed.kind === record.entity_kind &&
      parsed.entityId === record.entity_id &&
      parsed.generation > highest
    ) {
      highest = parsed.generation;
    }
  }
  const generation = highest < 0 ? 0 : highest + 1;
  if (!Number.isSafeInteger(generation) || generation > MAX_GENERATION) {
    throw new Error("RECOVERY_GENERATION_PUBLISH_FAILED");
  }
  return generation;
}

async function removeOwnedStaging(stagingPath: string): Promise<void> {
  try {
    await unlink(stagingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function publishRecoveryRecord(
  record: BlockerRecoveryRecord,
  options: RecoveryWriteOptions,
): ReturnType<typeof publishRecoveryRecordExclusive> {
  try {
    return await publishRecoveryRecordExclusive(record, options);
  } catch {
    throw new Error("RECOVERY_GENERATION_PUBLISH_FAILED");
  }
}

async function publishRecoveryRecordExclusive(
  record: BlockerRecoveryRecord,
  options: RecoveryWriteOptions,
): Promise<
  | (RecoveryListing & { valid: true })
  | (RecoveryListing & { valid: false; code: "tier0_recovery_record" })
> {
  const dir = await preflightRecoveryRoot();
  if (!recordValidForFilename(record, filenameFor(record))) {
    throw new Error("RECOVERY_GENERATION_PUBLISH_FAILED");
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
    const generation = await nextRecoveryGeneration(dir, record);
    const file = filenameFor(record, generation);
    const candidatePath = join(dir, file);
    const stagingPath = join(dir, `.compiled-note-recovery-${randomUUID()}.stage`);
    let published = false;
    try {
      await (options.writePrivate ?? atomicWritePrivate)(stagingPath, bytes);
      await verifyOwnedStaging(stagingPath, bytes);
      await assertNoSymlinkComponents(config.dataDir, candidatePath);
      await link(stagingPath, candidatePath);
      published = true;
      await syncRecoveryDirectory(dir);
      await verifyPublishedRecovery(candidatePath, bytes, record, file);
      await removeOwnedStaging(stagingPath);
      await syncRecoveryDirectory(dir);
      return recoveryListing(record, file);
    } catch (error) {
      try {
        await removeOwnedStaging(stagingPath);
      } catch {
        throw new Error("RECOVERY_GENERATION_PUBLISH_FAILED");
      }
      if (!published && (error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new Error("RECOVERY_GENERATION_PUBLISH_FAILED");
    }
  }
  throw new Error("RECOVERY_GENERATION_PUBLISH_FAILED");
}

export async function removeCompiledNoteRecoveryRecord(
  listing:
    | (RecoveryListing & { valid: true })
    | (RecoveryListing & { valid: false; code: "tier0_recovery_record" }),
): Promise<void> {
  const dir = await preflightRecoveryRoot();
  await syncRecoveryDirectory(dir);
  const activeFilename = parseRecoveryFilename(listing.file);
  if (
    !activeFilename ||
    activeFilename.kind !== listing.record.entity_kind ||
    activeFilename.entityId !== listing.record.entity_id
  ) {
    throw new Error("invalid active recovery generation");
  }
  const activeAbsolute = join(dir, listing.file);
  const validateActive = async (): Promise<void> => {
    const activeBytes = await readPrivateRegularFileNoFollow(config.dataDir, activeAbsolute);
    const activeRecord: unknown = JSON.parse(Buffer.from(activeBytes).toString("utf8"));
    const matches = listing.valid
      ? validateRecord(activeRecord, listing.file) &&
        sameRecoveryRecord(activeRecord, listing.record)
      : validateTierZeroRecord(activeRecord, listing.file) &&
        JSON.stringify(activeRecord) === JSON.stringify(listing.record);
    if (!matches) {
      throw new Error("invalid active recovery generation");
    }
  };
  await validateActive();
  const scanned = await scanRecoveryDirectory(dir, { skipFile: listing.file });
  const sameEntity = scanned.valid.filter(
    (entry) => entry.kind === activeFilename.kind && entry.entityId === activeFilename.entityId,
  );
  if (sameEntity.some((entry) => entry.generation > activeFilename.generation)) {
    throw new Error("stale active recovery generation");
  }
  const lower = sameEntity
    .filter((entry) => entry.generation < activeFilename.generation)
    .sort((left, right) => left.generation - right.generation);
  for (const entry of lower) {
    const absolute = join(dir, entry.listing.file);
    await assertNoSymlinkComponents(config.dataDir, absolute);
    await unlink(absolute);
  }
  await validateActive();
  await assertNoSymlinkComponents(config.dataDir, activeAbsolute);
  await unlink(activeAbsolute);
}
