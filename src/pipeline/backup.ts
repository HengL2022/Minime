// Nightly and logical database snapshots. All plaintext dumps are private, staged beside
// the stable repository root, and atomically published only after pg_dump succeeds.
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
} from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { preservePreviousSnapshotPair, publishSnapshotManifest } from "../ops/snapshot-manifest";
import { DB_DUMP_DIR, config, ensurePrivateDumpDir } from "../util/config";
import { createLibpqService, registerEphemeralCleanup } from "../util/libpq-service";
import type { LibpqServiceLease } from "../util/libpq-service";

let inFlight = false;
let probeHook: (() => Promise<void>) | undefined;

export type BackupCommandFailure = "spawn_failed" | "exit_nonzero";
export type BackupCommandResult = { ok: true } | { ok: false; failure: BackupCommandFailure };
export type BackupCommandRunner = (
  cmd: string[],
  env?: Record<string, string>,
) => Promise<BackupCommandResult>;

export type PreUpdateSnapshotOutcome =
  | { kind: "taken" }
  | { kind: "unconfigured" }
  | { kind: "failed" };

const BACKUP_DETAIL = {
  dependency: "backup failed (dependency_unavailable)",
  connection: "backup failed (pg_connection_handoff)",
  connectionCleanup: "backup failed (connection_cleanup)",
  staging: "backup failed (dump_staging)",
  manifest: "backup failed (snapshot_manifest)",
  pgDump: "backup failed (pg_dump_command)",
  cleanup: "backup failed (dump_cleanup)",
  resticBackup: "backup failed (restic_backup)",
  resticRetention: "backup failed (restic_retention)",
} as const;

let commandRunnerForTest: BackupCommandRunner | undefined;
let dumpDirForTest: string | undefined;
let dumpTempNameForTest: string | undefined;
let afterDumpTempRegisterForTest: ((path: string) => void) | undefined;
let dumpTempRemoveForTest: ((path: string, attempt: number) => Promise<void>) | undefined;
let dumpTempRemoveSyncForTest: ((path: string, attempt: number) => boolean) | undefined;
let serviceDisposeForTest: ((service: LibpqServiceLease) => Promise<void>) | undefined;
let directorySyncForTest:
  | ((directory: Awaited<ReturnType<typeof open>>) => Promise<void>)
  | undefined;
let manifestWriterForTest: ((dumpDir: string, dumpPath: string) => Promise<void>) | undefined;

type DumpIdentity = { dev: number; ino: number; parent: string };

function sameIdentity(stat: { dev: number; ino: number }, identity: DumpIdentity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function reservedIdentity(fd: number, path: string, parent: string): DumpIdentity {
  const descriptor = fstatSync(fd);
  const entry = lstatSync(path);
  if (realpathSync(parent) !== parent) throw new Error("dump ownership");
  if (
    !descriptor.isFile() ||
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    (descriptor.mode & 0o777) !== 0o600 ||
    (entry.mode & 0o777) !== 0o600 ||
    !sameIdentity(entry, { dev: descriptor.dev, ino: descriptor.ino, parent })
  ) {
    throw new Error("dump ownership");
  }
  return { dev: descriptor.dev, ino: descriptor.ino, parent };
}

async function assertOwnedPath(
  path: string,
  dumpDir: string,
  identity: DumpIdentity,
): Promise<void> {
  await ensurePrivateDumpDir(dumpDir);
  const entry = await lstat(path);
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    (entry.mode & 0o777) !== 0o600 ||
    !sameIdentity(entry, identity) ||
    identity.parent !== dumpDir
  ) {
    throw new Error("dump ownership");
  }
}

