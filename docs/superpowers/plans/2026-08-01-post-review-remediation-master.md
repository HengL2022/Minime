# Post-Review Remediation Master Implementation Plan

> **Superseded draft. Do not execute or ratify.** `docs/DEVELOPMENT.md` replaces this document
> with the active lightweight completion roadmap. The technical concerns below may be consulted
> selectively, but its task order, embargoes, authority locks, custody ledgers, named-model review
> chain, exact-SHA verdicts, receipts, and owner-approval loops are inactive.

> Historical note: this draft originally required `superpowers:subagent-driven-development`.
> That requirement is inactive.

**Status:** SUPERSEDED DRAFT — preserved only for technical reference.

**Goal:** Correct the public-data leak, make evaluation and recovery evidence truthful, finish the minimum trust train, and return to product work without discarding active S1 work.

**Historical architecture:** this proposed an orchestration authority and amendment index with
serialized code work and fresh Sol/Luna agents. None of those process mechanics is current.

**Pinned source authority:** At base `3e04033b732efd0ff914819180e2ba1cb1a1658b`, SHA-256 is S1 `8199eb7ebe20c96df34c82734c795a72959e821f086dad157de8c8398dbafa6d`, S2 `01c6782a1287a5fb75a9fc1e743bb13676692f00bb757dc3ca73465d8ec98301`, S3 `114f88dacb030c463316472af10c3a606ef7e9161213100a420506fadad4c51c`, S4 `36cccc061e2cdb5a46b030638855cb56a4aee96a23be42328606082131b40d31`, S5 `2fc656ec20c6e6fe3a3ff210db5c6758a32d4c3f5cd30656856692c49008a94c`, and index `e76d6042536716ee2f2ce7f84aa0c12b3191746efd054327f6d0a8e36951a02a`. Task 0's reviewed lock pins accepted post-amendment hashes; drift requires owner re-ratification and full plan review.

**Tech Stack:** Bun, TypeScript 5.9.3, PostgreSQL 16 + pgvector, Bash 3.2, restic, MinimeBench, Biome, Make, Git worktrees, GPT-5.6 Luna/Sol xhigh.

## Global Constraints

- Preserve invariants I1–I8 and every privacy/tier rule in `CLAUDE.md` and `AGENTS.md`.
- Never print, log, commit, or place on argv a private identifier, raw tier-0/tier-2 value, DSN, secret, credential-bearing/private URL, dump content, or unsanitized/unbounded child output; fixed content-free evidence is allowed.
- Never touch live `minime`, shared/template databases, `.env*`, `data/`, `db-dump/`, backups, or unrelated files; Tasks 7/9/10 may use only their sanctioned fictional scratch/restic fixtures and explicit owner-run fixed backup/receipt paths. Sibling worktrees are protected except Tasks 2/12 custody.
- All tests are offline except explicit owner-run live evals and localhost PostgreSQL.
- No push is permitted until Task 1 records exact-SHA `tree_clear`, `unpublished_clear`, and `public_history_ack`, derives `publication_clear=true`, and the owner separately authorizes publication.
- No history rewrite, force-push, visibility change, or remote mutation is in this plan.
- Migrations 021–025 remain reserved as documented; Task 9 reserves 026.
- Do not rewrite compiled notes, split `repo.ts`, or expand the H1 recovery mega-test.
- Existing code is never stashed, reset, rebased, or overwritten. Custody is proven before a branch changes.
- The master plan stays below 300 lines. Review reports are transient and never committed.
- Two failed correction/full-gate cycles in one workstream stop for owner review.
- An unresolved Critical or Important finding blocks integration.

## Authority and Owner Ratification

Approval of this plan ratifies these exact amendments:

1. Current-tip privacy redaction may replace owner-derived text, including historical `DECISIONS.md` prose, with synthetic labels. A content-free decision explains the one-time exception; this plan does not rewrite public history.
2. Work order is Tasks 1–12. T0 blocks every reordered or deferred workstream, not only late tasks.
3. The freeze formally ends after S4, but W5 still waits for Tasks 10–11 recovery/contract gates.
4. S3 Tasks 6–10 are superseded by a minimal durable manifest plus tested, owner-invoked one-edge recovery; automatic partial-state resume/finalization is not claimed.
5. S5 Task 3 becomes the MCP-reader suite. S5 Task 4 becomes Task 11's bounded gate; no repo split or new size-limit system.
6. Truth day runs monthly and before a public release if over 30 days old. Publication is an owner-approved weekly push only after candidate-specific `publication_clear=true`, including its public-history disposition gate.
7. Hardening cannot preempt an in-progress feature milestone without another owner decision.
8. Sol xhigh owns test/acceptance design, binding review, and Critical adjudication; Luna xhigh owns test-first execution and first-pass review.

If the owner changes any item, revise and re-review this plan before Task 0.

## Immutable Starting Ledger

| Item | Reviewed state | Custody rule |
|---|---|---|
| `main` / public tip | `3e04033b732efd0ff914819180e2ba1cb1a1658b`; public `57c0c2025c2ac2f1678e170b865d88ce6c3444c2`; 139 unpublished | tracked-clean; preserve untracked files |
| S1 parent | `73360df719e0d86af850dffc9bb34c083c1b3ea5` | clean; preserved ancestry source |
| S1 Task 4 | `8965102a8649243d569d484f414ecb4ecbb95abc`; merge-base `e457ae50b5ed0fbf511e8cfe2f5d155f2185e58a`; 5 parent-only/3 task-only | 11 tracked edits |
| W5 | `49f3158e4783cfaeacaea3619ae4877375fbc33c`; 50 main-only/2 W5-only | design input only; never resume as code base |
| push | forbidden | until candidate `publication_clear=true` + separate owner approval |

