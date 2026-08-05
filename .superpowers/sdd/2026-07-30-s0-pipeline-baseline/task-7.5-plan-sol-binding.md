# S0 Task 7.5 binding plan review (Sol, independent)

## Binding identity and verdict

- Plan path: `docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md`
- Amendment: Task 7.5, “Stabilize the redaction assertion exposed by the binding gate”
- Exact `PLAN_SHA`: `9685fa2e177c95921d2e6a627972e095b537a462`
- Exact tree: `bb481d9da922e0a8e5d9cde52556903c3ba4d5d6`
- Parent implementation candidate:
  `a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`
- Reviewed plan-only range:
  `a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf..9685fa2e177c95921d2e6a627972e095b537a462`

**Binding verdict: FAIL.**

- Spec: **FAIL**
- Quality: **FAIL**
- Findings: **Critical 0 / Important 1 / Minor 0**
- Luna executor may implement from this plan SHA: **NO**

The root cause, privacy boundary, one-assertion implementation scope, evidence paths, two full
gates, same-SHA reviews, and stop conditions are substantively correct. The plan nevertheless
omits the exact fail-fast command and expected result for its load-bearing 20-fresh-process gate.
That omission can hide an early failing process and does not satisfy the repository's established
fresh-process evidence contract.

No implementation or acceptance command was run for this plan review.

## Material reviewed

I independently reviewed:

- Task 7.5 at exact `PLAN_SHA`;
- the exact plan-only diff and path list;
- `DECISIONS.md`, including the new exact-card decision;
- the complete SDD progress ledger and Task 7 chronology;
- the committed exact-a79 Sol failure artifact;
- the current `test/m2.tools.test.ts` assertion;
- the unchanged UUID-preserving behavior in `src/mcp/redact.ts`;
- the earlier fresh-process/fail-fast contract in the same S0 plan.

`git diff --check` over the plan-only range is clean. The range contains only:

```text
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/progress.md
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/s0-final-sol-binding-review.md
DECISIONS.md
docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md
```

There is no implementation, package, lock, Make, workflow, fixture, harness, product source,
migration, data, settings, or backup change in the plan-only commit.

## Bound root cause

The exact a79 gate failure is correctly identified:

```text
test/m2.tools.test.ts:232
expect(raw).not.toContain("4111")
```

The output had correctly replaced the planted values with `[REDACTED:card]`,
`[REDACTED:iban]`, and `[REDACTED:account]`. A separate result ID,
`40f475e9-7ebe-450c-a22b-fdb294111fcd`, legitimately contained the four-character substring
`4111`. UUID preservation is intentional product behavior: `src/mcp/redact.ts` protects canonical
UUIDs from account/card redaction so returned IDs remain reusable through the one-door API.

Therefore:

- this is a nondeterministic test false positive, not evidence of privacy egress;
- changing product redaction or UUID preservation would be incorrect;
- changing fixtures, fixing generated IDs, retrying the gate, or broad flake hardening would add
  unnecessary scope;
- the complete planted PAN, not a four-digit fragment, is the secret the test must forbid.

## Scope assessment

The proposed implementation authorization is minimal and safe:

1. Modify only `test/m2.tools.test.ts`, replacing:

```text
expect(raw).not.toContain("4111");
```

with:

```text
expect(raw).not.toContain("4111 1111 1111 1111");
```

2. Update/create only the three named SDD evidence files:

```text
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7-report.md
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7.5-redaction-flake-brief.md
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7.5-redaction-flake-report.md
```

3. Retain without weakening:

```text
expect(raw).not.toContain("DE89370400440532013000");
expect(raw).not.toContain("123456789012");
expect(raw).toContain("[REDACTED:card]");
expect(raw).toContain("[REDACTED:iban]");
```

The complete planted card remains forbidden. The full IBAN and account values remain forbidden.
Both existing positive marker assertions remain mandatory. The single assertion substitution
keeps the assertion count unchanged.

The plan correctly freezes:

- `src/mcp/redact.ts` and all other product code;
- UUID handling and seed/fixture behavior;
- `test/setup.ts`, `test/support/test-database.ts`, and every other harness/test;
- `package.json`, `bun.lock`, `tsconfig.json`;
- `Makefile` and `.github/workflows/eval.yml`;
- migrations, data, settings, backups, and unrelated worktrees/files.