async function openOwnedDump(
  path: string,
  dumpDir: string,
  identity: DumpIdentity,
): Promise<Awaited<ReturnType<typeof open>>> {
  await ensurePrivateDumpDir(dumpDir);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptor = await handle.stat();
    const entry = await lstat(path);
    if (
      !descriptor.isFile() ||
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      (descriptor.mode & 0o777) !== 0o600 ||
      descriptor.size === 0 ||
      !sameIdentity(descriptor, identity) ||
      !sameIdentity(entry, identity) ||
      identity.parent !== dumpDir
    ) {
      throw new Error("dump ownership");
    }
    await handle.sync();
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

export function __setInFlightForTest(v: boolean): void {
  inFlight = v;
}
export function __setProbeHookForTest(fn: (() => Promise<void>) | undefined): void {
  probeHook = fn;
}
export function __setCommandRunnerForTest(fn: BackupCommandRunner | undefined): void {
  commandRunnerForTest = fn;
}
export function __setDumpDirForTest(path: string | undefined): void {
  dumpDirForTest = path;
}
export function __setDumpTempNameForTest(name: string | undefined): void {
  dumpTempNameForTest = name;
}
export function __setAfterDumpTempRegisterForTest(
  hook: ((path: string) => void) | undefined,
): void {
  afterDumpTempRegisterForTest = hook;
}
export function __setDumpTempRemoveForTest(
  fn: ((path: string, attempt: number) => Promise<void>) | undefined,
): void {
  dumpTempRemoveForTest = fn;
}
export function __setDumpTempRemoveSyncForTest(
  fn: ((path: string, attempt: number) => boolean) | undefined,
): void {
  dumpTempRemoveSyncForTest = fn;
}
export function __setServiceDisposeForTest(
  fn: ((service: LibpqServiceLease) => Promise<void>) | undefined,
): void {
  serviceDisposeForTest = fn;
}
export function __setDirectorySyncForTest(
  fn: ((directory: Awaited<ReturnType<typeof open>>) => Promise<void>) | undefined,
): void {
  directorySyncForTest = fn;
}
export function __setManifestWriterForTest(
  fn: ((dumpDir: string, dumpPath: string) => Promise<void>) | undefined,
): void {
  manifestWriterForTest = fn;
}

async function run(cmd: string[], env?: Record<string, string>): Promise<BackupCommandResult> {
  if (commandRunnerForTest) {
    try {
      return await commandRunnerForTest(cmd, env);
    } catch {
      return { ok: false, failure: "spawn_failed" };
    }
  }
  try {
    const proc = Bun.spawn(cmd, {
      env: { ...process.env, ...env },
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0 ? { ok: true } : { ok: false, failure: "exit_nonzero" };
  } catch {
    return { ok: false, failure: "spawn_failed" };
  }
}

function resticEnv(): Record<string, string> {
  return {
    RESTIC_REPOSITORY: config.resticRepository!,
    RESTIC_PASSWORD_FILE: config.resticPasswordFile!,
  };
}

function ownedDumpTempSync(path: string, dumpDir: string, identity?: DumpIdentity): boolean {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const parent = lstatSync(dumpDir, { throwIfNoEntry: false });
      const before = lstatSync(path, { throwIfNoEntry: false });
      if (!parent || !before) return true;
      if (!parent.isDirectory() || before.isSymbolicLink() || !before.isFile()) return false;
      if (identity && (!sameIdentity(before, identity) || identity.parent !== dumpDir))
        return false;
      if (dumpTempRemoveSyncForTest && !dumpTempRemoveSyncForTest(path, attempt)) continue;
      if (!dumpTempRemoveSyncForTest) rmSync(path, { force: true });
      if (!lstatSync(path, { throwIfNoEntry: false })) return true;
    } catch {
      /* bounded retry; fixed diagnostic only */
    }
  }
  return false;
}

async function removeOwnedDumpTemp(
  path: string,
  dumpDir: string,
  attempt: number,
  identity?: DumpIdentity,
): Promise<void> {
  const parent = await lstat(dumpDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  const before = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!parent || !before) return;
  if (!parent.isDirectory() || before.isSymbolicLink() || !before.isFile())
    throw new Error("owned dump rejected");
  if (identity && (!sameIdentity(before, identity) || identity.parent !== dumpDir))
    throw new Error("owned dump rejected");
  if (dumpTempRemoveForTest) await dumpTempRemoveForTest(path, attempt);
  else await rm(path, { force: true });
  const after = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (after) throw new Error("owned dump remains");
}

function registerDumpTemp(temp: string, dumpDir: string, identity: DumpIdentity): () => void {
  return registerEphemeralCleanup(temp, () => ownedDumpTempSync(temp, dumpDir, identity));
}

async function discardDumpTemp(
  path: string,
  dumpDir: string,
  identity: DumpIdentity,
  unregister?: () => void,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await removeOwnedDumpTemp(path, dumpDir, attempt, identity);
      unregister?.();
      return true;
    } catch {
      /* fixed cleanup failure; retry once */
    }
  }
  return false;
}