Any changed SHA, dirty ledger, or branch count requires a new content-free preflight report.

## Agent and Review Topology

| Stage | Agent | Responsibility |
|---|---|---|
| Plan/test card | fresh `planner_sol` or Sol xhigh tester | freeze files, RED proof, acceptance, rollback |
| Execution | fresh `executor_luna` xhigh | own declared files; TDD; focused gates; no self-review |
| First pass | fresh `first_pass_reviewer_luna` xhigh | correctness, scope, tests, operational hazards |
| Independent test | fresh Sol xhigh tester | rerun RED/GREEN and focused/branch gates independently |
| Binding review | fresh `final_reviewer_sol` xhigh | exact-SHA requirements/invariant verdict |
| Critical dispute | fresh `critical_adjudicator_sol` xhigh | independently uphold or close a Luna Critical |

Each workstream follows: custody preflight → Sol test-card approval → Luna RED/GREEN → Luna first pass → correction → Sol tests → invariant review where required → Sol binding review → integrate. Every verdict records the exact reviewed branch SHA and commands; a SHA change invalidates it. Reviewers never edit. A Luna Critical requires pre-correction Sol adjudication and post-correction Sol closure. For Tasks 1–11 the independent Sol tester reruns the focused, `make verify-offline`, `make verify`, and local E2E gates; owner-credential live gates are validated from exact-SHA receipts, not rerun by reviewers.

## Ordered Workstreams

| Task | Branch/outcome | Depends on |
|---:|---|---|
| 0 | Ratify plan and amend active contracts | owner approval |
| 1 | `codex/remediate-publication-privacy` | Task 0; blocks push |
| 2 | Finish and integrate S1 Tasks 4–6 | Task 1 `tree_clear` + existing Task-4 custody |
| 3 | `codex/characterize-mcp-readers` | Task 2 |
| 4 | `codex/typecheck-evidence-scripts` | Task 3 |
| 5 | `codex/remediate-live-eval-evidence` + owner truth run | Task 4 |
| 6 | `codex/remediate-search-gates` and S5 Task 2 ablation | Task 5 |
| 7 | `codex/remediate-restore-truth` (S3 Tasks 1–4) | Task 6 |
| 8 | `codex/stabilize-runtime-lifecycle-v2` | Task 7 |
| 9 | `codex/stabilize-core-workflows-v2` + multi-entity Task 7 | Task 8 |
| 10 | `codex/finish-recovery-manual` | Task 9 |
| 11 | `codex/stabilize-system-governance-v2` + bounded gate | Task 10 |
| 12 | fresh W5 → W6 → W9 planning/execution | Task 11 + owner start approval |

Code branches are serial even when read-only testing/review runs concurrently. After approval, create a clean dedicated worktree for local `codex/post-review-remediation-integration` and tag `archive/remediation-base-20260801` at exact `3e04033b732efd0ff914819180e2ba1cb1a1658b`. Each ordinary Task 1 and 3–11 branch starts at integration `TASK_PREDECESSOR_SHA`; set `TASK_TAG=accepted/remediation-task-${TASK_NO}-20260801`. Before acceptance require exact HEAD, empty porcelain, ancestor proof, exact NUL path ledger/reviewed commit range, and absent tag; then `git tag "$TASK_TAG" "$TASK_ACCEPTED_SHA"`, verify its peeled OID, `git merge --ff-only`, and require integration HEAD equals accepted SHA and stays clean. A failed branch never moves integration; correction starts at current tip with a new ledger/review or stops. Task 2 uses the same proofs. `main` stays unchanged until Task 11 PASS.

### Task 0: Ratify and Amend the Train

**Files:** Modify `DECISIONS.md`, `CLAUDE.md`, `README.md`, `docs/GUIDE.md`, the trust index, S3, and S5 plans; add this master plan and `docs/superpowers/plans/2026-08-01-remediation-authority-lock.json`. No runtime code.

- [ ] After explicit chat approval, create Task 1's branch from the immutable integration base and write `2026-08-01 — Post-review remediation and private-text redaction exception` as a content-free `DECISIONS.md` entry containing all eight amendments and `Approved by: human owner`; keep every Task 0 edit uncommitted until Task 1 records `index_clear=true`.
- [ ] Mark conflicting order, freeze, review, S3 acceptance, and S5 Task 3/4 claims as superseded by this master plan; preserve historical text except Task 1's privacy exception.
- [ ] Generate the lock from staged bytes: the six base hashes above, accepted post-amendment SHA-256s, paths, and amendment IDs only. Task 1's binding review permits only this plan's deltas; after its accepted tag, every `Source` reference reads the locked blob from that tag, not a mutable working-tree file.
- [ ] Correct the false M0→M6 order, verify-target, and resident-sync claims now; the final contract link waits for Task 11.
- [ ] Run `bun test test/verify-contract.test.ts && git diff --check`.
- [ ] Defer Luna/Sol review of the plan/decision diff until Task 1 has a sanitized committed tree; reviewers receive only the sanitized zero-context diff and exact SHA.

**Acceptance:** every active instruction resolves to one order and one review protocol; no pre-sweep blob is committed.

### Task 1: Publication Privacy Sweep — Push Embargo

