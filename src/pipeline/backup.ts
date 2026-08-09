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
  statSync,
  statfsSync,
} from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { logEvent } from "../db/repo";
import { appendOpsLine, classifyStderrLine } from "../ops/ops-log";
import { preservePreviousSnapshotPair, publishSnapshotManifest } from "../ops/snapshot-manifest";
import { ensurePrivateDataRoot } from "../util/atomic-file";
import { auditPayload } from "../util/audit-payload";
import { DB_DUMP_DIR, config, ensurePrivateDumpDir } from "../util/config";
import { createLibpqService, registerEphemeralCleanup } from "../util/libpq-service";
import type { LibpqServiceLease } from "../util/libpq-service";

let inFlight = false;
let probeHook: (() => Promise<void>) | undefined;

export type BackupCommandFailure = "spawn_failed" | "exit_nonzero";
// code/stderrHead are populated on the real Bun.spawn path (a bounded, first-4KB capture --
// see readBoundedStderr) so a failure can be sanitized into the local ops log; both are
// optional so an injected __setCommandRunnerForTest runner may omit them entirely.
export type BackupCommandResult =
  | { ok: true }
  | { ok: false; failure: BackupCommandFailure; code?: number; stderrHead?: string };
export type BackupCommandRunner = (
  cmd: string[],
  env?: Record<string, string>,
) => Promise<BackupCommandResult>;

export type PreUpdateSnapshotOutcome =
  | { kind: "taken" }
  | { kind: "unconfigured" }
  | { kind: "failed" };

// W3-8: every sentinel below gains this fixed suffix, pointing the owner at the local
// mode-0600 ops log (src/ops/ops-log.ts) that now carries a sanitized, allowlist-only
// classification for command-driven failures (dependency/restic/pg_dump). The suffix is
// added uniformly to this map only -- the ad hoc "not configured"/"in flight" strings
// elsewhere in this file are untouched, and the audit event shape (dreamSummary) is unchanged.
const OPS_LOG_HINT = " — see data/logs/ops.log";
const BACKUP_DETAIL = {
  dataRoot: `backup failed (data_root)${OPS_LOG_HINT}`,
  dependency: `backup failed (dependency_unavailable)${OPS_LOG_HINT}`,
  connection: `backup failed (pg_connection_handoff)${OPS_LOG_HINT}`,
  connectionCleanup: `backup failed (connection_cleanup)${OPS_LOG_HINT}`,
  staging: `backup failed (dump_staging)${OPS_LOG_HINT}`,
  manifest: `backup failed (snapshot_manifest)${OPS_LOG_HINT}`,
  pgDump: `backup failed (pg_dump_command)${OPS_LOG_HINT}`,
  cleanup: `backup failed (dump_cleanup)${OPS_LOG_HINT}`,
  resticBackup: `backup failed (restic_backup)${OPS_LOG_HINT}`,
  resticRetention: `backup failed (restic_retention)${OPS_LOG_HINT}`,
  // W3-9: disk headroom is checked before any dump temp file is opened (fail-closed) — see
  // hasDiskHeadroom below. resticCheck is a separate weekly integrity pass, not part of runBackup.
  diskHeadroom: `backup failed (disk_headroom)${OPS_LOG_HINT}`,
  resticCheck: `backup failed (restic_check)${OPS_LOG_HINT}`,
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
let statfsForTest: ((path: string) => { bavail: number; bsize: number }) | undefined;

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
export function __setStatfsForTest(
  fn: ((path: string) => { bavail: number; bsize: number }) | undefined,
): void {
  statfsForTest = fn;
}

const STDERR_CAP_BYTES = 4_096;

// Bounded stderr capture (W3-8): only the first STDERR_CAP_BYTES are kept, but the stream is
// always read to completion so a verbose child can never block on a full, unread pipe. Never
// throws -- a read error just yields whatever was captured before it, and classification
// degrades to "unclassified" rather than losing the caller's own result.
async function readBoundedStderr(
  stream: ReadableStream<Uint8Array> | null,
  capBytes: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && kept < capBytes) {
        const remaining = capBytes - kept;
        const slice = value.length > remaining ? value.subarray(0, remaining) : value;
        chunks.push(slice);
        kept += slice.length;
      }
    }
  } catch {
    /* best-effort capture; a partial or unreadable buffer still classifies safely */
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
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
      stderr: "pipe",
    });
    // Drain concurrently with awaiting exit, not after -- an unread stderr pipe can otherwise
    // fill and deadlock the child before it ever exits.
    const stderrPromise = readBoundedStderr(proc.stderr, STDERR_CAP_BYTES);
    const code = await proc.exited;
    const stderrHead = await stderrPromise;
    return code === 0 ? { ok: true } : { ok: false, failure: "exit_nonzero", code, stderrHead };
  } catch {
    return { ok: false, failure: "spawn_failed" };
  }
}

