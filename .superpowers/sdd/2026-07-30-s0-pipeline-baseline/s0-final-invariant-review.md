# S0 final invariant review (Luna)

Advisory invariant review only; this is not a binding Sol verdict.

## Identity, scope, and method

- Implementation lineage reviewed: `1867bf38196a9e411acf93927586552c554c0c4c..a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`.
- Exact HEAD: `a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`.
- The `a59919a..a79be39` delta is one ignored Task 7 report-line correction only; the runtime,
  configuration, test, package, workflow, and scripts tree is identical to the independently
  gate-tested `a59919a` candidate.
- Reviewed the S0 plan, `minime-build-plan.md` invariants/privacy/working conventions, `AGENTS.md`,
  `CLAUDE.md`, `DECISIONS.md`, all recorded S0 reports/binding artifacts, and the exact lineage diff.
- Existing unrelated `.superpowers/s0-template-*` files were preserved. No candidate files were
  mutated by this review.

## Independent evidence

Targeted invariant/privacy/role and failure-boundary gates were run serially at exact HEAD:

```text
bun test test/test-database-isolation.test.ts
71 pass, 0 fail, 404 expect()

bun test test/eval-database-isolation.test.ts
19 pass, 0 fail, 200 expect()

bun test test/m1.schema.test.ts
16 pass, 0 fail, 107 expect()

bun test test/m15.roles.test.ts
23 pass, 0 fail, 105 expect()

bun test test/migration-context.test.ts test/update-bootstrap.test.ts
42 pass, 0 fail, 84 expect()

bun test test/h3-data-root.test.ts test/h3-libpq-service.test.ts test/h3-restore-scripts.test.ts
164 pass, 0 fail, 3857 expect() [133.96s]

bun test test/privacy-hardening.test.ts test/m6.leak.test.ts test/m13.provider-routing.test.ts
32 pass, 0 fail, 1012 expect()

bun test test/m14.extract-validate.test.ts
10 pass, 0 fail, 53 expect()

bun test test/backup.test.ts
9 pass, 0 fail, 23 expect()

bun test test/verify-contract.test.ts
7 pass, 0 fail, 42 expect()
```

Also passed: `bunx --package typescript@5.9.3 tsc --noEmit --pretty false`, `bunx biome check .`
(`Checked 164 files ... No fixes applied`), `bash -n scripts/install.sh scripts/update.sh
scripts/eval-pmb.sh`, and `git diff --check` over the complete lineage.

The fresh full runtime gate was independently run at `a59919a` and is applicable unchanged to
`a79be39` because the intervening delta is report-only: `1086 pass`, `1 skip`, `0 fail`, `9823
expect()`, 1087 tests across 52 files; Biome, TypeScript, subsystem, and MinimeBench bars all passed.
The final postchecks reported `minime|f|t|t`, source-template owner `minime` with no sessions,
zero generated `minime_test_*` databases, zero source/generated activity, no attributable test,
wrapper, eval, restore, or M0 process, and no established Ollama connection.

