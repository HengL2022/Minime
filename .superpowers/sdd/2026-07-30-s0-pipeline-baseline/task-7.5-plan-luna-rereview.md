# S0 Task 7.5 corrected-plan advisory rereview (Luna)

Reviewed the corrected Task 7.5 amendment at exact plan commit
`58d203d8a15dcc5bf713c6fff7a800d586a474c0` (tree
`556cd6fc5cc0a71634e6a83a371c4ab496942e06`).  The review covers the delta from
`9685fa2e177c95921d2e6a627972e095b537a462`, the corrected plan, DECISIONS entry, progress
ledger, prior Luna finding, and the independent Sol plan-binding artifact.  This is an advisory
first-pass rereview, not a binding Sol verdict.

## Spec and quality verdict

**Spec: PASS.** The corrected amendment remains a review-gate/test assertion change, not a
production redaction change.  It preserves the exact four-entry implementation/evidence ledger
(`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2027-2061`) and explicitly freezes
production redaction, UUID behavior, fixtures, harnesses, packages, Make, TypeScript, workflow,
and every other test.

**Quality: PASS for the corrected plan.** Both prior plan findings are closed: the prior Sol
artifact's optional fixed/legal-UUID and “all three markers” suggestion is expressly superseded
with a reasoned evidence record, and the 20-process acceptance is now an executable isolated
`set -e` loop with named test, expected counts, and two separate full gates.  No new Critical,
Important, or Minor plan defect was identified.

## Closure checks

- **Important finding — explicit supersession: CLOSED.** The plan now states that it supersedes
  only the historical failure artifact's fixed/legal-UUID and all-three-marker suggestion, and
  explains why existing UUID-preservation coverage, the captured failing UUID, and complete-PAN
  matching are sufficient (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2063-2070`).
  The matching DECISIONS entry records the scope, rejected alternatives, and rationale
  (`DECISIONS.md:2090-2106`).  This is an explicit amendment, not a silent downgrade of the
  prior Sol finding; the prior `task-7.5-plan-sol-binding.md` remains historical evidence for
  the 9685 review.

- **Privacy contract remains strong and exact.** The implementation is still one literal
  assertion substitution from the four-digit prefix to the complete planted PAN, while the full
  IBAN/account negatives and existing positive card/IBAN markers remain mandatory
  (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2056-2061`; baseline
  `test/m2.tools.test.ts:226-237`).  The plan explicitly explains that no account-positive
  integration assertion exists to retain, while unit coverage still proves account redaction and
  UUID preservation (`test/redact.test.ts:10-16`, `:19-47`).  No production code or UUID behavior
  is authorized to change.

- **Minor finding — exact process evidence: CLOSED.** Step 3 now binds the exact command block:
  frozen install, an isolated `set -e` `{1..20}` loop, `MINIME_MOCK_OLLAMA=1`, the exact
  `--test-name-pattern`, a complete M2 run, and a timed pre-commit `make verify`
  (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2072-2092`).  The loop launches
  one fresh Bun process per iteration and exits on the first nonzero result; the expected result
  is explicitly `20/20`, zero failures, and M2 `12/0/67`.  The command is executable under the
  pinned Bun contract (`bun test --help` documents `--test-name-pattern`); `bunfig.toml:1-2`
  preloads `test/setup.ts`, whose per-process guarded database provisioning and cleanup are
  defined at `test/setup.ts:35-136`.

- **Two full authoritative gates are distinct.** The first timed `make verify` is in the
  pre-commit sequence (`:2086-2092`).  Step 5 separately records the immutable candidate SHA
  before a second timed natural-exit `make verify`, followed by diff/status and residue/scope
  proofs (`:2093-2105`).  The plan prohibits replacing the second gate with a retry and requires
  Biome, TypeScript 5.9.3, subsystem, MinimeBench, database/source/process/provider, role,
  dependency, and path evidence.

- **Failure behavior and stop conditions are fail-closed.** The plan stops on an early loop
  failure, competing gate, focused/full failure, residue, production/UUID/fixture/harness/package/
  Make/workflow drift, additional test edits, or broad flake hardening
  (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2110-2115`).  Final closure still
  requires fresh Luna implementation rereview and independent Sol final binding at the same
  candidate SHA with C0/I0/M0 (`:2106-2108`).

- **Report-update path is adequate.** The named Task 7 report plus the new Task 7.5 brief/report
  remain exactly the three evidence files alongside the single M2 test
  (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2047-2054`).  The executor should
  append the Task 7.5 RED/GREEN chronology to the prior report, preserve its original failure
  evidence, and record every loop/gate count and residue check; this is an audit-preserving
  execution condition, not an unresolved plan defect.

- **No new scope or ledger conflict.** The corrected delta changes only the plan, DECISIONS,
  progress, and review artifacts; it contains no implementation, package, lockfile, Make,
  workflow, fixture, harness, product source, migration, data, settings, or backup change.
  Progress records the prior 9685 Luna/Sol findings and the corrected requirements
  (`.superpowers/sdd/2026-07-30-s0-pipeline-baseline/progress.md:430-439`).

## Findings

### Critical

None.  No Critical finding is being closed or downgraded here.

### Important

None.  The prior supersession conflict is explicitly resolved in the plan and DECISIONS entry.

### Minor

None.  The prior exact-command evidence gap is explicitly resolved with an isolated fail-fast
loop, expected per-run/M2 counts, and separate pre-commit/immutable-commit gates.

## Advisory implementation authorization

**Conditionally authorized for the next gate only.** This corrected plan is reviewable for
implementation, but execution may begin only after the independent Sol binding plan review
passes this exact plan SHA/tree.  After that PASS, the executor may make only the one complete-PAN
assertion change and the three named evidence updates, then must satisfy the exact commands,
residue/scope checks, and same-SHA Luna implementation plus Sol final binding reviews.  This is
not a binding final verdict and does not itself close the branch.

**Advisory result: PASS — Critical 0 / Important 0 / Minor 0.**
