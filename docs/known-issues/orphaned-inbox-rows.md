# Known issue: orphaned inbox rows from cross-machine DB sync

**Status:** FIXED (self-healing) — commit `e088180`, 2026-06-16
**Severity:** low (no data loss; inflated review-queue count + silent retry churn)

## Symptom

21 `inbox_items` rows stuck `status='pending'` with `classifier_output IS NULL`,
surviving every service restart. They inflated the pending count and were
re-scanned on every `serve` start.

## Root cause

The rows' `raw_path` pointed at files that do not exist on this host:

- 20 rows: `/Users/hlbot/.hermes/data/inbox/...` (macOS paths — captured on a
  different machine, user `hlbot`, then the Postgres DB was synced to this Linux box)
- 1 row: `/home/ubuntu/.hermes/data/inbox/...` (the old MINIME_DATA_DIR mismatch,
  file already gone)

`drainStartup()` (src/pipeline/watcher.ts) re-processes pending rows whose
`classifier_output IS NULL`, but `tryProcess` gated on `Bun.file(path).exists()`
and **silently returned** when the file was missing. The source text only ever
existed on the originating machine, so this instance could never classify them —
they sat `pending` forever.

This is **not** a watcher fault and is unrelated to the phantom-org work; it is
residue from importing/syncing a DB that carries another host's file paths.

## Fix (self-healing)

`drainStartup` now distinguishes "file present" from "file missing" for
NULL-classifier pending rows:

- **present** → process as before
- **missing** → `setInboxRejected(id, reason)` (status `rejected`,
  `classifier_output = {rejected:true, reason}`) + `logEvent('inbox:orphaned')`,
  then a one-line stderr notice.

So orphans are recorded, auditable, and never retried. New repo helper
`setInboxRejected()`. Regression test in `test/m4.importers.test.ts`
("orphaned pending rows ... are rejected, not retried forever").

## Cleanup performed

Backed up `inbox_items` to `~/minime-backups/inbox-orphans-20260616-095914.sql`,
then restarted the service; the new logic auto-rejected all 21 orphans on boot
(21 `inbox:orphaned` events written). Post-state: 32 filed / 6 pending (all
legitimately classified low-confidence, awaiting review) / 21 rejected.

## Note for future cross-machine moves

When syncing the Minime DB between hosts, `raw_path` values are host-absolute.
Already-`filed` rows are unaffected (text lives in the typed tables + brain
archive), but any still-`pending` NULL-classifier rows will be auto-rejected on
the new host because their source files don't travel with the DB. If you need
those captures, copy `data/inbox/` (or `data/archive/`) alongside the DB.
