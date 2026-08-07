# Review remediation plan

**Status:** approved by owner 2026-08-06. `docs/DEVELOPMENT.md` remains the process contract; this is only the short cross-session work list.

**Goal:** close the review findings without turning a one-person project into a release train.

**Non-goals:** no broad `repo.ts` rewrite, automatic restore promotion, WAL/PITR claim, new paid service, push, live-data migration, or public-history rewrite without a separate owner decision.

## Order of work

### 0. Contain public personal material

**Progress (2026-08-06):** current-tree redaction and fictionalization are complete and the
offline gate passes. One unpushed commit still contains its pre-redaction blob and personal Git
metadata; rewriting that local history remains a separate owner decision.

- Replace production-derived names, relationships, row ids, and host paths in `docs/known-issues/` with fictional equivalents while preserving useful reproductions.
- Run `make check-tracked-privacy BASE=origin/main` with owner-supplied terms.
- Owner chooses separately between forward redaction and a coordinated history rewrite; never rewrite or force-push as ordinary implementation.
- **Accept:** current tree and outgoing range are clean; known-issue reports remain useful.

### 1. Make the tier boundary end-to-end

**Progress (2026-08-06): complete in the working tree.** The effective-provider egress gate,
entity/alias/edge tier-provenance path, strict unlock-limit validation, and session-bound pending
owner approval are implemented. Focused adversarial and compatibility tests, the complete offline
gate, and independent privacy review pass. Migrations 022 and 023 have not been applied to owner
data.

- In `src/llm/index.ts`, resolve the effective provider first, then apply `CLOUD_MAX_TIER`. Above-ceiling raw inbox captures stay local or enter manual review with zero cloud fetch.
- Pass source tier and `derived_from` through entity creation/extraction. New people, orgs, aliases, and relations inherit source tier; existing rows may promote to a stricter tier, never drop.
- Validate `TIER2_UNLOCK_MAX_MINUTES` at startup. Bind unlocks to an unguessable MCP session id, not client name. MCP requests an unlock; a local owner CLI approval activates it.
- Update the active privacy contract and record the changed unlock and derived-privacy decisions.
- **Accept:** adversarial tests prove no fallback egress, no tier-2-derived tier-1 facts, no same-name replay, and no malformed-limit fail-open.

### 2. Tighten the local process and database boundary

**Progress (2026-08-06): complete in the working tree.** Runtime child environment and database
endpoint allowlists, private data-root/file handling, the explicit engineering read boundary,
typed content-minimized audit payloads, and rollback-resistant cloud-egress audit are implemented.
Parallel scratch migrations no longer rewrite the cluster-global engineering role. Focused
adversarial suites, the complete offline gate (1,248 pass / 1 intentional skip), and independent
privacy/migration review pass. Migration 024 has not been applied to owner data.

- Replace the runtime-child environment denylist with a small allowlist of Minime settings, required provider credentials, and minimal OS variables.
- Reject non-loopback owner/app database URLs at configuration load; require all recovery endpoints to share the same normalized host/port and expected database names.
- Create `data/`, inbox, archive, and generated prose with 0700 directories and 0600 files; stop returning absolute capture paths through MCP.
- Gate aliases, review queue, and edge-validation content for `minime_engineer_ro` using parent-tier policies or revoked direct reads. Replace free-form audit payloads with typed, content-minimized constructors.
- **Accept:** ambient-token, remote/split-target, locked-engineer, audit-sentinel, and filesystem-mode tests pass.

### 3. Give every inbox capture an immutable identity

