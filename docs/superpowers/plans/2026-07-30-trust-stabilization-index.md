# Trust Stabilization Release Train Implementation Plan

> **Historical process record.** This release-train workflow is superseded by
> `docs/DEVELOPMENT.md`. Its technical findings remain reference material, but its feature freeze,
> branch order, mandatory skills, review chain, SHA locks, and stop/approval rules are inactive.

> Historical note: this plan originally required `superpowers:subagent-driven-development` or
> `superpowers:executing-plans`. That requirement is inactive.

**Goal:** Bring Minime's privacy, runtime, recovery, core product loops, and development
gates into alignment with its documented guarantees before new feature work resumes.

**Architecture:** Six sequential stabilization branches repair the test baseline first and
then close privacy, lifecycle, recovery, workflow, and governance gaps. Every branch is a
complete, independently reviewable deliverable, starts from the exact reviewed predecessor,
and must pass the authoritative offline gate plus its focused acceptance suite before merge.

**Tech Stack:** TypeScript on Bun, PostgreSQL 16 + pgvector, postgres.js, numbered SQL
migrations, MCP stdio, Chokidar, Croner, restic, Bash 3.2-compatible operations scripts,
`bun test`, TypeScript 5.9.3, and Biome.

## Global Constraints

- Preserve I1 local-first, I2 one audited agent door, I3 tiered egress, I4 files/archive +
  rows/state + database/index, I5 provenance, I6 SQL-only numbers, I7 honest envelopes, and
  I8 append-only audit.
- Tier-0 contents never enter logs, events, tests, snapshots, error messages, or agent
  responses. IDs and SQL aggregates remain permitted.
- CI and automated tests remain offline except for localhost PostgreSQL. Tests never use the
  live `minime` database.
- Caller-exported configuration overrides repository `.env`; `.env` is parsed as data and is
  never sourced as shell code.
- Database, model-provider, backup, and restore diagnostics remain content-free and never
  print URLs, credentials, raw capture text, or child output.
- Application domain SQL remains in `src/db/repo.ts`; migration-ledger bootstrap SQL remains
  in `src/db/migrate.ts`; schema/metric SQL remains in numbered migrations and
  `metric_defs.agg_sql` until the S5 system-contract decision explicitly changes that
  boundary.
- No new runtime dependency, ORM, UI, remote database mode, multi-user mode, or WAL-PITR
  subsystem is introduced by this train.
- Schema changes are additive or forward-only. Old binaries must fail closed against new
  privacy columns and may not silently downgrade them.
- Existing owner data, `.env*`, `data/`, `db-dump/`, backups, untracked agent configuration,
  and benchmark files are preserved.
- Feature work is frozen from the first S0 implementation commit until S5 is integrated.
  Defect fixes discovered inside a workstream stay in that workstream; unrelated features
  wait.
- Every spec or operating-contract change is appended to `DECISIONS.md` using
  `log-decision`. The plan itself does not constitute owner approval of those decisions.
- Every implementation branch receives an invariant review before it is declared complete.
- Two failed full-gate/review cycles on one branch stop the train for owner review.

---

## Baseline and Exit Criteria

The plan starts from these observed facts on 2026-07-30:

- Full suite: 943 pass, 1 skip, 1 fail, 1 follow-on error.
- The failing M14 provider-routing test patches `globalThis.fetch`, while the Ollama provider
  now uses its direct request transport.
- `make verify` selects milestone globs and omits 25 of 46 test files.
- Multiple test processes share and destructively reset `minime_test`.
- Twelve `bun run src/cli.ts serve` processes were simultaneously live on the reviewed
  machine.
- Biome and `scripts/check-subsystems.ts` pass.

The train is complete only when:

1. `make verify-offline` is green from a clean clone and opens no external socket.
2. `make verify` is green and includes the retrieval-regression gate.
3. Two simultaneous test commands use distinct disposable databases and both pass.
4. Cloud classification cannot resolve above `CLOUD_MAX_TIER`, including fallback routes.
5. Every PostgreSQL entry point rejects non-loopback, multi-host, socket, and host-override
   targets before connecting.
6. Tier-2 unlock requires an owner-issued, actor-bound short-lived capability; an MCP client
   cannot grant itself access by supplying only a duration, and each approval nonce is
   accepted once.
7. The resident runtime uses a non-owner role; engineering reads cannot expose locked
   content carriers, and every complete dump runs in a dedicated dump-only child.
8. Two MCP clients plus one daemon produce exactly one watcher, one dream schedule, and one
   backup schedule, with clean takeover after daemon exit.
9. A real local-restic drill restores an actual snapshot and fails on planted replay/schema
   corruption.
10. Update never migrates after a configured snapshot failure, and every partial promotion
   state has a tested resume or rollback command.
11. Values, goals, and principles are searchable immediately after onboarding; an unlocked
    owner can inspect and refile an inbox review entirely through MCP.
12. Non-additive metrics use declared rollup semantics; a three-day journal streak reports
    three, not six.