async function pgDump(): Promise<{ ok: boolean; dumpDir: string; detail: string }> {
  const dumpDir = resolve(dumpDirForTest ?? DB_DUMP_DIR);
  const out = join(dumpDir, "minime.sql");
  const temp = join(dumpDir, dumpTempNameForTest ?? `.minime.sql.${randomUUID()}.tmp`);
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
  let tempReserved = false;
  let identity: DumpIdentity | undefined;
  let unregisterDumpTemp: (() => void) | undefined;
  try {
    await ensurePrivateDumpDir(dumpDir);
    fd = openSync(temp, flags, 0o600);
    tempReserved = true;
    identity = reservedIdentity(fd, temp, dumpDir);
    unregisterDumpTemp = registerDumpTemp(temp, dumpDir, identity);
    afterDumpTempRegisterForTest?.(temp);
    fchmodSync(fd, 0o600);
    await ensurePrivateDumpDir(dumpDir);
  } catch {
    const closed = closeReservation();
    const cleaned =
      closed &&
      (tempReserved && identity
        ? await discardDumpTemp(temp, dumpDir, identity, unregisterDumpTemp)
        : true);
    return { ok: false, dumpDir, detail: cleaned ? BACKUP_DETAIL.staging : BACKUP_DETAIL.cleanup };
  }

  let service: LibpqServiceLease;
  try {
    service = await createLibpqService(config.databaseUrl);
  } catch {
    const closed = closeReservation();
    const cleaned =
      closed && identity
        ? await discardDumpTemp(temp, dumpDir, identity, unregisterDumpTemp)
        : false;
    return {
      ok: false,
      dumpDir,
      detail: cleaned ? BACKUP_DETAIL.connection : BACKUP_DETAIL.cleanup,
    };
  }
  let dump: BackupCommandResult;
  try {
    dump = await run(
      ["pg_dump", "--no-owner", "--no-comments", "--no-password", "-f", temp],
      service.env(),
    );
  } catch {
    dump = { ok: false, failure: "spawn_failed" };
  }
  let serviceDisposeFailed = false;
  try {
    if (serviceDisposeForTest) await serviceDisposeForTest(service);
    else await service.dispose();
  } catch {
    serviceDisposeFailed = true;
  }
  if (serviceDisposeFailed || !dump.ok) {
    const closed = closeReservation();
    const cleaned =
      closed && identity
        ? await discardDumpTemp(temp, dumpDir, identity, unregisterDumpTemp)
        : false;
    return {
      ok: false,
      dumpDir,
      detail: cleaned
        ? serviceDisposeFailed
          ? BACKUP_DETAIL.connectionCleanup
          : BACKUP_DETAIL.pgDump
        : BACKUP_DETAIL.cleanup,
    };
  }

  try {
    const completed = await openOwnedDump(temp, dumpDir, identity!);
    await completed.sync();
    await completed.close();
    await assertOwnedPath(temp, dumpDir, identity!);
    if (!closeReservation()) throw new Error("dump reservation close");
    await ensurePrivateDumpDir(dumpDir);
    await rename(temp, out);
    await ensurePrivateDumpDir(dumpDir);
    const directory = await open(dumpDir, "r");
    try {
      if (directorySyncForTest) await directorySyncForTest(directory);
      else await directory.sync();
    } finally {
      await directory.close();
    }
    if (
      await lstat(temp)
        .then(() => true)
        .catch(() => false)
    )
      throw new Error("temp remains");
    unregisterDumpTemp?.();
    return { ok: true, dumpDir, detail: "" };
  } catch {
    const closed = closeReservation();
    const cleaned =
      closed && identity
        ? await discardDumpTemp(temp, dumpDir, identity, unregisterDumpTemp)
        : false;
    return { ok: false, dumpDir, detail: cleaned ? BACKUP_DETAIL.staging : BACKUP_DETAIL.cleanup };
  }
}