// Sanitizes a failed command's captured stderr (first line only, allowlist-only -- see
// classifyStderrLine) into the local ops log. Best-effort: logging never throws into the
// caller, and is skipped entirely when the runner didn't fail (nothing to classify).
async function logCommandFailure(step: string, result: BackupCommandResult): Promise<void> {
  if (result.ok) return;
  const firstLine = (result.stderrHead ?? "").split(/\r?\n/)[0] ?? "";
  const detail = classifyStderrLine(firstLine);
  await appendOpsLine({ step, code: result.code, detail }).catch(() => {});
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

// W3-9: 256MB floor when there's no prior dump yet to size against (a fresh install's first
// dump has nothing local to compare to). Once a dump exists, require double its size -- pg_dump
// writes a fresh file beside the old one before the atomic rename, so the old file's bytes stay
// on disk for the whole run.
const MIN_DUMP_FREE_BYTES = 256 * 1024 * 1024;

// Fail-closed disk headroom preflight: statfs the dump directory and require free space at least
// double the current minime.sql (when one exists) or the fixed floor, whichever is larger. Runs
// before any temp file is opened, so a shortfall never leaves a partial dump behind. A statfs
// failure (missing path, permission, platform quirk) also fails closed -- an unreadable
// filesystem is never treated as having room.
function hasDiskHeadroom(dumpDir: string, existingDumpPath: string): boolean {
  let required = MIN_DUMP_FREE_BYTES;
  try {
    required = Math.max(required, statSync(existingDumpPath).size * 2);
  } catch {
    /* no prior dump yet (or unreadable) -- the fixed floor still applies */
  }
  try {
    const stats = (statfsForTest ?? statfsSync)(dumpDir);
    return stats.bavail * stats.bsize >= required;
  } catch {
    return false;
  }
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
    if (!hasDiskHeadroom(dumpDir, out)) {
      await appendOpsLine({ step: "disk_headroom", detail: "disk_low" }).catch(() => {});
      return { ok: false, dumpDir, detail: BACKUP_DETAIL.diskHeadroom };
    }
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
  if (!dump.ok) await logCommandFailure("pg_dump_command", dump);
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
    if (tag === "dream") {
      try {
        await ensurePrivateDataRoot(config.dataDir);
      } catch {
        return { ran: false, detail: BACKUP_DETAIL.dataRoot };
      }
    }
    const which = await run(["sh", "-c", "command -v restic && command -v pg_dump"]);
    if (!which.ok) {
      await logCommandFailure("dependency_unavailable", which);
      return { ran: false, detail: BACKUP_DETAIL.dependency };
    }
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
    if (!bk.ok) {
      await logCommandFailure("restic_backup", bk);
      return { ran: false, detail: BACKUP_DETAIL.resticBackup };
    }
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
    if (!retained.ok) {
      await logCommandFailure("restic_retention", retained);
      return { ran: false, detail: BACKUP_DETAIL.resticRetention };
    }
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

// W3-9: weekly repository integrity check, independent of runBackup's dump/manifest/retention
// steps -- it reads a random subset of the already-uploaded repository (--read-data-subset) and
// never touches the dump directory or the manifest.
//
// It DOES share runBackup's inFlight mutex (review fix): `restic check` takes its own exclusive
// repository lock, so a `restic backup` (dbSnapshot, ticking every BACKUP_CRON) that overlaps it
// fails immediately -- exit 11, "repository is already locked exclusively" -- with no retry. Both
// crons are only ever registered by serve.ts's startOwnerMaintenanceSchedule on the single
// maintenance-lock-owning process (src/serve.ts's beginOwnedMaintenance), so the same in-process
// flag runBackup already uses is sufficient to keep the two from ever colliding at the repository,
// however RESTIC_CHECK_CRON/BACKUP_CRON happen to be configured.
//
// A caller that loses that race is skipped, not retried -- same as runBackup skipping itself --
// and logs no event, since no attempt was actually made; the next scheduled tick tries again. For
// dbSnapshot that's a 15-minute wait, negligible; for resticCheck it's a full week, so losing this
// race regularly would quietly defeat the "weekly" guarantee. That is exactly what the shipped
// defaults used to do (second review fix): RESTIC_CHECK_CRON defaulted to "0 4 * * 0", which sits
// on the identical instant as one of BACKUP_CRON's default "*/15 * * * *" ticks every single
// Sunday, and beginOwnedMaintenance always registers "db snapshot" first, so it silently won that
// tie ~75-80% of weeks. RESTIC_CHECK_CRON's default minute is now 7, off BACKUP_CRON's default
// quarter-hour grid entirely, so the two shipped defaults never coincide (regression test:
// test/backup-preflight.test.ts). The shared flag above remains as defense-in-depth for an owner
// who configures both crons to overlap anyway -- restic's own exclusive lock makes that a real
// failure mode to guard against, just no longer the shipped-default one.
//
// Always logs one 'backup:restic-check' audit event (content-free: {ok} only) on an actual
// attempt; a command failure also gets a sanitized ops.log line, same discipline as
// restic_backup/restic_retention. Deliberately NOT wired into W3-7's ops_failure detector (spec:
// doctor.ts's own "restic check" line, sourced from this verb's last event, covers staleness and
// its last outcome).
export async function resticCheck(): Promise<{ ran: boolean; detail: string }> {
  if (!config.resticRepository || !config.resticPasswordFile) {
    return {
      ran: false,
      detail: "restic not configured (RESTIC_REPOSITORY / RESTIC_PASSWORD_FILE)",
    };
  }
  if (inFlight) return { ran: false, detail: "skipped: another snapshot is in flight" };
  inFlight = true;
  try {
    const result = await run(["restic", "check", "--read-data-subset=5%"], resticEnv());
    if (!result.ok) await logCommandFailure("restic_check", result);
    await logEvent({
      actor: "system:backup",
      verb: "backup:restic-check",
      payload: auditPayload.resticCheck({ ok: result.ok }),
    });
    return result.ok
      ? { ran: true, detail: "restic check complete" }
      : { ran: false, detail: BACKUP_DETAIL.resticCheck };
  } finally {
    inFlight = false;
  }
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