13. Duplicate capture basenames and duplicate note titles cannot overwrite one another.
14. The current system contract replaces the obsolete M0-M6-only source-of-truth claim.

The approval boundary is intentionally scoped to MCP-only clients. Arbitrary code already
running as the owner's OS account remains inside the owner trust boundary until a future
OS-mediated approval/key-store design exists; S5 must state this without implying stronger
human-presence isolation.

---

## Ordered Workstreams

| Order | Branch | Plan | Merge-blocking outcome |
|---|---|---|---|
| S0 | `codex/stabilize-pipeline-baseline` | [S0 — Pipeline baseline](2026-07-30-s0-pipeline-baseline.md) | Full offline gate is authoritative, isolated, linted, typed, green, and the first updater transition fails closed |
| S1 | `codex/stabilize-privacy-boundaries` | [S1 — Privacy boundaries](2026-07-30-s1-privacy-boundaries.md) | Storage/egress are loopback/tier enforced; runtime and engineering roles are least privilege; legacy self-unlocks are invalidated |
| S2 | `codex/stabilize-runtime-lifecycle` | [S2 — Runtime lifecycle](2026-07-30-s2-runtime-lifecycle.md) | Stdio MCP and singleton background ownership are separated and cleanly shut down |
| S3 | `codex/stabilize-recovery-integrity` | [S3 — Recovery integrity](2026-07-30-s3-recovery-integrity.md) | Configuration, snapshot, binary-compatible restore, update, and promotion paths are truthful and fail closed |
| S4 | `codex/stabilize-core-workflows` | [S4 — Core workflows](2026-07-30-s4-core-workflows.md) | Onboarding, review/refile, paths, and metrics complete the promised owner loops |
| S5 | `codex/stabilize-system-governance` | [S5 — System governance](2026-07-30-s5-system-governance.md) | Current contract, PR admission checks, complexity gates, and release evidence are binding |

The order is binding without owner approval. S0 repairs the evidence base used by every later
branch. S1 changes connection and role foundations consumed by S2 and S3. S2 gives S3 one
background owner for backups. S4 depends on S1's actor-scoped access and S2's daemon. S5
records the resulting architecture only after behavior is proven.

Migration numbers are reserved globally:

```text
021_runtime_app_role.sql
022_engineer_content_rls.sql
023_inbox_archive_identity.sql
024_inbox_refile_state.sql
025_metric_rollups.sql
```

No workstream may reuse or reorder these numbers. If an unrelated migration reaches `main`
before execution, renumber all not-yet-implemented migrations together and obtain a fresh
plan review before writing them.

---

## Current Development Pipeline Integration

### Branch and review protocol

- [ ] **Step 1: Commit this seven-file plan package without unrelated files**

```bash
git status --short
git diff --check
git add \
  docs/superpowers/plans/2026-07-30-trust-stabilization-index.md \
  docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md \
  docs/superpowers/plans/2026-07-30-s1-privacy-boundaries.md \
  docs/superpowers/plans/2026-07-30-s2-runtime-lifecycle.md \
  docs/superpowers/plans/2026-07-30-s3-recovery-integrity.md \
  docs/superpowers/plans/2026-07-30-s4-core-workflows.md \
  docs/superpowers/plans/2026-07-30-s5-system-governance.md
git diff --cached --name-only
git commit -m "docs(plans): add trust stabilization release train"
PLAN_SHA="$(git rev-parse HEAD)"
```

Expected: the staged ledger contains exactly the seven plan files. Preserve unrelated
tracked/untracked owner files. If any extra staged path exists, stop without unstaging it.

- [ ] **Step 2: Obtain binding review for the exact plan commit**

```bash
PLAN_SHA="$(git rev-parse HEAD)"
git show --stat --oneline "$PLAN_SHA"
git diff "$PLAN_SHA^" "$PLAN_SHA" -- docs/superpowers/plans
```

Expected: the reviewer names the exact `PLAN_SHA` and returns `PASS`. A `BLOCK` requires a
new plan commit and a fresh review before implementation.

- [ ] **Step 3: Start S0 from the reviewed plan commit**

At execution time use `superpowers:using-git-worktrees`.

```bash
PLAN_SHA="$(git rev-parse HEAD)"
git worktree add .claude/worktrees/stabilize-pipeline-baseline \
  -b codex/stabilize-pipeline-baseline "$PLAN_SHA"
START_SHA="$(git -C .claude/worktrees/stabilize-pipeline-baseline rev-parse HEAD)"
test "$START_SHA" = "$PLAN_SHA"
```

Expected: the worktree starts exactly at the reviewed plan SHA and has no tracked changes.

- [ ] **Step 4: Use one branch and pull request per workstream**

For S1-S5, branch only after the predecessor is merged:

```bash
git fetch origin
git switch main
git pull --ff-only
PREDECESSOR_SHA="$(git rev-parse HEAD)"
git worktree add ".claude/worktrees/<workstream>" \
  -b "codex/<workstream>" "$PREDECESSOR_SHA"
```

