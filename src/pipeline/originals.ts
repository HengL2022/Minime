// Content-addressed inbox originals. Archive identity stays on the raw bytes; this store is
// the durable hash-addressed copy plus an append-only manifest. Never write capture bytes or
// extracted text into the manifest, logs, or errors.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import {
  assertNoSymlinkComponents,
  atomicCreatePrivate,
  preflightPrivateRoot,
} from "../util/atomic-file";
import { config } from "../util/config";

const MANIFEST_RELATIVE = "files/manifest.ndjson";

const APPEND_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

export interface OriginalsSource {
  id: string;
  raw_path: string;
  content_hash: string | null;
  received_at: Date | string;
}

interface ManifestEntry {
  hash: string;
  path: string;
  ext: string;
  year: number;
  inbox_id: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function containedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"))
  );
}

function originalExtension(rawPath: string): string {
  const extension = extname(rawPath)
    .replace(/[^a-zA-Z0-9.]/g, "")
    .slice(0, 16);
  return extension || ".bin";
}

function originalYear(receivedAt: Date | string): number {
  const year = new Date(receivedAt).getUTCFullYear();
  if (!Number.isInteger(year) || year < 1970 || year > 9999)
    throw new Error("inbox_original_path_invalid");
  return year;
}

function originalRelativePath(hash: string, ext: string, year: number): string {
  return `files/${year}/${hash}${ext}`;
}

function expectedHash(item: OriginalsSource, bytes: Uint8Array): string {
  const hash = item.content_hash;
  if (!hash || !/^[a-f0-9]{64}$/.test(hash) || sha256(bytes) !== hash)
    throw new Error("inbox_snapshot_hash_mismatch");
  return hash;
}

async function privateFilePath(relativePath: string): Promise<string> {
  if (isAbsolute(relativePath)) throw new Error("inbox_original_path_invalid");
  const root = resolve(config.dataDir);
  const absolute = resolve(root, relativePath);
  if (!containedPath(root, absolute) || absolute === root)
    throw new Error("inbox_original_path_invalid");
  await assertNoSymlinkComponents(root, absolute);
  return absolute;
}

async function publishOriginal(target: string, bytes: Uint8Array, expected: string): Promise<void> {
  const created = await atomicCreatePrivate(target, bytes);
  if (created) return;
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("inbox_original_path_invalid");
  const existing = await readFile(target);
  if (sha256(existing) !== expected) throw new Error("inbox_original_collision");
}

function serializeManifestEntry(entry: ManifestEntry): string {
  return `${JSON.stringify({
    hash: entry.hash,
    path: entry.path,
    ext: entry.ext,
    year: entry.year,
    inbox_id: entry.inbox_id,
  })}\n`;
}

function lineHash(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("inbox_original_manifest_invalid");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("inbox_original_manifest_invalid");
  const hash = (parsed as { hash?: unknown }).hash;
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
    throw new Error("inbox_original_manifest_invalid");
  return hash;
}

async function manifestHasHash(absolute: string, hash: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("inbox_original_manifest_invalid");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("inbox_original_manifest_invalid");
    const text = await handle.readFile("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      if (lineHash(line) === hash) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

async function appendManifestLine(absolute: string, line: string): Promise<void> {
  const root = resolve(config.dataDir);
  await preflightPrivateRoot(root, dirname(absolute), { create: true, mode: 0o700 });
  await assertNoSymlinkComponents(root, absolute);
  const handle = await open(absolute, APPEND_FLAGS, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("inbox_original_manifest_invalid");
    await handle.chmod(0o600);
    await handle.writeFile(line);
  } finally {
    await handle.close();
  }
}

async function appendManifestIfNew(entry: ManifestEntry): Promise<void> {
  const absolute = await privateFilePath(MANIFEST_RELATIVE);
  if (await manifestHasHash(absolute, entry.hash)) return;
  await appendManifestLine(absolute, serializeManifestEntry(entry));
}

export async function storeInboxOriginal(item: OriginalsSource, bytes: Uint8Array): Promise<void> {
  const hash = expectedHash(item, bytes);
  const ext = originalExtension(item.raw_path);
  const year = originalYear(item.received_at);
  const relativePath = originalRelativePath(hash, ext, year);
  await publishOriginal(await privateFilePath(relativePath), bytes, hash);
  await appendManifestIfNew({
    hash,
    path: relativePath,
    ext,
    year,
    inbox_id: item.id,
  });
}