`make -n verify-offline` and `make -n verify` show mocked M0 and retrieval evaluation wrapped by
`scripts/with-test-database.ts`, with the wrapper before each child and no scoped milestone fan-out.
The full static searches found no runtime `createdb`, extension creation, shared `minime_test`, or
legacy `minime_eval*` path in covered targets. The only matches are the explicit reviewed CI
bootstrap (`.github/workflows/eval.yml:33-50`) and the preserved LongMemEval exception
(`Makefile:155-161`), which the plan explicitly exempts while its destructive-caller assertion
passes (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:870,2168-2183`; executable
assertion `test/eval-database-isolation.test.ts:619-656`).

## Invariant assessment

| Invariant | Assessment and evidence |
|---|---|
| **I1 Local-first** | **PASS.** Offline M0 and eval recipes force `MINIME_MOCK_OLLAMA=1` and use unique loopback scratch DBs (`Makefile:69-71,150-153`); the full gate had no provider connection. Provider routing fails closed above the cloud ceiling and local tier routes produce zero egress (`test/m13.provider-routing.test.ts:52-80,105-129`; 32-test gate above). No cloud DB/SaaS/telemetry path was added by S0. |
| **I2 One door** | **PASS.** Runtime agents still use the MCP path; the only engineering exception remains the SELECT-only, RLS-gated role. Generated children receive only a parent-owned URL/approved alias (`scripts/with-test-database.ts:125-137,223-236`), never a brand or disposal authority; inherited external test URLs are rejected before planning (`:175-188`, covered by isolation/eval tests). |
| **I3 Tiered egress** | **PASS.** The 200-call locked leak suite proves no tier-0/tier-2 content escapes and every call is audited; privacy hardening covers fanouts, graph edges, queue payloads, actor-scoped unlocks, and tier-0 prose. RLS role tests deny tier-0 table reads and all engineering writes (`test/m15.roles.test.ts:81-140`), while provider tests prove tier-0 content reaches neither provider nor egress audit. |
| **I4 Archive/index/state split** | **PASS.** Canonical repository/data and dump roots remain stable from foreign cwd/symlink contexts, and backup/restore artifacts stay private (`test/h3-data-root.test.ts:67-146`; 164-test H3 gate). The protected `.env*`, `data/`, `db-dump/`, `backups/`, and settings diff is empty. |
| **I5 Provenance** | **PASS.** No S0 change bypasses row provenance. M1 schema round-trip checks every substantive table for provenance; the S0 changes are gate/harness/bootstrap changes only, with no row-writing product path altered. |
| **I6 Numbers via SQL only** | **PASS.** No metric/query arithmetic path changed. The 200-call leak suite includes injection-shaped metric names and confirms the aggregate-only path remains the sole tier-0 door; schema metric definitions remain whitelisted and tested. |
| **I7 Honest answers** | **PASS.** No MCP envelope, source-ID, timestamp, staleness, or gap contract changed in the S0 lineage. Full suite and targeted privacy gates remain green. |
| **I8 Append-only audit** | **PASS.** Events update/delete/truncate are rejected and lossless IDs/dispositions remain covered (`test/m1.schema.test.ts:250-275`); the leak suite confirms every locked tool call is audited. Decision transcripts retain their append-only trigger (`test/m1.schema.test.ts:153-168`). |

## Boundary and security checks

- **Migration context and repair boundary: PASS.** Context parsing, target matrix, pre-schema refusal,
  sorted ledger comparison, and idempotent migration behavior pass (`src/db/migration-context.ts:58-81,84-117,123-212`; 42-test migration/update gate). Repair tests prove committed-script enforcement, mandatory pre-image, fixed/content-free failures, IDs/counts-only audit payloads, and no repair when backup fails (`test/m15.roles.test.ts:216-340`).
- **Generated DB/source-template isolation: PASS.** The 71 isolation tests cover guarded names,
  reserved-session cloning, source-idle checks, collision/clone/extension rollback, foreign-client
  fencing, bounded ordinary drop, signal/nonzero/bootstrap cleanup, alias/source sentinels, and
  environment restoration. The 19 eval tests exercise real child identity/extensions, source-template
  invariance, simultaneous distinct targets, and CI/static wrapper coverage.
- **Fixed content-free errors: PASS.** Clone, cleanup, collision, external, parser, migration,
  updater, restore, and repair paths map to fixed codes; the H3/update/repair and real wrapper tests
  assert no URLs, credentials, source names, child output, SQL/server detail, or row contents escape.
- **CI admin exemption and child posture: PASS.** The sole CI admin bootstrap is explicit and
  step-scoped (`.github/workflows/eval.yml:33-50`), creates only `minime` and the `minime_test`
  template, installs `vector`/`pgcrypto`, asserts `f|t|t`, and then `make verify` runs as `minime`.
  The eval workflow test confirms credentials/source creation do not appear in later steps
  (`test/eval-database-isolation.test.ts:733-775`).
- **No protected data/settings change: PASS.** The lineage protected diff is empty; post-gate DB,
  process, source-template, and provider-residue checks are clean.

## Findings

### Critical

None found. No Critical finding is being closed, downgraded, or adjudicated by this advisory review.

### Important

None found.

### Minor

None found. LongMemEval's direct `createdb`/`minime_eval_lme1` recipe is the explicit preserved
plan exemption, not an implementation violation.

## Advisory disposition

- Invariants I1–I8: **PASS**.
- Scope/privacy/egress/failure behavior: **PASS**.
- Findings: Critical **0**, Important **0**, Minor **0**.
- Ready for independent binding review: **YES (advisory)**.

This remains non-binding; the required independent Sol final review of exact HEAD is still pending.
