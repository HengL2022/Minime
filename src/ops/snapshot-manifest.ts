import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ensurePrivateDumpDir } from "../util/config";

export const SNAPSHOT_MANIFEST_BASENAME = "minime.manifest.json";
export const SNAPSHOT_DUMP_BASENAME = "minime.sql";
export const PREVIOUS_SNAPSHOT_MANIFEST_BASENAME = "minime.previous.manifest.json";
export const PREVIOUS_SNAPSHOT_DUMP_BASENAME = "minime.previous.sql";
const REPRESENTATIVE_TABLES = ["tasks", "people", "journal_entries", "chunks", "events"] as const;
type RepresentativeTable = (typeof REPRESENTATIVE_TABLES)[number];

export interface SnapshotManifest {
  version: 1;
  dump_sha256: string;
  schema_migrations: string[];
  counts: Record<RepresentativeTable, number>;
}

export class SnapshotManifestError extends Error {
  constructor(readonly rule: "dump_structure" | "digest" | "format" | "filesystem" | "ownership") {
    super(`snapshot manifest failed (${rule})`);
  }
}

function fail(rule: SnapshotManifestError["rule"]): never {
  throw new SnapshotManifestError(rule);
}

function bytesOf(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? new TextEncoder().encode(input) : input;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type CopySection = { table: string; columns: string[]; rows: string[] };

function parseCopySections(text: string): Map<string, CopySection> {
  const sections = new Map<string, CopySection>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = line.match(/^COPY public\.([a-z_][a-z0-9_]*) \(([^)]*)\) FROM stdin;$/);
    if (!match) continue;
    const table = match[1]!;
    if (sections.has(table)) fail("dump_structure");
    const columns = match[2]!.split(",").map((column) => column.trim());
    const rows: string[] = [];
    let terminated = false;
    for (index += 1; index < lines.length; index += 1) {
      const row = lines[index]!;
      if (row === "\\.") {
        terminated = true;
        break;
      }
      if (row.startsWith("COPY ")) fail("dump_structure");
      rows.push(row);
    }
    if (!terminated) fail("dump_structure");
    sections.set(table, { table, columns, rows });
  }
  return sections;
}

function migrationNames(section: CopySection): string[] {
  const column = section.columns.indexOf("name");
  if (column < 0) fail("dump_structure");
  const names = section.rows.map((row) => {
    const fields = row.split("\t");
    const name = fields[column];
    if (!name || name === "\\N" || fields.length < section.columns.length) fail("dump_structure");
    return name;
  });
  names.sort();
  for (let index = 1; index < names.length; index += 1) {
    if (names[index] === names[index - 1]) fail("dump_structure");
  }
  return names;
}

function decodeDump(input: string | Uint8Array): { bytes: Uint8Array; text: string } {
  const bytes = bytesOf(input);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("dump_structure");
  }
  return { bytes, text };
}

export function buildSnapshotManifest(input: string | Uint8Array): SnapshotManifest {
  const { bytes, text } = decodeDump(input);
  const sections = parseCopySections(text);
  const migrations = sections.get("schema_migrations");
  if (!migrations) fail("dump_structure");
  const counts = {} as Record<RepresentativeTable, number>;
  for (const table of REPRESENTATIVE_TABLES) {
    const section = sections.get(table);
    if (!section) fail("dump_structure");
    counts[table] = section.rows.length;
  }
  return {
    version: 1,
    dump_sha256: digest(bytes),
    schema_migrations: migrationNames(migrations),
    counts,
  };
}

async function assertPrivateFileAsync(path: string, expectedParent?: string): Promise<void> {
  try {
    const resolved = resolve(path);
    if (expectedParent && dirname(resolved) !== resolve(expectedParent)) fail("ownership");
    const parent = dirname(resolved);
    if ((await realpath(parent)) !== parent) fail("ownership");
    const entry = await lstat(resolved);
    const owner = await stat(resolved);
    if (entry.isSymbolicLink() || !entry.isFile() || (owner.mode & 0o777) !== 0o600)
      fail("ownership");
  } catch (error) {
    if (error instanceof SnapshotManifestError) throw error;
    fail("filesystem");
  }
}

