import { randomUUID } from "node:crypto";
import {
  chmod as fsChmod,
  link as fsLink,
  mkdir as fsMkdir,
  open as fsOpen,
  rename as fsRename,
  unlink as fsUnlink,
  lstat,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { REPO_ROOT, config } from "./config";
import { UNSAFE_DATA_ROOT, assertDedicatedDataRoot } from "./data-root";

export interface AtomicFileOps {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  open(
    path: string,
    flags: "wx" | "r",
    mode?: number,
  ): Promise<{
    writeFile(data: Uint8Array | string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const UNSAFE_PRIVATE_ROOT = UNSAFE_DATA_ROOT;

function unsafe(): Error {
  return new Error(UNSAFE_PRIVATE_ROOT);
}

function lexicallyContained(anchor: string, target: string, allowEqual = false): boolean {
  const root = resolve(anchor);
  const candidate = resolve(target);
  const rel = relative(root, candidate);
  if (!allowEqual && !rel) return false;
  return !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
}

/** Reject roots whose permission normalization could lock unrelated owner/system data. */
export function assertDedicatedPrivateDataRoot(dataRoot: string): string {
  return assertDedicatedDataRoot(dataRoot, REPO_ROOT);
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unsafe();
      const parent = dirname(current);
      if (parent === current) throw unsafe();
      current = parent;
    }
  }
}

/**
 * Validate every existing path component without following a symlink. Missing
 * components are the final not-yet-created suffix and are therefore allowed.
 */
export async function assertNoSymlinkComponents(
  trustedRoot: string,
  target: string,
): Promise<void> {
  const root = resolve(trustedRoot);
  const candidate = resolve(target);
  if (!lexicallyContained(root, candidate, true)) throw unsafe();

  let rootStat: Awaited<ReturnType<typeof lstat>>;
  try {
    rootStat = await lstat(root);
  } catch {
    throw unsafe();
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw unsafe();

  let anchorReal: string;
  try {
    anchorReal = await realpath(root);
  } catch {
    throw unsafe();
  }

  let current = root;
  const rel = relative(root, candidate);
  const components = rel ? rel.split("/") : [];
  for (const component of components) {
    current = resolve(current, component);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw unsafe();
    }
    if (stat.isSymbolicLink()) throw unsafe();
    if (stat.isDirectory() || current !== candidate) {
      // Continue through directories; a non-directory intermediate component
      // cannot safely be traversed even when its suffix is missing.
      if (!stat.isDirectory() && current !== candidate) throw unsafe();
    }
  }

  const ancestor = await nearestExistingAncestor(candidate);
  let ancestorReal: string;
  try {
    ancestorReal = await realpath(ancestor);
  } catch {
    throw unsafe();
  }
  const ancestorRel = relative(anchorReal, ancestorReal);
  if (
    ancestorRel &&
    (isAbsolute(ancestorRel) || ancestorRel === ".." || ancestorRel.startsWith("../"))
  ) {
    throw unsafe();
  }
}

export async function preflightPrivateRoot(
  dataRoot: string,
  targetRoot: string,
  options: { create?: boolean; mode?: number } = {},
): Promise<void> {
  const root = resolve(dataRoot);
  const target = resolve(targetRoot);
  const mode = options.mode ?? 0o700;
  if (!lexicallyContained(root, target)) throw unsafe();

  await ensurePrivateDataRoot(root);

  let current = root;
  const components = relative(root, target).split("/").filter(Boolean);
  for (let index = 0; index < components.length; index++) {
    current = resolve(current, components[index]!);
    await assertNoSymlinkComponents(root, current);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (!options.create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw unsafe();
      // Create one component at a time. This lets us validate and normalize every
      // Minime-owned directory instead of relying on the process umask for a
      // recursive suffix.
      try {
        await fsMkdir(current, { mode: 0o700 });
      } catch {
        throw unsafe();
      }
      await assertNoSymlinkComponents(root, current);
      try {
        stat = await lstat(current);
      } catch {
        throw unsafe();
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe();
    const componentMode = index === components.length - 1 ? mode : 0o700;
    await chmodVerifiedDirectory(current, componentMode);
  }
}

async function chmodVerifiedDirectory(path: string, mode: number): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch {
    throw unsafe();
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe();
  try {
    await realpath(path);
  } catch {
    throw unsafe();
  }
  // Re-check immediately before chmod so a final-component symlink is never
  // followed by the permission normalization.
  const finalStat = await lstat(path).catch(() => null);
  if (!finalStat || finalStat.isSymbolicLink() || !finalStat.isDirectory()) throw unsafe();
  try {
    await fsChmod(path, mode);
  } catch {
    throw unsafe();
  }
}

/**
 * Establish the configured data directory itself as the private trust anchor.
 * The root may be absent on first capture, but an existing symlink or non-directory
 * is always rejected before chmod or any child write.
 */
export async function ensurePrivateDataRoot(dataRoot: string): Promise<void> {
  const root = assertDedicatedPrivateDataRoot(dataRoot);
  // Anchor validation at the filesystem root so an existing symlink in any parent component is
  // rejected before mkdir or chmod can follow it.
  await assertNoSymlinkComponents(resolve("/"), root);
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unsafe();
    const ancestor = await nearestExistingAncestor(root);
    const ancestorStat = await lstat(ancestor).catch(() => null);
    if (!ancestorStat || ancestorStat.isSymbolicLink() || !ancestorStat.isDirectory())
      throw unsafe();
    let current = ancestor;
    for (const component of relative(ancestor, root).split("/").filter(Boolean)) {
      current = resolve(current, component);
      try {
        await fsMkdir(current, { mode: 0o700 });
      } catch {
        throw unsafe();
      }
      await assertNoSymlinkComponents(resolve("/"), current);
      const created = await lstat(current).catch(() => null);
      if (!created || created.isSymbolicLink() || !created.isDirectory()) throw unsafe();
    }
    try {
      stat = await lstat(root);
    } catch {
      throw unsafe();
    }
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe();
  await chmodVerifiedDirectory(root, 0o700);
}

async function closeHandle(handle: { close(): Promise<void> }): Promise<void> {
  try {
    await handle.close();
  } catch (first) {
    try {
      await handle.close();
    } catch {
      // Preserve the first close error; the caller still sees a rejected write.
    }
    throw first;
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

export function createAtomicFileWriter(
  ops: AtomicFileOps,
): (target: string, bytes: Uint8Array | string) => Promise<void> {
  return async (target, bytes) => {
    const parent = dirname(target);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let tempHandle: Awaited<ReturnType<AtomicFileOps["open"]>> | undefined;
    let ownsTemporary = false;
    let primaryError: unknown;
    let cleanupError: unknown;
    try {
      await ops.mkdir(parent, { recursive: true, mode: 0o700 });
      await ops.chmod(parent, 0o700);
      tempHandle = await ops.open(temporary, "wx", 0o600);
      ownsTemporary = true;
      try {
        await tempHandle.writeFile(bytes);
        await tempHandle.sync();
      } finally {
        const handle = tempHandle;
        tempHandle = undefined;
        await closeHandle(handle);
      }
      await ops.rename(temporary, target);
      ownsTemporary = false;

      const directoryHandle = await ops.open(parent, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await closeHandle(directoryHandle);
      }
    } catch (error) {
      primaryError = error;
    } finally {
      if (tempHandle) {
        try {
          await closeHandle(tempHandle);
        } catch (error) {
          if (!primaryError) primaryError = error;
        }
      }
      if (ownsTemporary) {
        try {
          await ops.unlink(temporary);
        } catch (error) {
          if (!isEnoent(error)) cleanupError = error;
        }
      }
    }
    if (primaryError && cleanupError) {
      throw new AggregateError([primaryError, cleanupError], "ATOMIC_WRITE_FAILED");
    }
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
  };
}

interface AtomicCreateFileOps extends AtomicFileOps {
  link(from: string, to: string): Promise<void>;
}

async function createAtomicFileNoReplace(
  ops: AtomicCreateFileOps,
  target: string,
  bytes: Uint8Array | string,
): Promise<boolean> {
  const parent = dirname(target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let tempHandle: Awaited<ReturnType<AtomicFileOps["open"]>> | undefined;
  let ownsTemporary = false;
  try {
    await ops.mkdir(parent, { recursive: true, mode: 0o700 });
    await ops.chmod(parent, 0o700);
    tempHandle = await ops.open(temporary, "wx", 0o600);
    ownsTemporary = true;
    await ops.chmod(temporary, 0o600);
    try {
      await tempHandle.writeFile(bytes);
      await tempHandle.sync();
    } finally {
      const handle = tempHandle;
      tempHandle = undefined;
      await closeHandle(handle);
    }

    let created = true;
    try {
      await ops.link(temporary, target);
    } catch (error) {
      if (!isEexist(error)) throw error;
      created = false;
    }
    await ops.unlink(temporary);
    ownsTemporary = false;

    const directoryHandle = await ops.open(parent, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await closeHandle(directoryHandle);
    }
    return created;
  } catch {
    throw new Error("ATOMIC_CREATE_FAILED");
  } finally {
    if (tempHandle) await closeHandle(tempHandle).catch(() => undefined);
    if (ownsTemporary) await ops.unlink(temporary).catch(() => undefined);
  }
}

const nativeOps: AtomicCreateFileOps = {
  mkdir: async (path, options) => fsMkdir(path, options),
  chmod: async (path, mode) => fsChmod(path, mode),
  open: async (path, flags, mode) => fsOpen(path, flags, mode),
  link: async (from, to) => fsLink(from, to),
  rename: async (from, to) => fsRename(from, to),
  unlink: async (path) => fsUnlink(path),
};

export async function atomicWritePrivate(
  target: string,
  bytes: Uint8Array | string,
): Promise<void> {
  const dataRoot = resolve(config.dataDir);
  const absoluteTarget = resolve(target);
  if (!lexicallyContained(dataRoot, absoluteTarget)) throw unsafe();
  await ensurePrivateDataRoot(dataRoot);
  await assertNoSymlinkComponents(dataRoot, absoluteTarget);
  const parent = dirname(absoluteTarget);
  if (parent !== dataRoot)
    await preflightPrivateRoot(dataRoot, parent, { create: true, mode: 0o700 });
  await assertNoSymlinkComponents(dataRoot, absoluteTarget);
  await createAtomicFileWriter(nativeOps)(absoluteTarget, bytes);
}

export async function atomicCreatePrivate(
  target: string,
  bytes: Uint8Array | string,
): Promise<boolean> {
  const dataRoot = resolve(config.dataDir);
  const absoluteTarget = resolve(target);
  if (!lexicallyContained(dataRoot, absoluteTarget)) throw unsafe();
  await ensurePrivateDataRoot(dataRoot);
  await assertNoSymlinkComponents(dataRoot, absoluteTarget);
  const parent = dirname(absoluteTarget);
  if (parent !== dataRoot)
    await preflightPrivateRoot(dataRoot, parent, { create: true, mode: 0o700 });
  await assertNoSymlinkComponents(dataRoot, absoluteTarget);
  const created = await createAtomicFileNoReplace(nativeOps, absoluteTarget, bytes);
  await assertNoSymlinkComponents(dataRoot, absoluteTarget);
  return created;
}
