### Task 6.5: Bound the H3 subprocess integration harness

Dependency/base: start from the exact clean Task 6 checkpoint
`3c3f196e71d3eec977a3d7c451da85f6282e78be` after the Task 6.5 plan-only amendment
receives fresh Luna advisory and independent Sol binding PASS. Task 6 is a checkpoint, not
an accepted task; Tasks 6 and 6.5 close jointly.

Binding source: read the complete Task 6.5 section, Task 6 checkpoint clause, acceptance,
rollback, and stop conditions in
`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md`. That text is authoritative.

Files:
- Modify: `test/h3-restore-scripts.test.ts`
- Create: `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-6.5-report.md`

You are not alone in the repository. Preserve all other work and untracked review
artifacts; never revert another agent's edits.

Implement only:

~~~ts
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

const H3_SUBPROCESS_INTEGRATION_TIMEOUT_MS = 30_000;
setDefaultTimeout(H3_SUBPROCESS_INTEGRATION_TIMEOUT_MS);
~~~

Place the constant/call after imports and before any test or fixture execution. Do not edit
H3 assertions or fixtures. Do not add retries/repeats, a CLI/global timeout, or modify
shell scripts, production code, `bunfig.toml`, package manifests, Make, workflow, preload,
test concurrency, `.env*`, `data/`, `db-dump/`, or backups.

RED evidence is already captured by the Task 6 checkpoint:

~~~text
bun test
1016 pass, 1 skip, 31 fail, 9568 assertions, 1048 tests, 471.76s
~~~

Every failure is in unchanged `test/h3-restore-scripts.test.ts` and says exactly
`timed out after 5000ms`. The unchanged H3 SHA-256 is
`5df9177b9572b0c2838500c80499fd0fdeca8ccf54eab24bfd748fc584626efe`;
standalone evidence is 126 pass / 0 fail / 3682 assertions. Do not manufacture another RED
or use retries.

Run:

~~~bash
bun test test/h3-restore-scripts.test.ts
bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
bun test test/eval-database-isolation.test.ts
bun test
bunx biome check test/h3-restore-scripts.test.ts test/eval-database-isolation.test.ts
git diff --check
~~~

Capture exact counts. Prove the Task 6.5 implementation range
`TASK65_PLAN_SHA..HEAD` contains only the H3 test file and report, with no diff in
`bunfig.toml`, packages, Make, workflow, `src`, `scripts`, or migrations. Separately list
`TASK6_CHECKPOINT..HEAD` as joint-review history; do not apply the two-path Task 6.5
allowlist to that history range. After the unscoped run, use read-only engineering access
to prove generated guarded database count 0 and source-template activity 0. Do not recover
or mutate a database in Task 6.5.

Write `task-6.5-report.md` with the exact pre-fix RED, H3 hash, implementation interface,
all GREEN results, scope proof, residue proof, and commit note. Commit with exact message:
`test: bound H3 subprocess integration timeout`.

Stop and report if any pre-fix failure is not the exact 5000 ms H3 timeout; any H3 test
exceeds 30 seconds; a new non-H3 failure appears; residue remains; scope expands; or a
protected/live/shared path would be touched. Do not raise the timeout again.
