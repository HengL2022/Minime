# S0 Task 7.5 implementation review (Luna)

Reviewed immutable implementation candidate `d74768b4b7b366406ab9f140029cd987fd3fb3e6`
(tree `1df0f98c861b520b4b9b7e61a0ce77c8906ed95f`) in
`<ABS_REPO_PATH>/.claude/worktrees/stabilize-pipeline-baseline`.  Reviewed range:
`58d203d8a15dcc5bf713c6fff7a800d586a474c0..d74768b4b7b366406ab9f140029cd987fd3fb3e6`.
This is an advisory first-pass implementation review, not a binding Sol verdict; no candidate
file or commit was changed by this review.

## Spec, quality, and readiness

**Spec: PASS for the implementation scope and behavior.** The exact range contains only the four
authorized paths: `test/m2.tools.test.ts`, the append-only Task 7 report, and the new Task 7.5
brief/report (`git diff --name-status`; plan
`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2047-2061`).  The code delta is one
literal assertion replacement at `test/m2.tools.test.ts:232`; the full IBAN/account negatives and
positive card/IBAN markers at `:233-236` are unchanged.  No `src/`, fixture, harness, package,
lockfile, Make, TypeScript, workflow, migration, data, settings, or backup path changed.

**Quality: FAIL pending the Important evidence finding below.** The implementation itself is
correct and the independent runtime gates pass, but the named execution report does not contain
the required immutable-candidate gate and final residue evidence.  The executor's handoff claim
is not a substitute for the saved report artifact.

**Ready: NO.** A report-only correction and fresh exact-HEAD rereview are required before binding
closure.  No production or test implementation expansion is authorized.

## Independent evidence

### Scope and privacy

- `git diff --check` is clean.
- The exact assertion is now `expect(raw).not.toContain("4111 1111 1111 1111")`
  (`test/m2.tools.test.ts:226-237`).  The planted full PAN, full IBAN, and full account values
  remain forbidden; positive `[REDACTED:card]` and `[REDACTED:iban]` markers remain required.
- The exact implementation range is four paths only.  Protected/product-path inventory for
  `src/`, `fixtures/`, `scripts/`, `Makefile`, package/lock files, `tsconfig`, and workflows is
  empty.  The broader `a79be39..d747` delta contains only Task 7.5 plan/evidence records plus
  this test, so the prior product/runtime scope is unchanged.

### Independent focused privacy check

```text
MINIME_MOCK_OLLAMA=1 bun test test/m2.tools.test.ts \
  --test-name-pattern 'redaction: card numbers, IBANs, long account numbers never leave the server'

1 pass
11 filtered out
0 fail
5 expect() calls
Ran 1 test across 1 file. [873.00ms]
```

### Independent natural-exit full gate

```text
/usr/bin/time -p make verify

1086 pass
1 skip
0 fail
9823 expect() calls
Ran 1087 tests across 52 files. [204.22s]
Biome: no fixes
TypeScript: pass
SUBSYSTEMS: ok
MinimeBench: OK: all bars held, no regression
real 209.12
```

The gate exited naturally at the exact immutable candidate.  The generated MinimeBench scorecard
was removed after capture because it is outside the authorized paths.

### Immediate residue and posture checks

Using the committed `.env.engineering` SELECT-only DSN (`make psql-ro` contract), immediately
after the gate and focused check:

```text
generated minime_test_* databases: 0
active generated minime_test_* connections: 0
active minime source-template sessions: 0
established Ollama TCP connections: 0
minime role: f|t|t
minime_engineer_ro role: f|f|f
```

The four pre-existing `minime_eval_*` databases remain the reviewed LongMemEval/evaluation
fixtures, not generated test residue.  No Bun test/wrapper/eval/restore child remained.  Git
status contains only the pre-existing unrelated `.superpowers/s0-template-*` files; no generated
scorecard or other candidate residue remains.

## Important finding

### The named Task 7.5 execution report omits the immutable gate and final residue evidence

**Severity: Important.** The plan requires the post-commit exact-candidate sequence and proof of
database/source/process/provider residue (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2093-2105`).
The Task 7.5 report explicitly promises to append, in order, the immutable-HEAD `make verify` and
final residue/scope/provider/dependency/role checks (`.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7.5-redaction-flake-report.md:33-37`),
but the committed report ends after pre-commit results at `:39-49`.  The appended Task 7 report
section likewise records only pre-commit results (`.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7-report.md:149-180`).

The independent gate and residue checks above demonstrate that the candidate currently behaves
correctly, but the acceptance evidence is not saved in the authorized report path.  Append the
exact immutable-HEAD command/output, SHA/tree, residue/posture/scope/dependency/provider checks,
and scorecard cleanup to the named Task 7.5 report (preserving the existing RED/pre-commit
chronology), then obtain fresh Luna and independent Sol reviews at the resulting exact candidate
SHA.  Do not modify implementation code or broaden the path ledger.

## Findings

### Critical

None.  No Critical finding is being closed or downgraded by this advisory review.

### Important

1. The required immutable-gate and final-residue evidence is absent from the committed named
   execution report as described above.

### Minor

None.

## Advisory disposition

**Spec PASS / Quality FAIL / Ready NO — Critical 0 / Important 1 / Minor 0.** The one-test
implementation is privacy-correct and all independent runtime/residue checks pass, but binding
closure remains blocked until the report-only evidence correction and exact-HEAD rereviews.
This is not a binding final verdict.
