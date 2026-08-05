### Task 6.75: make the S0 harnesses strict-typecheck ready

Start only after the exact plan commit containing this brief receives fresh Luna advisory
and independent Sol binding PASS. That exact commit is `TASK675_PLAN_SHA`.

Read the complete Task 6.75 section and global stop conditions in
`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md`, the latest Task 6/6.5 joint
Luna rereview, the Task 5 and Task 6 reports, and the prior binding reviews.

Files:
- Modify: `scripts/with-test-database.ts`
- Modify: `test/eval-database-isolation.test.ts`
- Modify: `test/fixtures/owned-db-child.ts`
- Modify: `test/fixtures/test-db-probe.test.ts`
- Modify: `test/update-bootstrap.test.ts`
- Create:
  `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-6.75-typecheck-readiness-report.md`

You are not alone in the repository. Preserve all other work and untracked review
artifacts. Do not change packages/lock, TypeScript configuration, Make, workflow,
application source, migrations, database policy, privacy/egress behavior, protected
data/settings, or previously frozen ranges.

First preserve the exact 26-diagnostic TypeScript 5.9.3 RED. Strengthen the existing
timeout-contract test so all nine real integration cases must carry the independent
30-second option in Bun's declared third argument; run it RED before moving the options.

Make only the plan's bounded corrections:

- explicitly reject the possibly undefined `--database-env` token before the existing
  wrapper allowlist check;
- narrow the harness-ready child from `ReturnType<typeof runWrapperHarness>`;
- move all nine timeout objects to the declared third argument without changing bodies;
- use the existing default postgres adapter in the two real dependency cases;
- represent the four one-row fixture queries with tuple generics; and
- narrow the updater driver's already-piped result to
  `Bun.SyncSubprocess<"pipe", "pipe">`.

Do not use `any`, broad casts, hiding non-null assertions, suppressions, exclusions, or
compiler weakening. Preserve every output/error contract and runtime behavior.

Run the exact RED/GREEN, focused, full-suite, dry-run, offline-M0, compiler, Biome, shell,
scope, role-posture, residue, source-activity, process, and no-egress gates in the plan.
Verify `package.json`, `bun.lock`, and `tsconfig.json` never change. Record fresh counts in
the dedicated report and commit exact message
`test: make S0 harnesses typecheck-ready`.

Stop instead of expanding scope on any new diagnostic, behavior-bearing fix need, changed
runtime/error contract, weakened compiler graph, package/config/gate change, database
ownership or cleanup change, protected-path touch, provider/network egress, failed gate,
or database/process residue.