**Files:** Create `scripts/check-tracked-text-privacy.ts`, `scripts/verify-publication-clear.ts`, `scripts/install-publication-gate.ts`,
`.githooks/pre-push`, and `test/tracked-text-privacy.test.ts`; modify `Makefile`, `CLAUDE.md`, `AGENTS.md`, every
content-free hit manifest path, the two known-issue documents, affected decision prose,
fixture tests, and only hit-ledger tracked plans. Never store private terms in Git.

**Interface:** discovery inventories every reachable object OID/type: full commit/tag bytes, raw tree bytes plus paths, and blobs, writing candidates only to an owner mode-0600 FD; scan requires every entry classified and emits counts/opaque hashes. Replacement edits exact matches only in ledger-listed tracked in-root regular nonsymlink files and rejects protected/traversal/device/untracked paths. `repoRoot` is `.` or private `MINIME_SCAN_REPO_ROOT`; values/paths never enter argv/stdout.

- [ ] RED: synthetic tests prove unknown discovery; ledger-bounded index/tree/history/range; commit names/emails/messages; NUL, opaque-binary disposition, symlink/mode/traversal/protected-path refusal; FD/argv/output safety; and pre-push rejection of tags, non-main refs, stale receipts, or uncovered objects.
- [ ] Set `PUBLIC_TIP=57c0c2025c2ac2f1678e170b865d88ce6c3444c2` and require `test "$(git ls-remote --refs origin refs/heads/main | awk '{print $1}')" = "$PUBLIC_TIP"`; a changed/unavailable public tip stops for a new audit.
- [ ] From the custody-clean Task-1 branch, stage only declared Task 0/1 paths, preserving unrelated untracked files. With `umask 077`, run discover/scan on `index`, `history:$PUBLIC_TIP`, and `range:$PUBLIC_TIP..HEAD` using fixed FDs for candidate, path, review, and map files; owner-classify every candidate/object and add unknown terms. Replace only `--scope index --paths-fd 4 --map-fd 3`; reclassification is mandatory after any edit. Unclassified/malformed entries fail closed; Luna sees only sanitized diffs.
- [ ] Enumerate every index/history/range blob, path, and complete commit object (headers/signatures/messages); totals and ordered object-set hashes must match Git enumeration. Valid UTF-8 is scanned even with NUL. Each non-text blob needs a private hash-bound owner disposition; unsupported, encrypted, oversize, or unreviewed content blocks clearance. Outgoing tags/non-main refs are forbidden rather than silently omitted.
- [ ] Replace hits with shape-equivalent fictional people, organizations, projects, paths,
  and mixed CJK/Latin examples; retain bug semantics.
- [ ] From a custody-clean branch, stage only Task 0/1 paths, scan `--scope index`, and require `index_clear=true` before the first commit. After commit, rescan `--scope tree:HEAD --scope history:$PUBLIC_TIP --scope range:$PUBLIC_TIP..HEAD`, require the committed tree hash to equal the cleared index tree, then run `bun test test/tracked-text-privacy.test.ts && make verify`; exact current-tree zero sets `tree_clear`, and zero candidate-unpublished hits sets `unpublished_clear` for that SHA.
- [ ] `make install-publication-gate` resolves canonical `--git-common-dir` and atomically installs a hash-verified common hook/verifier, refusing a nonmatching hook/path config so every linked worktree uses it. `make publication-clear CANDIDATE=HEAD REMOTE=origin` and owner-run `make approve-publication` create common-dir mode-0600 receipts binding hook/verifier SHA-256, hashed destination, refs, candidate/remote-tip OIDs, and clearance hashes. The hook self-verifies, requires `merge-base --is-ancestor REMOTE_TIP CANDIDATE`, and permits one exact main update; direct/alternate remotes, old worktrees, multi/delete/followed-tag refs, stale tips, or mismatch fail fixed.
- [ ] Give only the owner the private manifest. If public hits exist, require content-free decision `2026-08-01 — Public-history publication disposition` with report SHA-256, `choice: forward_only|no_publication`, and `Approved by: human owner`; only zero hits or `forward_only` sets `public_history_ack`. Restage, index-clear, commit, tree-rescan, and regenerate the candidate receipt after this entry; never rewrite/force-push here.
- [ ] After every replacement and immediately before final index-clear, regenerate the authority lock and prove every hash equals its index blob; after acceptance, prove the accepted tag's blobs equal the lock. `publication_clear=tree_clear&&unpublished_clear&&public_history_ack`; no hook install or receipt authorizes a push by itself.

**Acceptance:** owner signs `tree_clear=true`, discovery is manually triaged, and all current fixtures are fictional, allowing local Task 2. Publication remains independently blocked unless the exact candidate also has all three machine-checked publication gates.

### Task 2: Preserve, Finish, and Integrate S1

**Source:** `docs/superpowers/plans/2026-07-30-s1-privacy-boundaries.md` Tasks 4–6, amended here.

**Custody ledger:** `db/migrations/021_runtime_app_role.sql`, `src/ops/runtime-role-privileges.ts`, `test/fixtures/private-role-cluster.ts`, `test/fixtures/role-cluster-child.ts`, `test/runtime-role-install.test.ts`, `test/runtime-role-privilege-manifest.test.ts`, `test/runtime-role.test.ts`, `test/setup.ts`, `test/support/role-cluster.ts`, `test/support/test-database-admin.ts`, `test/test-database-isolation.test.ts`.