Replace `<workstream>` only with the branch suffix from the ordered table. Expected: each
branch has the previous workstream merge as an ancestor. Do not keep parallel implementation
branches across S1-S4 because they share configuration, migrations, and repo interfaces.

- [ ] **Step 5: Implement each task test-first and commit it separately**

Every task in the child plan follows:

```text
RED test commit → minimal implementation commit → focused gate → task commit/review
```

Do not weaken an assertion to make a gate pass. A task may be rejected independently without
discarding accepted earlier task commits.

- [ ] **Step 6: Run branch gates in this order**

```bash
bun install --frozen-lockfile
make verify-offline
make verify
git diff --check
git status --short
```

Expected: dependency manifests remain unchanged except in the S0 commit that adds pinned
TypeScript; both gates pass and the branch contains only its declared file ledger.

- [ ] **Step 7: Review before merge**

Required order:

1. Advisory code/behavior review.
2. Minime invariant review covering I1-I8.
3. Binding final review of the exact branch SHA.
4. Fast-forward or ordinary reviewed PR merge according to repository policy.

No branch is marked complete from targeted tests alone.

### Authoritative targets after S0

```make
verify-offline: verify-m0-offline test lint typecheck check-subsystems
verify: verify-offline eval-search
```

Focused `verify-m0` through `verify-m15` remain available for local iteration. The unscoped
`test` prerequisite is the authoritative all-suite gate and appears exactly once in the
expanded `make verify`. Standalone `verify-m0` remains the owner/live environment probe;
offline M0 is wrapper-owned and mocked through `verify-m0-offline`.

### CI mapping

| Trigger | Required command | Extra evidence |
|---|---|---|
| Every push/PR | `make verify` | MinimeBench scorecard artifact |
| Changes under `scripts/`, `Makefile`, installer, backup, or restore | `make verify` plus shell fixture suites | `bash -n scripts/*.sh` |
| S1/privacy changes | full gate plus role/egress integration suites | invariant review attached to PR |
| S2/runtime changes | full gate plus two-process daemon lease test | shutdown/takeover trace |
| S3/recovery changes | full gate plus temporary local-restic E2E | restore validation transcript with content-free statuses |
| Weekly scheduled run | install matrix plus local-restic restore drill | retained CI artifact |
| Release tag | `make eval-snapshot ROUND=<tag>` | committed scorecard and release checklist |

### Merge and rollback policy

- Migrations are applied only after the branch has passed `make verify` against scratch
  databases.
- S1 runtime-role cutover is explicit for existing installations; `make update` never rewrites
  `.env*`.
- S2 retains one-release compatibility co-hosting so an upgrade cannot silently stop inbox
  processing.
- S3 retains a validated rollback database after promotion until the owner explicitly
  finalizes it.
- S4 migrations are additive; source rows and existing archive files are never renamed or
  deleted.
- Rollback instructions in each child plan are mandatory release-note content.
- Stop the train rather than rolling code back across an unresolved promotion manifest,
  runtime credential cutover, or partially applied forward migration.

---

## Deliberately Deferred

The train does not:

- implement multi-entity capture splitting or first-class manual organization capture;
- add WAL-based point-in-time recovery;
- add a web/mobile UI or multi-device database replication;
- decompose `src/db/repo.ts` beyond S5's five named domains or split
  `src/pipeline/notes.ts`;
- add new retrieval boosts;
- automatically delete compiled notes or access-frequency ranking.

S5 performs the bounded, behavior-preserving five-domain repository split in its reviewed
manifest and installs measurable admission/deletion gates. A later plan may implement the
multi-entity known issue or decompose the remaining repository/notes domains after this
train is green.

---

## Final Release Gate

- [ ] Run all automated gates:

```bash
bun install --frozen-lockfile
make verify
bash -n scripts/*.sh
git diff --check
```

- [ ] Run the owner-controlled operational canary:

```bash
make backup
make restore-drill
make daemon-status
```

Expected: one daemon owner, one successful snapshot, one verified restoration of that actual
snapshot, and no live promotion.

- [ ] Confirm product behaviors through MCP:

```text
locked inbox review inspect → TIER_LOCKED
unlocked same-actor inspect → content returned with source ID
refile note → filed row/page/chunks + resolved queue item
search onboarding value/goal/principle → each returned by ID
weekly journal_streak over three consecutive entries → 3
```

- [ ] Confirm privacy behavior:

```text
remote/multi-host DATABASE_URL → startup refusal before socket
cloud fallback above CLOUD_MAX_TIER → startup refusal before audit/network
locked minime_engineer_ro → no tier-2 alias/queue/validation/event content
runtime DB posture → non-superuser, no CREATEDB, no CREATEROLE, no BYPASSRLS
```

- [ ] Append the final release decision and publish the release scorecard only after every
  assertion above is evidenced.
