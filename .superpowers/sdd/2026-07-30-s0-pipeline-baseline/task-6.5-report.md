# Task 6.5 report: bound H3 subprocess integration timeout

Status: implementation complete; Task 6 and Task 6.5 remain pending the mandated joint Luna/Sol review and closure-only ledger commit.

## Binding identity and preserved RED

- `TASK65_PLAN_SHA`: `4520380f9f41a8507982d7783668f3155013a020`
- Task 6 checkpoint: `3c3f196e71d3eec977a3d7c451da85f6282e78be`
- Pre-amendment H3 SHA-256: `5df9177b9572b0c2838500c80499fd0fdeca8ccf54eab24bfd748fc584626efe`
- Preserved authoritative RED (`<TEMP_DIR>/minime_authoritative_bun_test_r2.txt`):

  ```text
  bun test
  1016 pass
  1 skip
  31 fail
  9568 expect() calls
  Ran 1048 tests across 51 files. [471.76s]
  ```

  All 31 failures were in the unchanged H3 file and each was exactly Bun's `timed out after 5000ms`; standalone pre-amendment H3 evidence was 126 pass / 0 fail / 3682 assertions. No replacement RED was run or manufactured.

## Approved implementation

Only `test/h3-restore-scripts.test.ts` changed. The exact file-local interface is:

```ts
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

const H3_SUBPROCESS_INTEGRATION_TIMEOUT_MS = 30_000;
setDefaultTimeout(H3_SUBPROCESS_INTEGRATION_TIMEOUT_MS);
```

There are no retries, repeats, CLI/global timeout changes, assertion or fixture changes, production/script/config/package/Make/workflow/preload edits, or concurrency changes.

## Required GREEN gates

```text
bun test test/h3-restore-scripts.test.ts
126 pass
0 fail
3682 expect() calls
Ran 126 tests across 1 file. [144.88s]

bun test test/test-database-isolation.test.ts test/eval-database-isolation.test.ts
58 pass
0 fail
390 expect() calls
Ran 58 tests across 2 files. [5.54s]

bun test test/eval-database-isolation.test.ts
16 pass
0 fail
130 expect() calls
Ran 16 tests across 1 file. [5.20s]

bun test
1047 pass
1 skip
0 fail
9568 expect() calls
Ran 1048 tests across 51 files. [217.90s]

bunx biome check test/h3-restore-scripts.test.ts test/eval-database-isolation.test.ts
Checked 2 files in 40ms. No fixes applied.

git diff --check
pass
```

No H3 case exceeded the new 30,000 ms bound. The unscoped run had no non-H3 failures.

## Scope and history proofs

After this commit, `git diff --name-only "$TASK65_PLAN_SHA"..HEAD` is expected to contain only:

```text
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-6.5-report.md
test/h3-restore-scripts.test.ts
```

The protected-path proof is empty:

```text
git diff "$TASK65_PLAN_SHA"..HEAD -- \
  bunfig.toml package.json bun.lock Makefile .github/workflows/eval.yml src scripts db/migrations
```

The separate checkpoint-to-candidate history proof is retained for joint review with the broader Task 6/plan history and is not treated as the Task 6.5 two-path implementation allowlist.

## Residue and safety proof

Using the committed SELECT-only `.env.engineering` role after the raw suite:

```text
guarded_db_count=0
source_template_activity=0
```

No database was recovered or mutated by Task 6.5. No protected `.env*`, `data/`, `db-dump/`, `backups/`, shared, live, legacy, or source-template path was touched. No Bun test, wrapper, or owned-child process remained.

## Commit note

Commit message: `test: bound H3 subprocess integration timeout`.

The final commit SHA is reported in the executor handoff after commit; Tasks 6 and 6.5 require fresh Luna advisory review and independent Sol binding review at that exact candidate before closure.
