# Task 6 R2 implementation advisory first-pass rereview

Advisory only: this is a fresh Luna first-pass review, not a binding final verdict and
does not close Task 6 or authorize Task 7. Independent Sol adjudication remains required.

## Exact identity and scope

- Plan/spec SHA: `4df61a330264d6dce4a2d751b0f8505000dbb48f`
- Reviewed implementation HEAD: `dc3848fa7f0f0e9e957d0c7f7df883b2017e8161`
- Reviewed range: `4df61a3..dc3848f` (the seven authorized implementation/report paths)
- Remediation delta reread: `cc28dffc5d4a0e98b55c860c018cdb7bf210df84..dc3848fa`

The exact range contains only the Task 6 R2 report, the test database adapter/isolation and
eval tests, the owned-child fixture, test setup, and the M15 role test. The protected-path
check over application source, migrations, scripts, package/lock files, TypeScript config,
Make, and workflow was empty. `git diff --check` passed. Existing unrelated untracked
`.superpowers/s0-template-*` review artifacts were preserved and are outside the range.

## Review coverage and evidence

I reread the Task 6 R2 brief/plan, the prior Task 5/6/6.5/6 I-1/6.75 reports and binding
reviews, the implementation report, and the exact candidate diff. I independently ran:

```text
bun test
1079 pass / 1 skip / 0 fail / 9781 expect() calls
Ran 1080 tests across 51 files. [196.45s]

bunx --package typescript@5.9.3 tsc --noEmit --pretty false
exit 0; no diagnostics

bunx @biomejs/biome@1.9.4 check <six changed TypeScript files>
Checked 6 files; no fixes applied

bash -n scripts/eval-pmb.sh
exit 0
```

The full suite exited naturally. Immediately afterward, the native role posture was
`f|t|t`, guarded generated-database count was `0`, source-template activity count was `0`,
and no attributable owned-child/wrapper/test process remained (the only `ps` matches were
the checking shell and its `rg`). Static safety found no `WITH (FORCE)` or force-drop SQL in
`test/support/test-database.ts` (the adapter uses ordinary drop at lines 451-481).

## Correctness, security, contracts, and failure behavior

The remediation removes the exported `teardown?` capability and keeps the authoritative-admin
brand module-private (`test/support/test-database.ts:79-90`). The shared teardown helper
revalidates the immutable plan and uses the default adapter's authoritative ordinary-drop
cycle; injected test doubles retain only the legacy terminate/drop trace (`:179-200`).
Malformed encoded admin usernames are rejected before factory construction or pool reservation
(`:333-350`), with focused coverage at `test/test-database-isolation.test.ts:1626-1652`.

The default adapter fences the exact guarded target, validates complete PID/role/backend-type
snapshots, blocks every foreign/hidden/unknown/mixed row, terminates only positively classified
same-role clients, and retries ordinary drop only through the bounded fresh-cycle loop
(`test/support/test-database.ts:362-482`). Successful drop is the only disposed transition;
pre-drop failures leave the branded handle retryable, while post-drop close failure preserves
disposed state and exposes only the fixed cleanup error (`:582-603`). The isolation tests cover
the private capability, blocker reclassification, 20-cycle/19-delay bound, PID changes,
termination/drop protocol failures, SQLSTATE 55006, rollback provenance, and close precedence
(`test/test-database-isolation.test.ts:330-430`, `:782-1615`).

The test-owned pool closer registry uses distinct records, snapshot drain, `Promise.allSettled`,
shared drain promises, and fixed late-registration failure (`test/setup.ts:17-59`); M15 registers
its memoized read-only pool closer immediately after construction (`test/m15.roles.test.ts:38-56`).
Signal, normal, bootstrap, and retained-handle cleanup paths receive the singleton drain
(`test/setup.ts:127-207`). The full suite and the frozen focused gates provide evidence for
these paths without provider-capable eval/egress execution.

## Frozen neighboring gates

The reviewed ledger/reports retain these prior passes: Task 5 updater bridge PASS (including
its independent Sol closure), Task 6 PASS after the I-1 evidence closure, Task 6.5 PASS, and
Task 6.75/typecheck readiness PASS. Their prior evidence was not substituted for the fresh
R2 suite/typecheck/residue checks above.

## Findings

### Critical

0. No Critical finding was identified; therefore no Critical finding is being downgraded or
closed in this advisory review.

### Important

0. The earlier first-pass Important concern (an exported/custom teardown capability bypassing
the private ordinary-drop helper) is absent at the reviewed HEAD: the interface no longer
exports it and the remediation test asserts the runtime property is ignored
(`test/support/test-database.ts:79-90,179-200`; `test/test-database-isolation.test.ts:330-372`).

### Minor

0. The earlier malformed-username pool-leak concern is absent at the reviewed HEAD because
URL decoding now precedes `factory()`/`reserve()` and has a fixed-error regression test
(`test/support/test-database.ts:333-350`; `test/test-database-isolation.test.ts:1626-1652`).

## Advisory disposition

**Advisory first-pass rereview: PASS — Spec PASS, Quality PASS, Critical 0 / Important 0 /
Minor 0.**

This is not the binding final verdict. Task 5 updater bridge PASS, Task 6 PASS, Task 6.5 PASS,
Task 6.75/typecheck readiness PASS, and combined acceptance PASS are the expected final labels
for the independent binding review; Task 7 remains pending until that binding review and the
closure-only ledger/artifact step.