This is narrower and safer than the deterministic fixed-UUID fixture suggested as an option in
the failure review. The recorded failing response already proves the collision. A fixed fixture
would edit additional test setup or data solely to recreate a logically established string
collision; it is unnecessary when the implementation is an exact literal substitution and is
followed by repeated fresh processes plus two authoritative gates.

## DECISIONS.md and spec §0.3

Spec §0.3 requires every deviation to be recorded in `DECISIONS.md` with its reasoning. The new
entry does that: it records the exact failure, the one-assertion decision, why a four-digit
fragment is unsound, retained privacy assertions, rejected alternatives, and unchanged pinned
stack/search/redaction behavior.

Its approval line is also honest:

```text
agent-proposed under the owner-approved S0 execution scope; pending owner ratification
```

Spec §0.3 requires recording; it does not say every recorded decision must await separate human
ratification before a previously approved implementation train continues. Pending ratification is
therefore not a plan blocker, but no downstream report may describe this entry as separately
human-ratified unless the owner actually does so.

## Finding

### Important — the 20-process gate is prose-only and does not bind fail-fast shell behavior

Path: `docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md:2063-2066`.

The plan says:

```text
Run the redaction case in at least 20 fail-fast fresh processes
```

but supplies no exact command, test-name filter, shell status policy, or expected per-process
result. This is load-bearing for three reasons:

1. A plain shell loop returns the status of its last command. Without `set -e`, failures in runs
   1-19 can be hidden by run 20.
2. “The redaction case” is ambiguous between the one named case, the complete M2 file, and a
   wrapper-nested invocation.
3. The same S0 plan already records and corrects this exact class of defect for the M15
   fresh-process gate: an unguarded loop was rejected because an early failure could be hidden,
   and the accepted form uses an isolated `set -e` subshell.

The plan-writing contract requires exact commands and expected failures/results. Describing
“fail-fast” semantically is not enough to make the evidence reproducible or reviewable.

## Required plan-only correction

Replace the prose-only Step 3 with an exact command block equivalent to:

```bash
(
  set -e
  for run in {1..20}
  do
    bun test test/m2.tools.test.ts \
      --test-name-pattern \
      'redaction: card numbers, IBANs, long account numbers never leave the server'
  done
)
bun test test/m2.tools.test.ts
/usr/bin/time -p make verify
```

Bind the expected result:

- exactly 20 independent Bun processes;
- the named redaction case passes once in every process (`20/20`, zero failure);
- shell exits immediately on the first nonzero process;
- every process receives its normal `bunfig.toml` preload and therefore a fresh guarded database;
- the complete M2 file passes `12/0` with its exact expectation count recorded;
- the first full `make verify` exits 0 and records exact test/skip/fail/expect counts and duration.

Keep Step 4's single implementation commit. Then make Step 5's second gate equally explicit:

```bash
git rev-parse HEAD
/usr/bin/time -p make verify
git diff --check
git status --short
```

The second gate must run at the recorded immutable candidate SHA, exit 0, and record the same
complete Biome, TypeScript 5.9.3, subsystem, MinimeBench, database/source/process/provider residue,
role-posture, dependency, and scope evidence. The two full gates must be separate natural-exit
commands; neither is replaceable by a retry of a failed gate.

The corrected plan must continue to require:

- fresh Luna xhigh implementation review and independent Sol xhigh binding final review at the
  same exact candidate SHA/tree;
- Critical 0 / Important 0 / Minor 0 for closure;
- stop on any full-secret, IBAN, account, or positive-marker weakening;
- stop on any product redaction, UUID, fixture, harness, package, Make, workflow, or extra-test
  drift;
- stop on any focused/full gate failure, competing gate process, database/source/provider/process
  residue, or broader flake sweep.

After the plan-only correction, record the new exact SHA/tree and obtain fresh Luna advisory and
independent Sol binding plan reviews. The current `PLAN_SHA` must not authorize implementation.

## Stop disposition

The plan's own condition applies: implementation must stop when binding plan review does not PASS.
No executor may modify `test/m2.tools.test.ts` from
`9685fa2e177c95921d2e6a627972e095b537a462`.

Final result: **Spec FAIL / Quality FAIL / C0-I1-M0 / implementation NOT AUTHORIZED**.
