// step 7: nightly backup() (extracted from dream.ts) + frequent dbSnapshot().
// Both dump pg to the same stable db-dump/minime.sql path so restic dedups across the
// two retention policies; --tag + --group-by host,tags keeps those policies from pruning
// each other (dream = nightly, db-snap = 15-min). See DECISIONS.md (2026-06-12).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../util/config";

// Both pg_dump → the same minime.sql, so two restic runs must never overlap (one would
// read a half-written dump). This module-level flag serializes backup() and dbSnapshot();
// the loser skips rather than blocks — the next cron tick covers it.
let inFlight = false;

// Test-only seam: lets the offline suite assert the overlap guard without invoking real
// restic/pg_dump (both functions short-circuit on inFlight before touching binaries).
export function __setInFlightForTest(v: boolean): void {
  inFlight = v;
}

// Test-only seam: an awaitable hook fired immediately after inFlight is claimed (before any
// config/binary work). Lets the offline suite open a deterministic await window while the
// flag is held — proving a concurrent caller skips — without invoking real restic/pg_dump.
// Undefined in production: a no-op the optimizer can drop.
let probeHook: (() => Promise<void>) | undefined;
export function __setProbeHookForTest(fn: (() => Promise<void>) | undefined): void {
  probeHook = fn;
}

async function run(
  cmd: string[],
  env?: Record<string, string>,
): Promise<{ ok: boolean; err: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      env: { ...process.env, ...env },
      stdout: "ignore",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    return { ok: (await proc.exited) === 0, err: err.slice(0, 500) };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

function resticEnv(): Record<string, string> {
  // B2/S3 credentials flow through via run()'s ...process.env spread — do not forward
  // them explicitly here.
  return {
    RESTIC_REPOSITORY: config.resticRepository!,
    RESTIC_PASSWORD_FILE: config.resticPasswordFile!,
  };
}

async function pgDump(): Promise<{ ok: boolean; dumpDir: string; detail: string }> {
  const dumpDir = join(process.cwd(), "db-dump");
  await mkdir(dumpDir, { recursive: true });
  // DB URL carries credentials — pass via env, never on the argv (visible in `ps`).
  const dump = await run(["sh", "-c", 'pg_dump "$PGURL" > "$OUT"'], {
    PGURL: config.databaseUrl,
    OUT: join(dumpDir, "minime.sql"),
  });
  return { ok: dump.ok, dumpDir, detail: dump.ok ? "" : `pg_dump failed: ${dump.err}` };
}

export async function backup(): Promise<{ ran: boolean; detail: string }> {
  // overlap guard first: a backup already running owns the shared db-dump/minime.sql, so
  // skip regardless of config rather than risk reading a half-written dump.
  if (inFlight) return { ran: false, detail: "skipped: another snapshot is in flight" };
  // claim the flag synchronously — BEFORE any await — so a second concurrent invocation
  // sees inFlight=true and skips. The config/binary probes (which await a subprocess) must
  // run inside the guarded region, or two callers could both clear the check and race.
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
    if (!which.ok) return { ran: false, detail: "restic or pg_dump binary not found" };

    const dumped = await pgDump();
    if (!dumped.ok) return { ran: false, detail: dumped.detail };

    const env = resticEnv();
    const bk = await run(
      ["restic", "backup", "--tag", "dream", config.dataDir, dumped.dumpDir],
      env,
    );
    if (!bk.ok) return { ran: false, detail: `restic backup failed: ${bk.err}` };
    await run(
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
    );
    return { ran: true, detail: "backup + prune complete" };
  } finally {
    inFlight = false;
  }
}

// Frequent logical snapshot: db-dump only (no data/), tagged db-snap with its own
// hourly/daily retention so a rollback target is never older than BACKUP_CRON.
export async function dbSnapshot(): Promise<{ ran: boolean; detail: string }> {
  if (inFlight) return { ran: false, detail: "skipped: another snapshot is in flight" };
  // claim the flag synchronously before any await — see backup() for the race rationale.
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
    if (!which.ok) return { ran: false, detail: "restic or pg_dump binary not found" };

    const dumped = await pgDump();
    if (!dumped.ok) return { ran: false, detail: dumped.detail };

    const env = resticEnv();
    const bk = await run(["restic", "backup", "--tag", "db-snap", dumped.dumpDir], env);
    if (!bk.ok) return { ran: false, detail: `restic backup failed: ${bk.err}` };
    await run(
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
    return { ran: true, detail: "db snapshot + prune complete" };
  } finally {
    inFlight = false;
  }
}
