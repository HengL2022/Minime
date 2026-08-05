// Sanctioned ad-hoc repair runner. A repair always gets a private pre-image first; all
// diagnostics and audit payloads are fixed allowlists so row contents and child output cannot
// escape the local repair process.
import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { logEvent } from "../src/db/repo";
import { DB_DUMP_DIR, config, ensurePrivateDumpDir } from "../src/util/config";
import { createLibpqService, registerEphemeralCleanup } from "../src/util/libpq-service";
import type { LibpqServiceLease } from "../src/util/libpq-service";

export interface RepairModule {
  name: string;
  description: string;
  run(args: string[]): Promise<Record<string, unknown>>;
}

const REPO_ROOT = join(import.meta.dir, "..");

export const REPAIR_MODULE_FAILURE_CODE = "repair_module_failed";
export const REPAIR_MODULE_FAILURE_MESSAGE = "repair failed (fixed code: repair_module_failed)";
export const REPAIR_CLEANUP_FAILURE_CODE = "repair_cleanup_failed";
export const REPAIR_CLEANUP_FAILURE_MESSAGE = "repair failed (fixed code: repair_cleanup_failed)";
export const REPAIR_BACKUP_FAILURE_CODE = "repair_backup_failed";
export const REPAIR_BACKUP_FAILURE_MESSAGE = "repair failed (fixed code: repair_backup_failed)";
export const REPAIR_INVALID_SUMMARY_CODE = "repair_invalid_summary";

let repairModuleForTest: RepairModule | undefined;
let afterPreImageRegisterForTest: ((path: string) => void) | undefined;
let preImageNameForTest: string | undefined;
let lastPreImageFailure: "backup" | "cleanup" = "backup";

type PreImageIdentity = { dev: number; ino: number; parent: string };

function sameIdentity(
  stat: { dev: number; ino: number },
  identity: { dev: number; ino: number },
): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function reservedIdentity(fd: number, file: string, parent: string): PreImageIdentity {
  const entry = lstatSync(file);
  const stat = fstatSync(fd);
  if (realpathSync(parent) !== parent) throw new Error("pre-image ownership");
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    !stat.isFile() ||
    (entry.mode & 0o777) !== 0o600 ||
    (stat.mode & 0o777) !== 0o600 ||
    !sameIdentity(entry, stat)
  )
    throw new Error("pre-image ownership");
  return { dev: stat.dev, ino: stat.ino, parent };
}

async function assertOwnedPreImage(
  file: string,
  parent: string,
  identity: PreImageIdentity,
): Promise<number> {
  await ensurePrivateDumpDir(parent);
  const entry = await lstat(file);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    (entry.mode & 0o777) !== 0o600 ||
    identity.parent !== parent ||
    !sameIdentity(entry, identity)
  )
    throw new Error("pre-image ownership");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const descriptor = await handle.stat();
    if (!descriptor.isFile() || !sameIdentity(descriptor, identity))
      throw new Error("pre-image ownership");
    return descriptor.size;
  } finally {
    await handle.close();
  }
}

export function __setRepairModuleForTest(module: RepairModule | undefined): void {
  repairModuleForTest = module;
}
export function __setAfterPreImageRegisterForTest(
  hook: ((path: string) => void) | undefined,
): void {
  afterPreImageRegisterForTest = hook;
}
export function __setPreImageNameForTest(name: string | undefined): void {
  preImageNameForTest = name;
}

async function committed(scriptName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "cat-file", "-e", `HEAD:scripts/repairs/${scriptName}.ts`], {
      cwd: REPO_ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function matchesHead(scriptName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["git", "diff", "--quiet", "HEAD", "--", `scripts/repairs/${scriptName}.ts`],
      {
        cwd: REPO_ROOT,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export function resolveRepairDumpDir(override: string | undefined): string {
  return override ?? DB_DUMP_DIR;
}

function removePreImageSync(file: string, dumpDir: string, identity?: PreImageIdentity): boolean {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const parent = lstatSync(dumpDir, { throwIfNoEntry: false });
      const before = lstatSync(file, { throwIfNoEntry: false });
      if (!parent || !before) return true;
      if (!parent.isDirectory() || before.isSymbolicLink() || !before.isFile()) return false;
      if (identity && (!sameIdentity(before, identity) || identity.parent !== dumpDir))
        return false;
      rmSync(file, { force: true });
      if (!lstatSync(file, { throwIfNoEntry: false })) return true;
    } catch {
      /* bounded retry */
    }
  }
  return false;
}

async function removePreImageAsync(
  file: string,
  dumpDir: string,
  identity?: PreImageIdentity,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const parent = await lstat(dumpDir).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      const before = await lstat(file).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!parent || !before) return true;
      if (!parent.isDirectory() || before.isSymbolicLink() || !before.isFile()) return false;
      if (identity && (!sameIdentity(before, identity) || identity.parent !== dumpDir))
        return false;
      await rm(file, { force: true });
      const after = await lstat(file).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!after) return true;
    } catch {
      /* bounded retry */
    }
  }
  return false;
}

