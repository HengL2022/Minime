// `minime doctor` (W3-7): a fast, local, content-free health check an owner (or an agent acting
// on their behalf, per review-triage.md's ops_failure guidance) can run any time. Every check is
// independently resilient -- a failure in one (e.g. Postgres genuinely down) never prevents the
// rest from printing -- and every detail string is a fixed label, never a URL, DSN, path, or raw
// error/child-process message (CLAUDE.md: "Backup/repair diagnostics never include child output
// or connection fragments"; the same bar applies here).
//
// Run from cli.ts's "doctor" case, placed BEFORE the ollamaPreflight gate (like
// "backup:pre-update") so doctor can report Ollama being unreachable as one WARN line among
// several, instead of dying before it prints anything.

import { statfsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { adminSql } from "../db/client";
import { type OpsHealth, maintenanceLockHeld, opsHealth, recentEventsByVerb } from "../db/repo";
import { fetchOllamaTags } from "../llm/ollama-http";
import { DB_DUMP_DIR, config } from "../util/config";
import type { OllamaEndpoint } from "../util/ollama-url";
import { ollamaPreflight } from "../util/ollama-url";
import { SNAPSHOT_DUMP_BASENAME, SNAPSHOT_MANIFEST_BASENAME } from "./snapshot-manifest";

export type DoctorStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  exitCode: 0 | 1;
}

// Injectable so tests can drive every branch deterministically and offline (I1: tests never
// touch the network or the real repo's db-dump/).
export interface DoctorProbes {
  statfs?: (path: string) => { bavail: number; bsize: number; blocks: number };
  fetchOllamaTags?: (endpoint: OllamaEndpoint) => Promise<string[]>;
  dumpDir?: string;
}

const DREAM_STALE_HOURS = 48;
const DUMP_STALE_HOURS = 48;
// Default cron is weekly (RESTIC_CHECK_CRON, "7 4 * * 0" = every Sunday) -- a bit over 8 days
// tolerates one late/missed fire before this WARNs.
const RESTIC_CHECK_STALE_HOURS = 24 * 8;
const DISK_WARN_FREE_RATIO = 0.1;
const DISK_FAIL_FREE_RATIO = 0.03;

async function checkPostgres(): Promise<DoctorCheck> {
  try {
    await adminSql`select 1`;
    return { name: "postgres", status: "PASS" };
  } catch {
    return { name: "postgres", status: "FAIL", detail: "not reachable" };
  }
}

// Non-fatal by design (spec): Ollama may be legitimately absent when every job routes to a cloud
// provider. Under MINIME_MOCK_OLLAMA (tests), skip the real network call unless a probe is
// injected -- the probe always takes priority so a test can still exercise both branches offline.
async function checkOllama(probes: DoctorProbes): Promise<DoctorCheck> {
  const preflight = ollamaPreflight(config.ollamaUrl);
  if (!preflight.ok) return { name: "ollama", status: "WARN", detail: "OLLAMA_URL invalid" };
  if (!probes.fetchOllamaTags && config.mockOllama) {
    return { name: "ollama", status: "PASS", detail: "mocked" };
  }
  const fetchTags =
    probes.fetchOllamaTags ??
    ((endpoint: OllamaEndpoint) => fetchOllamaTags(endpoint, { timeoutMs: 3_000 }));
  try {
    await fetchTags(preflight.endpoint);
    return { name: "ollama", status: "PASS" };
  } catch {
    return { name: "ollama", status: "WARN", detail: "not reachable" };
  }
}

function hoursSince(at: Date, now: Date): number {
  return (now.getTime() - at.getTime()) / 3_600_000;
}

// Folds every opsHealth() fact into one line, worst-first: never-run/stale dream is FAIL (nothing
// else in the system can be trusted current if maintenance isn't running); an already-open
// ops_failure item (three consecutive failing nights) is also FAIL -- it means the owner has a
// real, standing problem, not a transient one; a failed step on an otherwise-fresh run is WARN.
async function checkDream(now: Date): Promise<DoctorCheck> {
  let health: OpsHealth;
  try {
    health = await opsHealth();
  } catch {
    return { name: "dream", status: "FAIL", detail: "status could not be read" };
  }
  if (!health.dream_last_at) return { name: "dream", status: "FAIL", detail: "has never run" };
  const hours = hoursSince(health.dream_last_at, now);
  if (hours > DREAM_STALE_HOURS) {
    return { name: "dream", status: "FAIL", detail: `last run ${Math.floor(hours)}h ago` };
  }
  if (health.ops_failure_open > 0) {
    return {
      name: "dream",
      status: "FAIL",
      detail: `${health.ops_failure_open} ops_failure review item(s) open`,
    };
  }
  if (health.failed_steps.length > 0) {
    // Step identifiers only (e.g. "3_contradictions") -- fixed, closed vocabulary
    // (audit-payload.ts's DREAM_STEPS), never the underlying error.
    return {
      name: "dream",
      status: "WARN",
      detail: `last run failed: ${health.failed_steps.join(", ")}`,
    };
  }
  return { name: "dream", status: "PASS" };
}