**Progress (2026-08-06): identity and finalization complete in the working tree.** Migration 025,
byte-identity replay, no-replace UUID archives, fenced stale claims, add/change watching,
lease-expiry recovery, UUID-suffixed note projections, and atomic database finalization are
implemented. MCP identities commit before file publication on a restricted durable connection;
archive-path crash gaps recover from the deterministic filename; explicit tier predicates remain on
all inbox reads and claims. Focused schema, legacy-upgrade/duplicate, unchanged/changed replay,
low-confidence, archive-collision/gap, MCP rollback/provenance, stale-token/lease, rollback,
concurrency, tier-boundary, and watcher tests pass. Existing deterministic companion splits now commit
all-or-nothing. The general model-driven multi-entity splitter remains an explicit ordinary backlog
item and its known issue stays open. The complete offline gate passes (1,270 pass / 1 intentional
skip), and independent invariant review passes with no findings. Migration 025 has not been applied
to owner data.

- Add inbox content hash, immutable archive path, and processing state. Treat `(raw_path, content_hash)` as replay identity while allowing changed content at the same path.
- Archive under an inbox-id-based name; watch `add` and `change`; suffix note paths with inbox id.
- Add an atomic claim and one final DB transaction covering derivative creation, indexing, and inbox status. Stale claims retry; rolled-back finalization leaves no derivative.
- Once identity is safe, split genuine multi-entity captures into deterministic derivation keys and send uncertain segments to review.
- **Accept:** unchanged replay is idempotent; changed same-path content creates a new capture; same-title notes coexist; crash/concurrency tests create exactly one derivative/key.

### 4. Make restore commands truthful and cutover recoverable

**Progress (2026-08-06): complete in the working tree.** Make recovery targets use an inert-data
`.env` wrapper and narrow child environment; the drill requires and labels a real restic source;
scratch restores verify their historical manifest/counts before migrating to the exact checked-out
ledger and catalog safety posture. Promotion now preflights both databases, writes a private safety
dump, blocks/rechecks connections, uses two explicit renames, compensates a failed second rename,
and retains the prior live database blocked after success. Hostile wrapper/endpoint/schema and full
restore/promotion suites pass, the isolated fictional-data PostgreSQL/restic round trip passes, the
complete offline gate passes (1,314 pass / 1 intentional skip), and independent recovery review
passes with no findings. No owner restore or promotion was run.

- Add one TypeScript wrapper that safely loads repo `.env` values and spawns maintained shell operations; never source `.env` as shell code. Route Make recovery targets through it.
- State whether restore used restic or a fresh live dump; release verification requires restic. Validate endpoint identity before every database utility.
- Check and migrate the scratch database to the checked-out ledger before it becomes promotable.
- Replace the claimed atomic rename with guarded two-step cutover: preflight both databases and replacement-name absence, block connections, rename, and compensate back to `minime` if the second rename fails.
- **Accept:** hostile endpoint/env tests, old-snapshot migration E2E, forced rename compensation, fictional restic round trip, and `make restore-drill` pass.

### 5. Fix calendar and metric time semantics

**Progress (2026-08-06): complete in the working tree.** Calendar parsing now preserves and
validates UTC/`TZID`/floating/all-day forms through explicit DST-safe clock helpers. Metric day
buckets use the caller timezone through a four-argument security-definer aggregate door; checked
`sum|last` metadata makes streak week/month values use the last day, and streak history is built
before the requested lower bound. Caller queries are read-only, while owner-side dream rollups,
anomalies, due-decision checks, and both resident crons use the configured timezone. The runtime
role can read but cannot write the canonical metric cache. The cache now has one explicit owner-zone
identity: a zone change performs an atomic full-history rebuild, while ordinary runs reconcile the
exact mutable day/week/month windows and preserve manual, stored-only, and out-of-window values. A
populated 025-to-026 replay proves both lossless upgrade and transactional rollback. Focused
importer, DST, metric, decision, cron, tier-0, role, reconciliation, and upgrade suites pass; the
final release gate passes (1,373 pass / 1 intentional skip). Migration 026 has not been applied to
owner data.

- Preserve ICS parameters and interpret `TZID`, UTC, floating, and all-day values through explicit helpers in `src/util/clock.ts`.
- Pass MCP `time_zone` into metric aggregation. Add rollup metadata: additive metrics sum; `journal_streak` uses the last value in each week/month. Bucket timestamps in the requested timezone without exposing tier-0 rows.
- Use calendar-day arithmetic for decision reviews and pass `config.tz` to both resident crons.
- **Accept:** Singapore/UTC imports, New York DST fall-back, late-night metric bucketing, streak rollup, review-date DST, and cron-timezone tests pass.