- [ ] Before mutation, require `$S1_WORKTREE` branch `codex/s1-task4-runtime-role`, HEAD `8965102a8649243d569d484f414ecb4ecbb95abc`, merge-base `e457ae50b5ed0fbf511e8cfe2f5d155f2185e58a`, and byte-exact status equal to the 11 tracked paths with zero untracked/extra paths; tag that HEAD `archive/s1-task4-head-20260801`. Set private `MINIME_SCAN_REPO_ROOT="$S1_WORKTREE"`; run Task 1 ledger-bounded discover/classify/replace/scan, reprove the ledger, then commit only it, record `PRESERVE_SHA`, and tag `archive/s1-task4-preserve-20260801`; never stash/reset/push tags.
- [ ] Tag untouched parent `73360df719e0d86af850dffc9bb34c083c1b3ea5` as `archive/s1-parent-20260801`; create `codex/stabilize-privacy-boundaries-v2` there, merge sanitized integration, then create child `codex/s1-task4-runtime-role-v2` and cherry-pick `dace7f3b5da4d5ec1e7d2d9f744666e0aabb08df`, `6991ab35dffc894b9ff471389791046086678422`, `8965102a8649243d569d484f414ecb4ecbb95abc`, and `PRESERVE_SHA`. Abort conflicts; finish Tasks 4–6 on sequential accepted child commits, fast-forward S1-v2, then integration only after final S1 PASS. Tags remain recovery refs.
- [ ] Finish Task 4's runtime-role cutover using its existing file ledger and sealed tests.
- [ ] Finish Task 5 with whole-row omission for locked review items and a novel-key leak test.
- [ ] Task 6 adds `src/importers/transactions.ts` to the producer ledger and explicitly extends S1's closed registry: `import:transactions` is `{total,inserted,updated,skipped}` using `count`; transaction-only `import:malformed` is `{malformed_code:"invalid_date_or_amount",row_index:count}`. Existing calendar/email/health codes remain unchanged; no free-form reason survives.
- [ ] After cherry-picks, the owner reruns Task 1's private scanner on the candidate tree; any hit blocks integration. Then run focused role/privacy/audit/importer suites, `make verify-offline`, and `make verify`.

**Acceptance:** migrations 021–022, non-owner runtime, actor-bound unlock, row omission, and
closed content-free event payloads all pass; S1 integrates locally without a push.

### Task 3: Characterize MCP-Reachable Readers

**Files:** Create `scripts/check-mcp-reader-inventory.ts`, `test/fixtures/mcp-reader-inventory.json`, and `test/mcp-reader-tier.test.ts`; minimally modify `src/db/repo.ts` only for the unknown-parent guard.

- [ ] Treat current tier behavior as characterization GREEN. RED is the missing unknown-parent guard/inventory drift; `bun run scripts/check-mcp-reader-inventory.ts --mutation-test` copies sources and separately removes tier predicate, actor session binding, expiry, tier-0 denylist, and parent guard, requiring the reader suite to fail without a production hook.
- [ ] Statically traverse local imports/re-exports from MCP tool and transitive search entrypoints, exact-compare every reachable repo-reader symbol to the checked-in inventory, and reject unknown dynamic imports or unclassified readers.
- [ ] Bind `openReviewItems(kind, actor)` to S1 omission; document `accessCounts` as structural;
  prove `getRow` rejects an unknown parent type before SQL.
- [ ] Run `bun test test/mcp-reader-tier.test.ts && bun run scripts/check-mcp-reader-inventory.ts`; the universal Sol gate adds both full verify targets.

**Acceptance:** executable tier evidence is statically checked against MCP/transitive search imports; no repo split is needed.

### Task 4: Typecheck Evidence Scripts and Remove Test Theater

**Units:** (A) create `tsconfig.scripts.json`; wire a second strict compiler invocation through
`package.json`/`Makefile`; fix only real script errors; update `test/verify-contract.test.ts`.
(B) create `test/support/integration-test.ts` and `test/integration-timeout.test.ts`; replace
the self-grepping timeout test with this helper, which always supplies the 30-second bound.
(C) remove only `__setDumpTempNameForTest`, `__setDumpTempRemoveSyncForTest`, `__setServiceDisposeForTest`, and `__setDirectorySyncForTest` from `src/pipeline/backup.ts`, plus `__getEphemeralRegistrySizeForTest`, `__getEphemeralRegistryPathsForTest`, and `__runEphemeralCleanupForTest` from `src/util/libpq-service.ts`. Dedupe `SAFE_INTERNAL_RESULT` in `src/mcp/server.ts` with `INTERNAL_EXECUTION_RESULT` in `src/mcp/tools/registry.ts` in its own invariant-reviewed commit.

- [ ] Observe strict-script RED, helper RED, and named unused-export inventory before edits.
- [ ] After each unit run `bun run typecheck && bun test test/verify-contract.test.ts test/integration-timeout.test.ts test/backup.test.ts test/h3-libpq-service.test.ts test/m2.tools.test.ts test/test-database-isolation.test.ts`; never relax strictness/include lists. Universal gates follow.

**Acceptance:** all scripts compile; timeout coverage is behavioral; no unproved deletion.

### Task 5: Repair Live Evaluation Evidence, Then Measure

**Files:** Modify `scripts/eval-search.ts`, `scripts/eval-precisionmembench.ts`, `scripts/eval-pmb-report.ts`, `scripts/eval-pmb.sh`, `src/search/eval.ts`, `test/m9.eval.test.ts`, `test/eval-database-isolation.test.ts`, and `Makefile`; create `fixtures/qrels/live-protocol.json`, `fixtures/qrels/live-baseline.ndjson`, `fixtures/qrels/pmb-live-baseline.json`, `test/eval-live-contract.test.ts`, and `test/eval-pmb-report.test.ts`.

