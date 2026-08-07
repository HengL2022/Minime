# Known issue: orphaned inbox rows from cross-machine DB sync

**Status:** FIXED (self-healing) — commit `e088180`, 2026-06-16
**Severity:** low (no data loss; inflated review-queue count + silent retry churn)

## Symptom

The example below is fictionalized; counts, usernames, and paths are illustrative.

Five `inbox_items` rows stuck `status='pending'` with `classifier_output IS NULL`,
surviving every service restart. They inflated the pending count and were
re-scanned on every `serve` start.

## Root cause

The rows' `raw_path` pointed at files that do not exist on this host:

- 4 rows: `/fixture-host-a/minime/inbox/...` (captured on a different machine by
  `demo-user`, then the Postgres DB was synced to this host)
- 1 row: `/fixture-host-b/minime/inbox/...` (an old `MINIME_DATA_DIR` mismatch,
  file already gone)

`drainStartup()` (src/pipeline/watcher.ts) re-processes pending rows whose
`classifier_output IS NULL`, but `tryProcess` gated on `Bun.file(path).exists()`
and **silently returned** when the file was missing. The source text only ever
existed on the originating machine, so this instance could never classify them —
they sat `pending` forever.

This is **not** a watcher fault and is unrelated to the phantom-org work; it is
residue from importing/syncing a DB that carries another host's file paths.

## Fix (self-healing)

`drainStartup` now distinguishes "recoverable immutable snapshot" from "source missing" for
unclassified pending rows and stale processing claims:

- **stored relative archive present** → verify its SHA-256 and retry from those immutable bytes
- **matching source present** → adopt/create its `(raw_path, content_hash)` identity and process
- **both missing** → `rejectRetryableInboxItem(id, reason)` (status `rejected`,
  `classifier_output = {rejected:true, reason}`) + `logEvent('inbox:orphaned')`,
  then a one-line stderr notice.

So orphans are recorded, auditable, and never retried, while a copied `data/archive/` can recover
a stale claim even when its host-absolute `raw_path` is no longer valid. Regression tests in
`test/m4.importers.test.ts` and `test/inbox-identity.test.ts`
("orphaned pending rows ... are rejected, not retried forever").

## Cleanup performed

Backed up `inbox_items` to `<private-backup-dir>/inbox-orphans-<timestamp>.sql`,
then restarted the service; the new logic auto-rejected all five orphans on boot
(five `inbox:orphaned` events written). The remaining pending rows were legitimate
low-confidence captures awaiting review.

## Note for future cross-machine moves

When syncing the Minime DB between hosts, `raw_path` values remain host-absolute while new
`archive_path` values are relative to `data/`. A pending or stale-processing hashed row can resume
from a copied `data/archive/`; a legacy unhashed pending row still needs its original `data/inbox/`
source and is rejected if neither usable source exists.

Filed database rows themselves remain intact, but retained files copied into `data/inbox/` under a
different absolute repository/data root are observed as new `(raw_path, content_hash)` captures.
They can therefore re-enter normal filing/deduplication. This is the deliberate consequence of the
current path-plus-byte identity; review those captures after a cross-root move rather than assuming
that retained inbox sources are globally deduplicated.