async function readPrivateFile(path: string, expectedParent?: string): Promise<Uint8Array> {
  const resolved = resolve(path);
  if (expectedParent && dirname(resolved) !== resolve(expectedParent)) fail("ownership");
  const parent = dirname(resolved);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if ((await realpath(parent)) !== parent) fail("ownership");
    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptor = await handle.stat();
    const entry = await lstat(resolved);
    if (
      !descriptor.isFile() ||
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      (descriptor.mode & 0o777) !== 0o600 ||
      (entry.mode & 0o777) !== 0o600 ||
      descriptor.dev !== entry.dev ||
      descriptor.ino !== entry.ino
    )
      fail("ownership");
    const content = await handle.readFile();
    const after = await lstat(resolved);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== descriptor.dev ||
      after.ino !== descriptor.ino
    )
      fail("ownership");
    return content;
  } catch (error) {
    if (error instanceof SnapshotManifestError) throw error;
    return fail("filesystem");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function encodeSnapshotManifest(manifest: SnapshotManifest): string {
  if (manifest.version !== 1 || !/^[0-9a-f]{64}$/.test(manifest.dump_sha256)) fail("format");
  if (
    !Array.isArray(manifest.schema_migrations) ||
    !manifest.schema_migrations.every((name) => typeof name === "string")
  )
    fail("format");
  for (const table of REPRESENTATIVE_TABLES) {
    if (!Number.isSafeInteger(manifest.counts?.[table]) || manifest.counts[table] < 0)
      fail("format");
  }
  return `${JSON.stringify(manifest)}\n`;
}

export async function readSnapshotManifest(path: string): Promise<SnapshotManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateFile(path)),
    );
  } catch {
    fail("format");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("format");
  const candidate = parsed as Record<string, unknown>;
  const allowed = new Set(["version", "dump_sha256", "schema_migrations", "counts"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) fail("format");
  try {
    return JSON.parse(
      encodeSnapshotManifest(candidate as unknown as SnapshotManifest),
    ) as SnapshotManifest;
  } catch (error) {
    if (error instanceof SnapshotManifestError) throw error;
    fail("format");
  }
}

export async function publishSnapshotManifest(
  dumpDir: string,
  dumpPath = join(dumpDir, SNAPSHOT_DUMP_BASENAME),
): Promise<string> {
  const root = resolve(dumpDir);
  const dump = resolve(dumpPath);
  if (dirname(dump) !== root || dump.split("/").pop() !== SNAPSHOT_DUMP_BASENAME) fail("ownership");
  try {
    await ensurePrivateDumpDir(root);
    await assertPrivateFileAsync(dump, root);
  } catch (error) {
    if (error instanceof SnapshotManifestError) throw error;
    fail("filesystem");
  }
  let manifest: SnapshotManifest;
  try {
    manifest = buildSnapshotManifest(await readPrivateFile(dump, root));
  } catch (error) {
    if (error instanceof SnapshotManifestError) throw error;
    fail("dump_structure");
  }
  const target = join(root, SNAPSHOT_MANIFEST_BASENAME);
  let temp: string | undefined;
  try {
    const existing = await lstat(target).catch(() => undefined);
    if (
      existing &&
      (existing.isSymbolicLink() || !existing.isFile() || (existing.mode & 0o777) !== 0o600)
    )
      fail("ownership");
    temp = join(root, `.${SNAPSHOT_MANIFEST_BASENAME}.${randomUUID()}.tmp`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.write(encodeSnapshotManifest(manifest));
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await assertPrivateFileAsync(target, root);
    return target;
  } catch (error) {
    if (temp) await rm(temp, { force: true }).catch(() => {});
    if (error instanceof SnapshotManifestError) throw error;
    fail("filesystem");
  }
}

export async function verifySnapshotManifest(
  dumpPath: string,
  manifestPath: string,
): Promise<void> {
  if (
    dirname(resolve(dumpPath)) !== dirname(resolve(manifestPath)) ||
    resolve(dumpPath).split("/").pop() !== SNAPSHOT_DUMP_BASENAME ||
    resolve(manifestPath).split("/").pop() !== SNAPSHOT_MANIFEST_BASENAME
  )
    fail("ownership");
  const manifest = await readSnapshotManifest(manifestPath);
  const actual = buildSnapshotManifest(await readPrivateFile(dumpPath));
  if (actual.dump_sha256 !== manifest.dump_sha256) fail("digest");
  if (JSON.stringify(actual.schema_migrations) !== JSON.stringify(manifest.schema_migrations))
    fail("digest");
  if (JSON.stringify(actual.counts) !== JSON.stringify(manifest.counts)) fail("digest");
}

async function publishPrivateBytes(
  root: string,
  basename: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = join(root, basename);
  let temp: string | undefined;
  try {
    await ensurePrivateDumpDir(root);
    const existing = await lstat(target).catch(() => undefined);
    if (
      existing &&
      (existing.isSymbolicLink() || !existing.isFile() || (existing.mode & 0o777) !== 0o600)
    )
      fail("ownership");
    temp = join(root, `.${basename}.${randomUUID()}.tmp`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.write(bytes);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await assertPrivateFileAsync(target, root);
  } catch (error) {
    if (temp) await rm(temp, { force: true }).catch(() => {});
    if (error instanceof SnapshotManifestError) throw error;
    fail("filesystem");
  }
}

function assertManifestMatchesDump(manifest: SnapshotManifest, dumpBytes: Uint8Array): void {
  const actual = buildSnapshotManifest(dumpBytes);
  if (
    actual.dump_sha256 !== manifest.dump_sha256 ||
    JSON.stringify(actual.schema_migrations) !== JSON.stringify(manifest.schema_migrations) ||
    JSON.stringify(actual.counts) !== JSON.stringify(manifest.counts)
  )
    fail("digest");
}

/** Preserve the last verified stable pair before a new dump can replace it. */
export async function preservePreviousSnapshotPair(dumpDir: string): Promise<boolean> {
  const root = resolve(dumpDir);
  const dumpPath = join(root, SNAPSHOT_DUMP_BASENAME);
  const manifestPath = join(root, SNAPSHOT_MANIFEST_BASENAME);
  const dumpEntry = await lstat(dumpPath).catch(() => undefined);
  const manifestEntry = await lstat(manifestPath).catch(() => undefined);
  if (!dumpEntry || !manifestEntry) return false;

  let dumpBytes: Uint8Array;
  let manifest: SnapshotManifest;
  try {
    dumpBytes = await readPrivateFile(dumpPath, root);
    manifest = await readSnapshotManifest(manifestPath);
    assertManifestMatchesDump(manifest, dumpBytes);
  } catch (error) {
    if (error instanceof SnapshotManifestError) return false;
    throw error;
  }

  await publishPrivateBytes(root, PREVIOUS_SNAPSHOT_DUMP_BASENAME, dumpBytes);
  await publishPrivateBytes(
    root,
    PREVIOUS_SNAPSHOT_MANIFEST_BASENAME,
    new TextEncoder().encode(encodeSnapshotManifest(manifest)),
  );
  const previousDump = await readPrivateFile(join(root, PREVIOUS_SNAPSHOT_DUMP_BASENAME), root);
  const previousManifest = await readSnapshotManifest(
    join(root, PREVIOUS_SNAPSHOT_MANIFEST_BASENAME),
  );
  assertManifestMatchesDump(previousManifest, previousDump);
  return true;
}