// Backups being off is a legitimate, common configuration choice (GUIDE.md: "Fresh installs
// leave backups disabled until you choose a destination") -- never FAIL here, only WARN.
async function checkDumpFreshness(probes: DoctorProbes, now: Date): Promise<DoctorCheck> {
  const dir = probes.dumpDir ?? DB_DUMP_DIR;
  let mtime: Date;
  try {
    mtime = (await stat(join(dir, SNAPSHOT_DUMP_BASENAME))).mtime;
  } catch {
    return { name: "backup dump", status: "WARN", detail: "no local dump yet" };
  }
  const manifestPresent = await stat(join(dir, SNAPSHOT_MANIFEST_BASENAME)).then(
    () => true,
    () => false,
  );
  if (!manifestPresent) {
    return { name: "backup dump", status: "WARN", detail: "manifest missing" };
  }
  const hours = hoursSince(mtime, now);
  if (hours > DUMP_STALE_HOURS) {
    return { name: "backup dump", status: "WARN", detail: `last dump ${Math.floor(hours)}h old` };
  }
  return { name: "backup dump", status: "PASS" };
}

// W3-9: surfaces the health of the weekly `restic check --read-data-subset` pass by reading its
// audit verb's last event -- this never re-runs restic itself (that stays on serve.ts's cron), so
// the check is fast and needs no restic binary. Review fix: inspects the logged payload.ok, not
// just the event's recency (mirrors sibling checkDream, which grades on opsHealth's failed_steps/
// ops_failure_open rather than only dream:summary's timestamp) -- otherwise a repository that has
// failed every attempt this week still reads PASS as long as some attempt happened recently, which
// defeats the point of an owner-facing integrity signal. Same non-fatal stance as
// checkDumpFreshness throughout: restic being unconfigured, the check never having run yet, or its
// last attempt having failed, is common/recoverable and only ever WARNs, never FAILs.
async function checkResticCheck(now: Date): Promise<DoctorCheck> {
  if (!config.resticRepository || !config.resticPasswordFile) {
    return { name: "restic check", status: "WARN", detail: "restic not configured" };
  }
  let latest: { at: string | Date; payload: unknown } | undefined;
  try {
    [latest] = await recentEventsByVerb("backup:restic-check", 1);
  } catch {
    return { name: "restic check", status: "WARN", detail: "status could not be read" };
  }
  if (!latest) return { name: "restic check", status: "WARN", detail: "has never run" };
  const payload = latest.payload as { ok?: unknown } | null;
  if (payload?.ok === false) {
    return { name: "restic check", status: "WARN", detail: "last check failed" };
  }
  const hours = hoursSince(new Date(latest.at), now);
  if (hours > RESTIC_CHECK_STALE_HOURS) {
    return { name: "restic check", status: "WARN", detail: `last run ${Math.floor(hours)}h ago` };
  }
  return { name: "restic check", status: "PASS" };
}

// Absence is common and not itself a fault -- e.g. doctor run standalone with no resident serve
// -- so this only ever WARNs, never FAILs.
async function checkMaintenanceOwner(): Promise<DoctorCheck> {
  try {
    return (await maintenanceLockHeld())
      ? { name: "maintenance owner", status: "PASS" }
      : { name: "maintenance owner", status: "WARN", detail: "no process currently owns it" };
  } catch {
    return { name: "maintenance owner", status: "WARN", detail: "could not be determined" };
  }
}

function checkDiskHeadroom(name: string, path: string, probes: DoctorProbes): DoctorCheck {
  try {
    const stats = (probes.statfs ?? statfsSync)(path);
    const total = stats.blocks * stats.bsize;
    if (!(total > 0)) return { name, status: "WARN", detail: "could not be determined" };
    const ratio = (stats.bavail * stats.bsize) / total;
    const pct = `${(ratio * 100).toFixed(1)}% free`;
    if (ratio < DISK_FAIL_FREE_RATIO) return { name, status: "FAIL", detail: pct };
    if (ratio < DISK_WARN_FREE_RATIO) return { name, status: "WARN", detail: pct };
    return { name, status: "PASS" };
  } catch {
    return { name, status: "WARN", detail: "could not be determined" };
  }
}

export async function runDoctorChecks(probes: DoctorProbes = {}): Promise<DoctorResult> {
  const now = new Date();
  const checks: DoctorCheck[] = [
    await checkPostgres(),
    await checkOllama(probes),
    await checkDream(now),
    await checkDumpFreshness(probes, now),
    await checkResticCheck(now),
    await checkMaintenanceOwner(),
    checkDiskHeadroom("disk: data/", config.dataDir, probes),
    checkDiskHeadroom("disk: db-dump/", probes.dumpDir ?? DB_DUMP_DIR, probes),
  ];
  return { checks, exitCode: checks.some((c) => c.status === "FAIL") ? 1 : 0 };
}
