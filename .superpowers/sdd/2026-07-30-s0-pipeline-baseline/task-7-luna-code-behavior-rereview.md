# S0 Task 7 advisory re-review (Luna)

This is an advisory re-review only; it is not a binding Sol verdict.

## Scope and candidate

- Base: `5b52239ed60c58e02dc296724159fc2f221f20f5`.
- Exact candidate reviewed: `a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf` (`docs: correct Task 7 evidence chronology`).
- The full Task 7 range remains limited to the nine approved paths shown by `git diff --name-status`.
- The full candidate range contains only the nine approved paths. The `a59919a..a79be39` delta is
  exactly one report-line correction; runtime/config/test trees are identical to `a59919a`. No
  application source, migrations, database harness, install/update script, settings, data, backup,
  workflow, or `tsconfig.json` changes were introduced.

## Independent evidence

I independently ran `make verify` to natural completion at the immediately preceding runtime-equivalent
candidate `a59919a`; the exact `a59919a..a79be39` delta is report-only, so this gate evidence applies
unchanged to `a79be39`. It exited 0 with:

```text
1086 pass
1 skip
0 fail
9823 expect() calls
Ran 1087 tests across 52 files. [199.34s]
Biome: Checked 164 files; no fixes applied.
TypeScript: passed.
SUBSYSTEMS: ok.
MinimeBench mock: OK: all bars held, no regression.
```

The generated scorecard was removed after capture because it is outside Task 7's approved Touches
paths. `make verify` follows the intended dependency graph (`Makefile:128-132`) and the M0/eval
recipes place `scripts/with-test-database.ts` before their child commands (`Makefile:69-71,150-153`).

Additional independent checks passed:

- `bun test test/verify-contract.test.ts`: `7 pass`, `0 fail`, `42 expect()` across 7 tests.
- Controlled, non-persistent direct-child mutation of both Make recipes produced
  `current_order=pass controlled_direct-child_mutation=red`; the current wrapper/order assertions are
  therefore meaningful rather than count-only (`test/verify-contract.test.ts:60-82`).
- `bun install --frozen-lockfile` made no changes; `bun run typecheck`, pinned TypeScript 5.9.3,
  and `bunx biome check .` all passed. The only dependency delta is exact `typescript: 5.9.3`
  (`package.json:24-29`, `bun.lock`).
- Protected-path diff against the base was empty (`src`, `scripts`, `db/migrations`, `data`, env
  files, workflow, and `tsconfig.json`). `git diff --check` was clean.
- Post-gate process scan found no wrapper, test, eval, restore, or M0 child process. PostgreSQL
  reported role posture `minime|f|t|t`, zero generated `minime_test_*` databases, zero generated
  test connections, and zero source-template activity. No established Ollama provider connection
  remained.

## Prior finding closure

The prior Important wrapper-order finding is addressed. The focused contract now asserts exact
wrapper text and wrapper-before-child ordering for both offline M0 and retrieval evaluation
(`test/verify-contract.test.ts:60-82`), while the Make recipes remain correctly wrapped
(`Makefile:69-71,150-153`). The prior RED-result transposition is also corrected in the report
(`task-7-report.md:20-22`).

## Findings

### Critical

None found in this re-review. No Critical finding is being closed or adjudicated here.

### Important

None found. The authoritative gate, CI posture, dependency pin, static checks, wrapper isolation,
and failure/residue evidence are coherent at the reviewed candidate.

### Minor

None found. The historical GREEN count is now correctly restored to `41` in the execution report
(`task-7-report.md:24-30`); the post-review-fix focused GREEN remains correctly documented as `42`
(`task-7-report.md:48-54`).

## Advisory assessment

- Spec: **PASS (advisory)** — the implemented verification behavior and scoped remediation satisfy
  the Task 7 contract.
- Quality: **PASS** — runtime, tests, scope, and evidence are coherent at this candidate.
- Ready: **YES (advisory)**. This assessment is non-binding; independent Sol review remains
  required by the review protocol.

Severity counts: Critical **0**, Important **0**, Minor **0**.
