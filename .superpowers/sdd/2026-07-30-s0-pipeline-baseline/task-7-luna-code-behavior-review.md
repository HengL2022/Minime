# Task 7 advisory code and behavior review (Luna first pass)

Advisory only: this is not a binding final verdict and does not authorize closure or Task 8.
The exact candidate remains subject to independent Sol adjudication.

## Identity and scope

- Base: `5b52239ed60c58e02dc296724159fc2f221f20f5`
- Reviewed HEAD: `07ae9d60e6e04040b73b174b0f02b3d6bee42caa`
- Task 7 plan: `docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md`
- Reviewed implementation range: `5b52239..07ae9d6`

The exact range contains the Task 7 brief/report, `test/verify-contract.test.ts`, package and
lockfile changes, Make targets, and the three documentation updates. `tsconfig.json` and
`.github/workflows/eval.yml` are unchanged from the approved baseline and were checked against
the Task 7 contract. No application source, migrations, harness scripts, data/settings, or
backup path changed. The unrelated untracked `.superpowers/s0-template-*` artifacts were
preserved.

## Independent gate evidence

I reread the complete Task 7 plan/brief/report and the exact diff, then ran the candidate's
natural gate without overlapping another test process:

```text
make verify
exit 0
unscoped bun test: 1086 pass / 1 skip / 0 fail / 9822 expect()
Ran 1087 tests across 52 files. [205.83s]
biome check .: Checked 164 files; no fixes applied
tsc --noEmit: passed
scripts/check-subsystems.ts: SUBSYSTEMS: ok
MinimeBench mock: OK: all bars held, no regression
```

The generated mock scorecard was removed after capture because it is a gate output outside
the authorized candidate paths. Immediate read-only checks then showed native role
`minime|f|t|t`, zero generated `minime_test_*` databases, zero generated/source-template
activity, no attributable wrapper/child/test/restore process, and no established Ollama
connections. The exact TypeScript checks were independently clean:

```text
bun install --frozen-lockfile: 290 installs / 202 packages, no changes
bun run typecheck: pass
bunx tsc --version: Version 5.9.3
bunx --package typescript@5.9.3 tsc --noEmit --pretty false: pass
bunx biome check .: pass, no fixes
git diff --check: pass
```

The package/lock dependency delta is only exact `typescript: 5.9.3`. The protected diff over
`src`, `scripts`, `db/migrations`, `data`, environment files, `tsconfig.json`, and the CI
workflow is empty.

## Contract alignment and strengths

The package scripts are exact and separate non-mutating lint from formatting
(`package.json:8-13`). Make exposes the requested targets and orders one unscoped suite behind
wrapper-owned offline M0, then lint, strict typecheck, subsystem check, and wrapped retrieval
evaluation (`Makefile:57-71`, `:123-153`). The standalone `verify-m0` remains live-capable
(`Makefile:66-67`), while offline M0 pins mock mode and a generated label (`:69-71`).

The unchanged compiler and workflow satisfy the required strict scope and sole CI gate
(`tsconfig.json:2-13`; `.github/workflows/eval.yml:33-52`). Documentation consistently calls
`verify-offline` the fast merge gate and `verify` the final retrieval-inclusive gate
(`CLAUDE.md:66-79`; `AGENTS.md:180-185`; `README.md:56-67,116-130`). The full gate itself
confirmed the intended behavior, including the retrieval scorecard and all prior suites.

## Findings

### Critical

None (0). No Critical issue was identified; no Critical finding is being downgraded or closed.

### Important

**T7-I1 — the contract test does not prove wrapper ownership or ordering (Important, open).**

The plan and brief require the dry-run regression to prove that offline M0 is wrapper-owned,
that the wrapper appears before `src/verify/m0.ts`, and that retrieval evaluation is wrapped
(`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2004`; `task-7-brief.md:41-45`).
The new contract test only checks token presence and absence of selected strings
(`test/verify-contract.test.ts:60-77`): it never asserts `scripts/with-test-database.ts`,
never checks its position relative to `src/verify/m0.ts` or `scripts/eval-search.ts`, and never
requires the retrieval wrapper. A future regression from
`MINIME_MOCK_OLLAMA=1 bun run scripts/with-test-database.ts ... bun run src/verify/m0.ts` to a
direct child could therefore pass the contract test while losing disposable-database
ownership. The current Make implementation is correct (`Makefile:69-71,150-153`) and the
independent gate passed, but the mandated regression guard is incomplete. Add explicit
presence/order assertions for both wrapper invocations before treating this review as ready.

### Minor

**T7-M1 — the recorded RED count is transposed (Minor, open).**

The report records `5 pass, 2 fail, 14 expect()` for the initial RED
(`.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7-report.md:10-15`). The executor's
contemporaneous RED handoff records `2 pass, 5 fail, 14 expect()` (the failed test setup
short-circuited the remaining assertions); the final GREEN count and all gate counts are
correct. Correct the report's RED line so the evidence is reproducible and internally
consistent.

### LongMemEval cross-check (no candidate finding)

The broad repository scan still finds the pre-existing `eval-longmemeval` `createdb` and
`minime_eval_lme1` recipe (`Makefile:155-161`). This is explicitly exempted by the plan while
its static non-destructive assertion passes (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:870,972-978`); that assertion is clean, and the target is not a prerequisite of
`verify` (`Makefile:128-132`). The broader wording at plan lines 2004 and 2181 is ambiguous
when read globally, but the candidate's covered gate has no legacy path. I therefore record no
implementation finding for this preserved exemption; the plan ambiguity should be clarified
in a future plan-only edit rather than by changing LongMemEval in Task 7.

## Verdict

- Spec alignment: **FAIL pending T7-I1 evidence closure** (the runtime Make/CI contracts are
  correct, but the required dry-run contract does not prove wrapper ownership/order).
- Quality/evidence: **FAIL** (T7-I1 open; T7-M1 is a minor report correction).
- Ready for binding acceptance: **NO** until the Important test-contract gap is remediated and
  the RED count is corrected.

This advisory review does not issue a binding final verdict. The full runtime gate, dependency
delta, residue checks, and LongMemEval exemption evidence are otherwise green.