- [ ] RED proves current whole-report median selection, unsorted N=3 labels, missing seeds,
  mock/live baseline mixing, and non-comparable fallback acceptance.
- [ ] Pin `live-protocol.json` to schema v1, live N=3, ordered seeds `[2654435769,2654435770,2654435771]`, and per-metric min/median/max v1. Canonical `run_hash` covers invocation UUID/time, exact seeds/results, full provider/reranker/engine/arm config, sorted qrels/corpus inventory, `evaluator_hash`, and `evaluated_code_hash`; separate `evidence_hash` omits UUID/time/scorecard path.
- [ ] `comparison_key` covers protocol/config/corpus plus SHA-256 `evaluator_hash` of scoring, parsing, aggregation, and report code, excluding evaluated search code; `evaluated_code_hash` covers only ranking/runtime inputs and excludes docs, scorecards, baselines, and ratchet state. `ablation_key` omits only declared arm knobs. Changed keys are non-comparable and cannot silently establish a baseline.
- [ ] Seed legacy metrics from `docs/benchmarks/2026-06-12-live-qwen3-minimebench.md`: retrieval-en hit1/hit3 .94/.97; retrieval-zh .98/1; graph .867/accuracy 1; identity .875/1; time 1/1; provenance .90/.90; robustness accuracy 1. Seed PMB mean precision .523 from `docs/benchmarks/2026-06-12-live-rerank-precisionmembench.md`. Record source commits and reconstruct only verifiable comparison fields; never invent a historical `run_hash`. Missing metadata makes the legacy delta nonbinding and blocks Task 6 until the owner accepts a current truthful N=3 run as the new baseline.
- [ ] Comparable live mode diffs only against the same `comparison_key`. Local fallback is
  diagnostic-only and cannot update the binding baseline.
- [ ] PMB reports mirror evaluator/evaluated-code/evidence/comparison hashes over parser/aggregation/report code, ranking code, sorted dataset/config, provider/model, and results. `--check` owns exit 0 pass, 1 loss >.03, 2 missing/non-comparable; RED evaluator/evidence-only changes. Owner runs `make eval-search-live ROUND=live-2026-08` and, with `PMB_DIR`, `make eval-pmb ROUND=live-2026-08`; any >.03 loss blocks Task 6.
- [ ] Focused GREEN is `bun test test/m9.eval.test.ts test/eval-database-isolation.test.ts test/eval-live-contract.test.ts test/eval-pmb-report.test.ts`; Sol then runs the universal gates and independently validates owner receipts.

**Acceptance:** dated scorecards contain truthful N=3 evidence and automated live deltas.

### Task 6: Gate Honesty and Search-Boost Verdict

**Files:** Use immutable product targets `PLAN_BARS` plus seed floors in `fixtures/qrels/baseline.ndjson`; create `fixtures/qrels/ratchet-state.json` and `test/eval-ratchet.test.ts`; execute amended S5 Task 2. Bars and regression floors remain distinct.

- [ ] Show floor-versus-bar gaps and mock-blind cross-lingual annotations. Routine
  `make eval-search` writes no tracked scorecard; live/release commands do.
- [ ] Mock-only `--ratchet` holds an owner-only exclusive lock, CASes the prior-state hash, and atomically replaces one fsynced floors/key/streak state; a second writer exits busy. Key/schema/corpus change fails closed. Owner-only `make eval-ratchet-reseed` consumes a mode-0600 FD receipt binding prior-state/new-key/committed-seed hashes, candidate SHA, and approval, then initializes floors only from that seed; bars never change. Two improved distinct-code runs promote bounded floors; tolerance applies once, never to latency.
- [ ] RED concurrent writers, evaluator-only changes, evidence-only commits, repeated evidence/code, broken continuity, changed key/schema/corpus, downward proposal, and every atomic-write interruption; prior state remains valid, fixed bars never change, and a broken ranking seam fails `make verify`.
- [ ] Run four boost arms under the same `ablation_key` in deterministic mock and comparable live modes. Retain a multiplier
  only when mock is deterministic and live gains at least 0.01 hit@1 with no area losing over
  0.03 hit@3. A comparable live miss neutralizes it. Unavailable/non-comparable live records no verdict, leaves defaults/subsystem row unchanged, and BLOCKS Task 6 acceptance and Task 7; mock alone never retains it.
- [ ] Focused GREEN is `bun test test/eval-ratchet.test.ts test/eval-live-contract.test.ts test/m9.eval.test.ts`; then run the universal gates and exact live ablation receipt.

**Acceptance:** comparable live evidence yields a committed retained/neutralized verdict and dated `docs/SUBSYSTEMS.md`; otherwise this task remains blocked.

### Task 7: Accelerate Honest Restore — S3 Tasks 1–4

**Source/files:** Apply `docs/superpowers/plans/2026-07-30-s3-recovery-integrity.md` Tasks 1–4. Also modify `src/pipeline/backup.ts`, `scripts/run-backup-worker.ts`, `scripts/restore-drill.sh`, `scripts/restore-pitr.sh`, and `test/h3-restore-scripts.test.ts`; create `scripts/restore-row-count-gate.ts` and `test/restore-row-counts.test.ts`. Never run the destructive M1 suite against `minime_drill`.

