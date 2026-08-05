# S0 Task 7.5 advisory plan review (Luna)

Reviewed the exact Task 7.5 amendment at plan commit
`9685fa2e177c95921d2e6a627972e095b537a462` (tree
`bb481d9da922e0a8e5d9cde52556903c3ba4d5d6`).  This is an advisory first-pass review of the
plan, decision entry, progress ledger, and the saved independent Sol failure artifact; it is
not a binding Sol verdict and does not authorize completion.

## Spec and quality verdict

**Spec: PASS.** The amendment is a narrow review-gate correction for the exact authoritative
failure.  It does not waive the failed gate or alter the product redaction contract: the plan
labels Task 7.5 as non-production (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2027-2032`),
identifies the exact failed assertion and UUID collision (`:2034-2045`), and freezes production,
fixtures, harnesses, dependencies, Make, TypeScript, workflow, and all other tests
(`:2056-2061`).

**Quality: FAIL pending the Important finding below.** The root cause is supported by the
independent Sol artifact and the proposed assertion tests the complete planted PAN rather than
an incidental four-digit substring.  However, the amendment does not yet explicitly resolve a
conflicting, named remediation requirement in that artifact, so implementation must remain
blocked until the plan-only correction and fresh binding plan review land.

## Contract, security, scope, and evidence checks

- **Failure classification is exact.** Sol records the candidate/tree, a fresh natural-exit
  `make verify` failure, clean post-failure residue, and the unrelated UUID containing `4111`
  (`.superpowers/sdd/2026-07-30-s0-pipeline-baseline/s0-final-sol-binding-review.md:104-145` and
  `:147-193`).  The plan preserves that failure as RED evidence before editing
  (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2063-2066`).

- **Privacy strength is preserved or improved.** The intended plan change only replaces the ambiguous prefix
  check to the complete planted card `4111 1111 1111 1111`, while retaining the complete IBAN
  and account-number absence checks and existing positive card/IBAN markers
  (`test/m2.tools.test.ts:226-237`; plan `:2056-2059`).  This matches the safe full-PAN
  direction in Sol's diagnosis (`s0-final-sol-binding-review.md:197-207`).  The existing test's
  account contract is the full-value negative assertion; no account-positive assertion exists
  to be silently removed, and the one-change/no-other-test constraint is explicit.

- **The four-path ledger is closed and reviewable.** The only implementation/evidence paths are
  the M2 test, the existing Task 7 report, and the new Task 7.5 brief/report
  (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2047-2054`).  The exact same
  four-entry scope is required again at the immutable-commit check (`:2068-2070`); production
  redaction and all protected paths are explicitly frozen (`:2059-2061`, `:2075-2079`).

- **TDD and gate evidence are sufficient.** The sequence requires the saved RED, one semantic
  assertion correction, at least 20 fail-fast fresh-process redaction runs, a complete M2 run,
  and a pre-commit `make verify` (`:2063-2067`).  It then requires an exact-immutable-commit
  `make verify`, residue/posture/scope proof, and fresh Luna plus independent Sol reviews at the
  same SHA (`:2068-2073`).  These are two authoritative full gates, not a retry substitution.
  The acceptance evidence can be recorded in the named brief/report; the prior Task 7 report
  should be updated append-only so its original RED and binding failure remain auditable.

- **Failure behavior and stop conditions are fail-closed.** The plan stops on loss of the saved
  failure, any complete-card appearance, focused failure, production-path or additional-test
  edits, or a request for broad flake hardening (`:2075-2079`).  Any Critical/Important finding
  reopens the fix/re-review loop, and final closure requires C0/I0/M0 (`:2071-2073`).

- **Decision and progress ledgers agree.** The decision entry records the same UUID collision,
  complete-card replacement, retained IBAN/account negatives and positive markers, and explicit
  rejection of UUID masking/fixed IDs/retries/broad sweeps (`DECISIONS.md:2071-2088`).  The
  progress ledger records the exact failed candidate/tree, focused rerun, clean residue, and
  Task 7.5's frozen scope (`.superpowers/sdd/2026-07-30-s0-pipeline-baseline/progress.md:418-429`).

- **Marker and deterministic-coverage conflict.** The saved Sol artifact labels its UUID
  collision/all-three-marker request as part of the “required remediation plan”
  (`s0-final-sol-binding-review.md:195-214`), while Task 7.5 limits implementation to one
  semantic assertion and explicitly forbids any other test change (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2056-2061`).
  The baseline test has positive card/IBAN markers and a full account-number negative
  (`test/m2.tools.test.ts:230-237`), not a separate account-positive assertion.  The plan must
  explicitly supersede the stray all-three-marker/forced-UUID request, with the rationale that
  existing UUID-preservation coverage plus the captured raw UUID proves the collision and that
  a complete-PAN assertion is immune to a four-digit UUID substring.  Until that supersession is
  recorded in the plan/decision evidence, the prior binding remediation remains open.

## Findings

### Critical

None.  No Critical finding is being closed or downgraded here.

### Important

1. **The amendment does not explicitly supersede the prior Sol remediation requirement.**
   `s0-final-sol-binding-review.md:208-211` requests deterministic coverage with a legal UUID
   containing `4111` and all three marker values, but the Task 7.5 plan authorizes only one
   assertion change and no other test (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2056-2061`).
   This is an unresolved contract conflict, not a reason to add production or broad test scope;
   add an explicit plan/DECISIONS supersession and its evidence-based rationale before
   implementation.

### Minor

1. **The 20-run evidence command is underspecified.** Step 3 says only “run the redaction case in
   at least 20 fail-fast fresh processes” (`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2063-2066`).
   Sol's required command and acceptance list name the wrapper-owned mocked invocation and the
   expected recorded result (`s0-final-sol-binding-review.md:215-237`).  Add that exact command,
   fail-fast loop, per-run count, and result to the report/update path so process freshness,
   disposable DB ownership, and no-provider behavior are auditable.

## Advisory implementation authorization

**Not authorized for implementation yet.** First record the explicit supersession for the
Important conflict and add the exact 20-process command/results requirement, then obtain the
independent Sol binding plan review at the resulting exact plan SHA.  If that binding review
passes, an executor may make only the one complete-card assertion change and the three named
evidence updates, then must satisfy every fresh-process, full-gate, residue, scope, and joint
re-review condition above.  This advisory report is not a binding final verdict and does not
close Sol's existing Important finding.

**Advisory result: FAIL pending correction — Critical 0 / Important 1 / Minor 1.**