async function runBackup(tag: "dream" | "db-snap"): Promise<{ ran: boolean; detail: string }> {
  if (inFlight) return { ran: false, detail: "skipped: another snapshot is in flight" };
  inFlight = true;
  try {
    if (probeHook) await probeHook();
    if (!config.resticRepository || !config.resticPasswordFile) {
      return {
        ran: false,
        detail: "restic not configured (RESTIC_REPOSITORY / RESTIC_PASSWORD_FILE)",
      };
    }
    const which = await run(["sh", "-c", "command -v restic && command -v pg_dump"]);
    if (!which.ok) return { ran: false, detail: BACKUP_DETAIL.dependency };
    try {
      await preservePreviousSnapshotPair(resolve(dumpDirForTest ?? DB_DUMP_DIR));
    } catch {
      return { ran: false, detail: BACKUP_DETAIL.manifest };
    }
    const dumped = await pgDump();
    if (!dumped.ok) return { ran: false, detail: dumped.detail };
    try {
      const dumpPath = join(dumped.dumpDir, "minime.sql");
      if (manifestWriterForTest) await manifestWriterForTest(dumped.dumpDir, dumpPath);
      else await publishSnapshotManifest(dumped.dumpDir, dumpPath);
    } catch {
      return { ran: false, detail: BACKUP_DETAIL.manifest };
    }
    const env = resticEnv();
    const backupArgs =
      tag === "dream"
        ? ["restic", "backup", "--tag", "dream", config.dataDir, dumped.dumpDir]
        : ["restic", "backup", "--tag", "db-snap", dumped.dumpDir];
    const bk = await run(backupArgs, env);
    if (!bk.ok) return { ran: false, detail: BACKUP_DETAIL.resticBackup };
    const retained =
      tag === "dream"
        ? await run(
            [
              "restic",
              "forget",
              "--tag",
              "dream",
              "--group-by",
              "host,tags",
              "--prune",
              "--keep-daily",
              "7",
              "--keep-weekly",
              "8",
              "--keep-monthly",
              "24",
            ],
            env,
          )
        : await run(
            [
              "restic",
              "forget",
              "--tag",
              "db-snap",
              "--group-by",
              "host,tags",
              "--keep-hourly",
              "48",
              "--keep-daily",
              "7",
              "--prune",
            ],
            env,
          );
    if (!retained.ok) return { ran: false, detail: BACKUP_DETAIL.resticRetention };
    return {
      ran: true,
      detail: tag === "dream" ? "backup + prune complete" : "db snapshot + prune complete",
    };
  } finally {
    inFlight = false;
  }
}

export async function backup(): Promise<{ ran: boolean; detail: string }> {
  return runBackup("dream");
}
export async function dbSnapshot(): Promise<{ ran: boolean; detail: string }> {
  return runBackup("db-snap");
}

export async function preUpdateSnapshot(): Promise<PreUpdateSnapshotOutcome> {
  let outcome: PreUpdateSnapshotOutcome;
  if (!config.resticRepository && !config.resticPasswordFile) {
    outcome = { kind: "unconfigured" };
  } else if (!config.resticRepository || !config.resticPasswordFile) {
    outcome = { kind: "failed" };
  } else {
    try {
      const snapshot = await dbSnapshot();
      outcome = snapshot.ran ? { kind: "taken" } : { kind: "failed" };
    } catch {
      outcome = { kind: "failed" };
    }
  }
  console.log(`backup:pre-update ${outcome.kind}`);
  return outcome;
}
