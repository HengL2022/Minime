// W3-8: a local, owner-only sanitized operations log at data/logs/ops.log (mode 0600 in a
// mode-0700 directory). This amends the 2026-07-23 H3 content-free-diagnostics contract
// (DECISIONS.md) with one narrow, allowlist-only exception: audit events and console/CLI
// output stay exactly as content-free as H3 required (no path, URL, child output, or secret),
// and this file is a parallel, strictly local surface for the owner's own troubleshooting --
// never audited, never sent anywhere, never read by an agent.
//
// Every field written here is one of: a fixed step/label identifier (always a source-code
// string literal, never derived from input), a process exit code (an integer), or a
// classification drawn from the fixed, closed allowlist below (classifyStderrLine). An
// unmatched stderr line always classifies to "unclassified" -- the raw line itself is
// discarded immediately after classification and is never retained, logged, or returned.

import { constants } from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { assertNoSymlinkComponents, preflightPrivateRoot } from "../util/atomic-file";
import { config } from "../util/config";

const OPS_LOG_DIRNAME = "logs";
export const OPS_LOG_BASENAME = "ops.log";
export const OPS_LOG_ROTATED_BASENAME = "ops.log.1";

// Approximate by design: size is checked lazily before each append, so the live file can grow
// slightly past this before the next write triggers rotation ("rotate at ~1MB").
const ROTATE_AT_BYTES = 1_000_000;

// Append-only, create-if-missing, regular-file-only open. O_NOFOLLOW refuses a symlink swapped
// in at the last instant (assertNoSymlinkComponents below is the primary check; this is
// defense in depth); O_NONBLOCK keeps a pre-existing FIFO from hanging this call forever
// waiting for a reader -- both are no-ops for the regular file this path is meant to be.
const APPEND_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

export interface OpsLogEntry {
  /** Fixed step/label identifier -- always a source-code string literal, never user input. */
  step: string;
  /** Process exit code, when the failure came from a spawned command. */
  code?: number;
  /** JS error constructor name (dream/serve exception failures) -- never error.message. */
  errorClass?: string;
  /** Allowlisted stderr classification (backup command failures) -- never raw stderr text. */
  detail?: string;
}

// Fixed regex -> classification table (spec allowlist). Anything that does not match is
// "unclassified"; the matched/unmatched input line itself never leaves classifyStderrLine.
const STDERR_ALLOWLIST: ReadonlyArray<readonly [RegExp, string]> = [
  [/repository is already locked/i, "repo_locked"],
  [/no space left on device/i, "disk_full"],
  [/unable to open config file/i, "repo_auth"],
  [/wrong password/i, "repo_auth"],
  [/connection refused/i, "pg_unreachable"],
];

/** Allowlist-only classification. Never returns (or leaks) anything but one of the fixed
 * classes above, or the literal "unclassified" for anything that does not match. */
export function classifyStderrLine(line: string): string {
  for (const [pattern, cls] of STDERR_ALLOWLIST) {
    if (pattern.test(line)) return cls;
  }
  return "unclassified";
}

function formatLine(entry: OpsLogEntry, now: Date): string {
  const cls = entry.errorClass ?? entry.detail ?? "unclassified";
  const exitPart = entry.code === undefined ? "" : ` exit=${entry.code}`;
  return `${now.toISOString()} ${entry.step}${exitPart} class=${cls}\n`;
}

async function rotateIfNeeded(dir: string, file: string): Promise<void> {
  const size = await stat(file)
    .then((s) => s.size)
    .catch(() => 0);
  if (size < ROTATE_AT_BYTES) return;
  const rotated = join(dir, OPS_LOG_ROTATED_BASENAME);
  // Best-effort single-generation rotation: drop any prior .1, then move the current file.
  await unlink(rotated).catch(() => {});
  await rename(file, rotated).catch(() => {});
}

/**
 * Append one sanitized line to the local ops log, creating/verifying data/logs (0700) and
 * ops.log (0600) with the same symlink-safe conventions atomic-file.ts uses for data/inbox.
 * Best-effort by design: every call site awaits this with `.catch(() => {})` so a logging
 * failure here can never interrupt the operation it is trying to record.
 */
export async function appendOpsLine(entry: OpsLogEntry): Promise<void> {
  const dir = join(config.dataDir, OPS_LOG_DIRNAME);
  await preflightPrivateRoot(config.dataDir, dir, { create: true, mode: 0o700 });
  const file = join(dir, OPS_LOG_BASENAME);

  await assertNoSymlinkComponents(config.dataDir, file);
  await rotateIfNeeded(dir, file);
  await assertNoSymlinkComponents(config.dataDir, file);

  const handle = await open(file, APPEND_FLAGS, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("ops_log_not_a_file");
    await handle.chmod(0o600);
    await handle.writeFile(formatLine(entry, new Date()));
  } finally {
    await handle.close();
  }
}