- [ ] RED planted replay/ledger/trigger/corrupt-pack/omitted-row-or-table/live-fallback, table-set, marker, concurrency, and every durability seam. In a barriered E2E, update/commit the planted row after export but before `pg_dump` starts/reads it; restore must show the exported value and exact inventory/counts.
- [ ] Under one lock run `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, export the snapshot, and keep it open through sorted inventory/count of every non-system, non-extension-owned ordinary/partitioned table and credential-safe `pg_dump --snapshot="$SNAPSHOT_ID"`; never print the ID. Manifest binds exhaustive schema-qualified set/counts; backup/pre-migration restore reject duplicate, missing, or extra tables.
- [ ] Publish mode-0600 `minime.sql`/manifest inside mode-0700 `generations/g-<32hex>`: fsync files+directory, atomically rename it, fsync parent, then atomically write/fsync `minime.current.json` `{version,generation_id,manifest_sha256,dump_sha256}` and dump-root. Every interruption preserves the previous valid pair.
- [ ] Restic tags bind generation/manifest/dump hashes; restore requires tags, marker, directory, manifest, and dump to match before gates. After restic success retain current+previous plaintext generations, delete only validated older paths, then fsync canonical `generations/` before success. Removal/fsync refusal is fixed `cleanup_failed`; a post-delete/pre-fsync fault must never report success or lose the valid pair.
- [ ] Run `bun test test/backup.test.ts test/h3-restore-scripts.test.ts test/restore-row-counts.test.ts`, `bash -n scripts/*.sh`, then `MINIME_RESTORE_E2E=1 bun test test/restore-integration.test.ts` against fictional data; universal gates follow.

**Acceptance:** genuine restic round trip is green; every planted corruption is red; live DB
is untouched.

### Task 8: Execute S2 Runtime Lifecycle

**Source/interfaces:** `docs/superpowers/plans/2026-07-30-s2-runtime-lifecycle.md` lines 41–444 incorporates `RuntimeLease`, `tryAcquireRuntimeLease`, `withRuntimeLease`, `startBrainWatcher`, `startDaemon`, `startMcpServer`, and four CLI commands. RED/focused: `bun test test/runtime-lease.test.ts test/runtime-daemon.test.ts test/brain-watcher.test.ts test/cli-runtime.test.ts test/product-runtime-contract.test.ts`; then two-process integration, `make verify-offline`, and `make verify`. Acceptance: two MCP clients plus one daemon yield one watcher/dream/backup owner and clean takeover.

### Task 9: Execute S4 and Add Recoverable Multi-Entity Filing

Execute S4 Tasks 1–6 first, then reserve migration 026. Before any non-scratch apply, the owner must create and verify a Task-7 pre-026 generation receipt bound to the exact code SHA; failure stops.

**Source:** `docs/superpowers/plans/2026-07-30-s4-core-workflows.md` lines 59–1678 incorporates its exact interfaces, RED commands, rollback repair, and acceptance gate before the delta below.

**Task-7 files:** create `db/migrations/026_inbox_filing_segments.sql`, `scripts/create-migration-preimage.ts`, `test/migration-preimage.test.ts`, `scripts/repairs/reconcile-inbox-filing-segments.ts`, and `test/inbox-multi-entity.test.ts`; modify `src/db/migration-context.ts`, `src/cli.ts`, `scripts/update.sh`, `scripts/install.sh`, `Makefile`, `src/pipeline/classify.ts`, `src/pipeline/inbox-filing.ts`, `src/pipeline/watcher.ts`, `src/db/repo.ts`, `src/mcp/tools/review-queue.ts`, `src/util/event-payload.ts`, `test/inbox-rollback.test.ts`, `.github/workflows/eval.yml`, `.github/workflows/install.yml`, and `docs/known-issues/classifier-multi-entity-captures.md`.

- [ ] Owner-only `make migration-preimage-026` stops writers, verifies restic, and atomically writes mode-0600 `db-dump/migration-preimage-026.json` with version, target identity hash, migration name, exact pre-026 ledger hash, generation/manifest/dump/restic hashes, Task-7 backup-contract SHA, rollback `TASK_PREDECESSOR_SHA`, creation time, and approval; print fixed output only.
- [ ] Before 026's first SQL, direct/update contexts verify the receipt; update creates it in its pre-migrate backup. Missing/stale/mismatch or writers fail fixed. A fresh install may use only a same-process empty-target proof captured before its first migration; otherwise it needs the receipt. Test/allowlisted restore targets are explicit exemptions. RED traces proof before mutation/refusal.

- [ ] Classifier input is strict-UTF-8 archive text normalized to NFC/LF. `InboxPlanResultV1` contains source SHA-256, overall confidence, and 1..32 `{ordinal,start_byte,end_byte,confidence,target}` segments; offsets partition the exact canonical UTF-8 byte range, each slice is 1..65,536 bytes, canonical result is ≤262,144 bytes, every confidence is ≥0.70, and `target` is the closed S4 filing union including `drop`.
- [ ] `planInboxCapture({inboxItemId,principal,timeZone?})` CAS-inserts one tier-2 `classifying` header with generation token, input hash, and `invocation_started_at` before its sole classifier call. Result persistence CASes the same token/status and atomically stores result hash plus segments; a stale (>300000 ms), late, invalid, low-confidence, unknown, oversized, or ill-partitioned result is fenced into exactly one tier-2 review and zero derivatives, never a second call. A unique `(plan_id,review_kind)` and stored `review_item_id` make concurrent retries idempotent.
- [ ] `fileInboxPlan({inboxItemId,principal})` reads only persisted slices/targets. Segment states are `planned|filing|filed|dropped`; `drop` is terminal with no pointer, while other targets transactionally store a pointer. A single-item plan has one segment.
- [ ] Migration 026 gives header/segment UUIDs, root FK, generation/result/review fields, ordinal, tier-2 slice/classification, immutable plan hash, states, nullable filed pointer, and I5 fields; unique root and `(inbox_item_id,ordinal)`, tier-2 RLS/grants, and reader inventory. Provenance is root `inbox` → plan `inbox_plan` → segment `inbox_segment` → derivative `inbox_segment`; all new rows use actor `created_by`, reused entities retain provenance.
- [ ] Lock each segment `FOR UPDATE`; insert derivative and filed pointer in one transaction. Add partial unique `derived_from` indexes for `source='inbox_segment'` on tasks, journal_entries, interactions, decisions, and pages; retry heals indexing/secondary effects without duplicate same-kind rows.
- [ ] Parent finishes when all segments are filed/dropped; all-drop rejects the root, otherwise legacy singular fields identify the primary derivative and the actor-unlocked review tool exposes the set.
- [ ] The stopped-daemon sanctioned forward repair finalizes valid all-terminal plans (all-drop rejected; otherwise filed with primary), sends invalid/partial/stale plans to one tier-2 review plus rejected, retains all rows, and audits counts/IDs only; the current multi-aware binary resumes. A pre-026 binary on an applied-026 ledger must fail `schema_not_current`: no in-place code downgrade is claimed. Rollback requires a separately approved full restore of the verified pre-026 Task-7 generation plus its exact code SHA.
- [ ] RED/GREEN crash/late-CAS/concurrency/caps/boundaries/drop/mixed-kind/locked/forward-repair cases, full stop→repair→current-start, pre-026 startup refusal, and receipt gate. Focused: `bun test test/migration-preimage.test.ts test/inbox-multi-entity.test.ts test/inbox-rollback.test.ts test/inbox-filing-service.test.ts test/inbox-review-workflow.test.ts`.
- [ ] Add timeout/concurrency to `.github/workflows/eval.yml` and `install.yml`, plus one Linux pull-request install leg; PR
  runs `verify-offline`, while main runs the full `verify` gate.

**Acceptance:** one-to-many state is durable and reviewable; the known issue closes.

### Task 10: Finish Recovery with Manifest-Gated Manual Promotion

**Source/files:** Execute S3 Task 5 and Task 11 ledgers. Create `src/util/promotion-state.ts`, `scripts/promotion-state.ts`, `test/promotion-state.test.ts`, `docs/operations/manual-promotion-recovery.md`, and `test/promotion-recovery-runbook.test.ts`; modify `scripts/promote-restore.sh`, `Makefile`, and `test/h3-restore-scripts.test.ts`.

- [ ] Safely read/write canonical mode-0600 `db-dump/promotion-state.json`: reject symlink/owner/mode/schema/identity faults. V1 binds phase, DB names/OIDs, ledger, time, and mode-0600 `promotion-artifacts/<dump_sha256>.sql`; atomically publish without overwrite, fsync dump and artifact directory, then fsync/atomically publish manifest and its directory. Archives bind it forever; later promotion cannot replace evidence.
- [ ] `make promote-restore EXPECT=none+L1R1B0` first obtains the admin lock, rejects active connections, validates names/OIDs and restore schema/structure, completes the pre-promote dump, then durably writes `prepared`; any dump/manifest/validation/connection/signal failure precedes rename and retains assets.
- [ ] A pure action validator takes `{verb,expect}`; every rename is one `ON_ERROR_STOP=1` call, under the admin lock and zero-connection gate for the affected named database, followed by OID/catalog recheck and durable phase write. Full success and permitted crash seams are:

| Exact expect | Command / mutation | Success | Permitted seam |
|---|---|---|---|
| `none+L1R1B0` | `promote-restore`; validate/dump/write only | `prepared+L1R1B0` | `none+L1R1B0` + retained dump |
| `prepared+L1R1B0` | `forward`; gate L, L→B | `live_renamed+L0R1B1` | `prepared+L0R1B1` |
| `prepared+L0R1B1` | `forward`; verify OIDs/record only | `live_renamed+L0R1B1` | none |
| `live_renamed+L0R1B1` | `forward`; re-gate R/schema, R→L | `promoted+L1R0B1` | `live_renamed+L1R0B1` |
| `live_renamed+L1R0B1` | `forward`; verify OIDs/record only | `promoted+L1R0B1` | none |
| `live_renamed+L0R1B1` | `rollback`; phase only | `rollback_live_renamed+L0R1B1` | none |
| `promoted+L1R0B1` | `rollback`; gate L, L→R | `rollback_live_renamed+L0R1B1` | `promoted+L0R1B1` |
| `promoted+L0R1B1` | `rollback`; verify OIDs/record only | `rollback_live_renamed+L0R1B1` | none |
| `rollback_live_renamed+L0R1B1` | `rollback`; gate B, B→L, archive | `none+L1R1B0` | `rollback_live_renamed+L1R1B0` |
| `rollback_live_renamed+L1R1B0` | `rollback`; verify/archive only | `none+L1R1B0` | none |
| `prepared+L1R1B0` | `rollback`; cancel/archive only | `none+L1R1B0` | none |

- [ ] `forward`/`rollback` mean `make promote-restore-{forward|rollback} EXPECT=<exact-row>`. Exit is fixed: 0 success, 2 invalid/evidence, 3 active connection, 4 operation failure. Status is read-only/content-free; every unlisted combination refuses.
- [ ] Before clearing active state, copy exact manifest bytes to validated mode-0700 `db-dump/promotion-history/<manifest_sha256>.json` as mode 0600 using exclusive temp, fsync, atomic rename, and directory fsync; exact duplicate retry is idempotent, mismatch fails, active removal happens last, archives are never treated as active, and the bound dump remains. Test every archive/remove crash seam.
- [ ] Exact `make promote-restore-accept EXPECT=promoted+L1R0B1` revalidates manifest, dump, OIDs, ledger, and schema and returns a fixed receipt; it does not drop the rollback database or recovery files. This plan provides no finalize/drop action: an active accepted manifest blocks another promotion until a separate owner-approved cleanup design, and any finalize request fails closed.
- [ ] No-manifest `L1R0B0` is normal and `L1R1B0` is preparable; any `B1` without the exact valid manifest is invalid. Table-drive every action/evidence/catalog pair, affected-DB connection gate, before/after rename/phase/archive seam, dump/signal/schema failure, invalid manifest, and orphan state; production has no fault hook. Update/backup receipts fail closed; weekly local-restic CI needs no secret/network.
- [ ] Run `bun test test/update.test.ts test/update-bootstrap.test.ts test/backup.test.ts test/h3-restore-scripts.test.ts test/promotion-state.test.ts test/promotion-recovery-runbook.test.ts test/recovery-workflow-contract.test.ts`, `MINIME_RESTORE_E2E=1 bun test test/restore-integration.test.ts`, then `make verify`.
- [ ] Amend S3/index acceptance: its automatic resume/finalize Tasks 6–10 are superseded; only the minimal manifest and manual one-edge protocol above are in scope. Never claim automatic resume or WAL PITR.

**Acceptance:** backup/update is honest; no rename can precede durable recovery evidence; every partial state has a tested, owner-invoked next edge or fails closed.

### Task 11: Establish the Current Contract and Final Gate

Execute Task 1 of `docs/superpowers/plans/2026-07-30-s5-system-governance.md` only after Tasks 8–10 prove behavior: create `docs/SYSTEM-CONTRACT.md`, PR
template, and drift test; correct CLAUDE/AGENTS/README/GUIDE and mark the v1 plan historical.

The replacement for S5 Task 4 is bounded to existing `check-subsystems`, MCP-reader, strict-script, restore, contract-drift, and truth-day evidence. Run `bun install --frozen-lockfile`, `make verify-offline`, `make verify`, restore E2E, `bash -n scripts/*.sh`, and `git diff --check`; then re-fetch. If `origin/main` differs from Task 1's receipt, stop for a new audit and record the new `PUBLIC_TIP`; recompute all history/range/object scopes and owner-rerun discovery/scan/clearance. Any hit/edit takes a sanitized correction branch and repeats every gate/scan. Freeze the clear SHA, run Luna/invariant/Sol reviews, assert no tree/object/receipt mutation, and rerun the read-only verifier; only then is final `publication_clear=true`.

**Acceptance:** one truthful normative contract and one green release gate, no repo split; if `main` still equals `3e04033b732efd0ff914819180e2ba1cb1a1658b`, fast-forward it to exact binding-reviewed integration, otherwise stop for owner review.

### Task 12: Resume Product Work

**Custody ledger:** modified `docs/superpowers/specs/2026-07-28-w5-a-acquisition-archive-design.md`; untracked `docs/superpowers/plans/2026-07-29-w5-a-acquisition-publication.md`, `2026-07-29-w5-a-child-supervisor.md`, `2026-07-29-w5-a-dispatch-w3.md`, `2026-07-29-w5-a-index.md`, `2026-07-29-w5-a-manifest.md`, `2026-07-29-w5-a-recovery-backup-privacy.md`, and `2026-07-29-w5-a-roots-admission-cli.md` in that same plans directory.

With owner approval, require W5 SHA `49f3158e4783cfaeacaea3619ae4877375fbc33c` and exactly that ledger, rerun Task 1's scanner there, make one local preservation commit, record `W5_PRESERVE_SHA`, and tag `archive/w5-ingest-parsing-20260801`; never push it. Verify with `git diff --name-status 49f3158e4783cfaeacaea3619ae4877375fbc33c "$W5_PRESERVE_SHA"` plus the tag. Recovery: `git worktree add --detach <ABS_REPO_PATH>/.claude/worktrees/w5-ingest-parsing-recovery archive/w5-ingest-parsing-20260801`; stop if it exists. Never rebase/cherry-pick old implementation.

Create fresh post-gate W5, W6, then W9 branches and binding child plans against current main. W7/W8 remain parked until their own before/after live evidence and owner rebuild window are approved. No feature code starts without the owner's separate post-plan start instruction.

## Universal Stop Conditions

Stop on partial owner approval; changed custody; private output; protected-path/live-DB
mutation; push attempt; migration collision; non-comparable live eval; >3-point live
regression; fake/restic-less restore green; singular-only multi-entity state; unresolved
Important/Critical; two failed correction cycles; or any W5 code based on `49f3158`.

## Execution Handoff

After owner approval, use subagent-driven execution exactly in task order. Before Task 0,
rerun branch custody and obtain binding Sol review of this exact file. Until then, stop.