async function disposeService(lease: LibpqServiceLease): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await lease.dispose();
      return true;
    } catch {
      /* fixed retry */
    }
  }
  return false;
}

async function preImageDump(scriptName: string, dumpDir: string): Promise<string | null> {
  lastPreImageFailure = "backup";
  const privateRoot = resolve(dumpDir);
  try {
    await ensurePrivateDumpDir(privateRoot);
  } catch {
    return null;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(
    privateRoot,
    preImageNameForTest ?? `repair-${scriptName}-${ts}-${randomUUID()}.sql`,
  );
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let fd = -1;
  const closeReservation = (): boolean => {
    if (fd === -1) return true;
    try {
      closeSync(fd);
      fd = -1;
      return true;
    } catch {
      return false;
    }
  };
  let reserved = false;
  let identity: PreImageIdentity | undefined;
  let unregister: (() => void) | undefined;
  try {
    await ensurePrivateDumpDir(privateRoot);
    fd = openSync(file, flags, 0o600);
    reserved = true;
    identity = reservedIdentity(fd, file, privateRoot);
    unregister = registerEphemeralCleanup(file, () =>
      removePreImageSync(file, privateRoot, identity),
    );
    afterPreImageRegisterForTest?.(file);
    fchmodSync(fd, 0o600);
    await ensurePrivateDumpDir(privateRoot);
  } catch {
    const closed = closeReservation();
    if (!closed) lastPreImageFailure = "cleanup";
    if (reserved && !(await removePreImageAsync(file, privateRoot, identity)))
      lastPreImageFailure = "cleanup";
    else if (reserved) unregister?.();
    return null;
  }

  let service: LibpqServiceLease;
  try {
    service = await createLibpqService(config.databaseUrl);
  } catch {
    if (!closeReservation()) lastPreImageFailure = "cleanup";
    if (!(await removePreImageAsync(file, privateRoot, identity))) lastPreImageFailure = "cleanup";
    else unregister?.();
    return null;
  }
  try {
    await ensurePrivateDumpDir(privateRoot);
  } catch {
    const disposed = await disposeService(service);
    if (!closeReservation()) lastPreImageFailure = "cleanup";
    if (!(await removePreImageAsync(file, privateRoot, identity))) lastPreImageFailure = "cleanup";
    else unregister?.();
    if (!disposed) lastPreImageFailure = "cleanup";
    return null;
  }
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = Bun.spawn(["pg_dump", "--no-owner", "--no-password", "-f", file], {
      env: service.env(),
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    /* fixed backup failure */
  }
  if (!proc) {
    const disposed = await disposeService(service);
    if (!closeReservation()) lastPreImageFailure = "cleanup";
    if (!(await removePreImageAsync(file, privateRoot, identity))) lastPreImageFailure = "cleanup";
    else unregister?.();
    if (!disposed) lastPreImageFailure = "cleanup";
    return null;
  }
  let exitCode: number | undefined;
  try {
    exitCode = await proc.exited;
  } catch {
    /* fixed backup failure */
  }
  const disposed = await disposeService(service);
  if (exitCode !== 0 || !disposed) {
    if (!disposed) lastPreImageFailure = "cleanup";
    if (!closeReservation()) lastPreImageFailure = "cleanup";
    if (!(await removePreImageAsync(file, privateRoot, identity))) lastPreImageFailure = "cleanup";
    else unregister?.();
    return null;
  }
  try {
    const size = await assertOwnedPreImage(file, privateRoot, identity!);
    if (size > 0) {
      if (!closeReservation()) {
        lastPreImageFailure = "cleanup";
        if (await removePreImageAsync(file, privateRoot, identity)) unregister?.();
        return null;
      }
      unregister?.();
      return file;
    }
    if (!closeReservation()) lastPreImageFailure = "cleanup";
    if (!(await removePreImageAsync(file, privateRoot, identity))) lastPreImageFailure = "cleanup";
    else unregister?.();
    return null;
  } catch {
    lastPreImageFailure = "cleanup";
    closeReservation();
    if (!(await removePreImageAsync(file, privateRoot, identity))) lastPreImageFailure = "cleanup";
    else unregister?.();
    return null;
  }
}

export const __preImageDumpForTest = preImageDump;

type SafeRepairSummary = { counts: Record<string, number>; ids: string[] };

function safeSummary(value: unknown): SafeRepairSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.counts && Array.isArray(candidate.ids)) {
    if (
      typeof candidate.counts !== "object" ||
      candidate.counts === null ||
      Array.isArray(candidate.counts)
    )
      return undefined;
    const counts: Record<string, number> = {};
    for (const [key, count] of Object.entries(candidate.counts)) {
      if (
        !/^[a-z][a-z0-9_]*$/.test(key) ||
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      )
        return undefined;
      counts[key] = count;
    }
    if (!candidate.ids.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)))
      return undefined;
    return { counts, ids: candidate.ids.slice() as string[] };
  }
  // Compatibility normalization for the committed W4 repair module: only IDs and a numeric
  // count survive; arbitrary module fields are never persisted.
  const ids = [candidate.person_id, candidate.org_id].filter(
    (id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
  );
  const count = candidate.edges_repointed;
  if (
    count !== undefined &&
    (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
  ) {
    return undefined;
  }
  if (ids.length || typeof count === "number") {
    return { counts: typeof count === "number" ? { edges_repointed: count } : {}, ids };
  }
  return undefined;
}

export const __safeRepairSummaryForTest = safeSummary;

async function repairFailure(verb: string, code: string, message: string): Promise<number> {
  try {
    await logEvent({
      actor: "system:repair",
      verb,
      payload: { phase: "failed", code, counts: {}, ids: [] },
    });
  } catch {
    /* fixed failure remains the caller contract */
  }
  console.error(message);
  return 1;
}

async function runRepairImpl(
  scriptName: string,
  args: string[],
  opts: { dumpDir?: string } = {},
): Promise<number> {
  const verb = /^[a-z0-9-]+$/.test(scriptName) ? `repair:${scriptName}` : "repair:invalid";
  if (
    !/^[a-z0-9-]+$/.test(scriptName) ||
    !(await committed(scriptName)) ||
    !(await matchesHead(scriptName))
  ) {
    return repairFailure(
      verb,
      "repair_not_committed",
      "repair failed (fixed code: repair_not_committed)",
    );
  }
  let mod: RepairModule;
  try {
    mod =
      repairModuleForTest ?? ((await import(`./repairs/${scriptName}.ts`)).default as RepairModule);
  } catch {
    return repairFailure(verb, REPAIR_MODULE_FAILURE_CODE, REPAIR_MODULE_FAILURE_MESSAGE);
  }
  const backup = await preImageDump(scriptName, resolveRepairDumpDir(opts.dumpDir));
  if (!backup) {
    repairModuleForTest = undefined;
    return lastPreImageFailure === "cleanup"
      ? repairFailure(verb, REPAIR_CLEANUP_FAILURE_CODE, REPAIR_CLEANUP_FAILURE_MESSAGE)
      : repairFailure(verb, REPAIR_BACKUP_FAILURE_CODE, REPAIR_BACKUP_FAILURE_MESSAGE);
  }
  try {
    const summary = safeSummary(await mod.run(args));
    if (!summary)
      return repairFailure(
        verb,
        REPAIR_INVALID_SUMMARY_CODE,
        "repair failed (fixed code: repair_invalid_summary)",
      );
    try {
      await logEvent({
        actor: "system:repair",
        verb,
        payload: { phase: "complete", code: "repair_complete", ...summary },
      });
    } catch {
      return repairFailure(verb, REPAIR_CLEANUP_FAILURE_CODE, REPAIR_CLEANUP_FAILURE_MESSAGE);
    }
    return 0;
  } catch {
    return repairFailure(verb, REPAIR_MODULE_FAILURE_CODE, REPAIR_MODULE_FAILURE_MESSAGE);
  } finally {
    repairModuleForTest = undefined;
  }
}

export async function runRepair(
  scriptName: string,
  args: string[],
  opts: { dumpDir?: string } = {},
): Promise<number> {
  try {
    return await runRepairImpl(scriptName, args, opts);
  } finally {
    repairModuleForTest = undefined;
  }
}

if (import.meta.main) {
  const [name, ...args] = process.argv.slice(2);
  if (!name) {
    console.error("usage: bun run scripts/repair.ts <script> [--k=v ...]");
    process.exit(2);
  }
  process.exit(await runRepair(name, args));
}