### 6. Make audit and returned provenance complete

**Progress (2026-08-06): complete in the working tree.** Earlier boundary work already made cloud
egress intent/outcome durable across handler rollback and constrained watcher/dream events to
typed content-minimized payloads. `minime_get_context` now preserves edge id/source-table/source-id
evidence and adds every returned edge, task, and commitment to envelope sources, so transport
completion auditing covers every visible returned row while keeping the primary entity first.
Real-transport and locked-tier tests prove exact returned ids/counts and no tier-2 source leakage;
the integrated focused suite passes (131 tests).

- Commit cloud-egress intent through a dedicated autocommit audit path before network I/O so a later MCP rollback cannot erase it; record outcome without prompt/response text.
- Preserve edge id, `source_table`, and `source_id` in `minime_get_context`; include returned tasks and commitments in envelope sources and completion-audit ids.
- Sanitize watcher/dream error events and remove titles, questions, raw paths, and provider bodies from event payloads.
- **Accept:** provider-success/handler-rollback retains egress audit, graph answers are citable, every returned row is audited, and content sentinels are absent from events.

### 7. Align lifecycle commands, docs, and the release gate

**Progress (2026-08-06): complete in the working tree.** `.bun-version` is the exact runtime pin
used by package metadata, install, update, CI, and verification. Install persists one owner-DSN,
backend, and port identity before its first mutation, marks incomplete bootstrap as pending, and
resumes only the exact absent or persisted target; daily lifecycle commands fail closed on missing,
malformed, pending, or ambient-disagreed state. One canonical offline coordinator is shared by Make,
install, update, and CI, with custom-port native/Docker contract coverage. Brain and setup docs now
match the implemented manual-sync and backup behavior. The expanded suite exposed a scratch cleanup
race with a positively identified 12-second autovacuum worker; cleanup now gives only known server
maintenance a bounded 30-second grace while foreign, hidden, mixed, unknown, and drop-busy states
keep the prior 1.9-second fail-closed budget. The focused lifecycle suite (73 pass), independent
cleanup review, and final `make verify` release gate (1,373 pass / 1 intentional skip plus all mock
retrieval bars) pass. No live install, update, migration, or service operation was run.

- Empty restic placeholders by default; “skip backups” clears all backup settings. Persist native/Docker backend and custom port; make reruns read existing credentials before probing.
- Make install/update run the advertised offline checks. Resolve the macOS audit-ordering flake, pin Bun consistently, clean evaluator temp data, and resolve transaction profiles from repo root.
- Correct brain auto-sync/standalone-git claims rather than adding an unrequested daemon. Extract only cohesive helpers from oversized files when a batch already changes that code.
- **Accept:** fresh/rerun/update matrices pass on native and Docker, `make verify-offline` is shared, eventual macOS CI is green, and docs match behavior.

## Final closure

**Evidence (2026-08-06):** `make verify` passes the complete offline and retrieval release gate;
`make verify-restore-e2e` passes an isolated fictional PostgreSQL/restic round trip. The configured
`make restore-drill` reached the labelled restic source but stopped at the content-free
`restic_snapshots` check before any replay, so access to a real backup snapshot remains an owner-side
configuration check. The Batch 0 outgoing privacy scan passed before the later structural-only
changes; a fresh final scan still requires the owner's private terms. No push, public-history
rewrite, live migration, restore promotion, or owner-data operation was performed.

- Run focused tests in each batch. After privacy, migration, install, or recovery work, run `make verify-offline`, the relevant scratch E2E, and one focused independent safety review.
- On the release candidate run `make verify`, `make restore-drill`, and the outgoing privacy scan.
- Stop before push, public-history rewrite, live migration, or restore promotion; each remains an explicit owner action.
