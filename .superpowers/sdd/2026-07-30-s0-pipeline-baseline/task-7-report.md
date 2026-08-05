# Task 7 execution report — authoritative local and CI gate

Plan: `docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md`, Task 7
BASE: `5b52239ed60c58e02dc296724159fc2f221f20f5`
Worktree: `<ABS_REPO_PATH>/.claude/worktrees/stabilize-pipeline-baseline`
Commit message: `ci: make full offline verification authoritative`

Review-fix commit message: `test: bind verification wrapper ordering`

## TDD evidence

The approved red test was written first at `test/verify-contract.test.ts`.

Command:

```text
bun test test/verify-contract.test.ts
```

RED result: `2 pass, 5 fail, 14 expect()` across 7 tests. The failures demonstrated the
missing exact TypeScript/package contracts, missing Make format/typecheck/offline contracts,
the old milestone fan-out in `verify`, and missing documentation alignment.

After the minimal implementation and test-format correction:

```text
bun test test/verify-contract.test.ts
```

GREEN result: `7 pass, 0 fail, 41 expect()` across 7 tests.

## Review-fix TDD evidence

The wrapper-order assertions were added before the mutation check. The original Makefile hash
was recorded as:

```text
5a3aa6213cd8afa11488c1cd58671b7bb19266c475c6bfead88b81100bd92f82  Makefile
```

Only the two approved wrapper recipes were temporarily bypassed with `apply_patch`: the
offline M0 recipe ran `src/verify/m0.ts` directly, and `eval-search` ran
`scripts/eval-search.ts` directly. The focused test then produced the deterministic mutation
RED: `5 pass, 2 fail, 35 expect()`; the two failures were the explicit wrapper-presence/order
contracts. The exact Makefile was restored with `apply_patch`; its hash returned to the value
above and `git diff -- Makefile` was empty.

After restoration, the focused GREEN was:

```text
7 pass
0 fail
42 expect() calls
Ran 7 tests across 1 file. [350.00ms]
```

The contracts now require the exact wrapper command text and verify wrapper-before-child order
for both `verify-m0-offline` → `src/verify/m0.ts` and `eval-search` → `scripts/eval-search.ts`.

## Implementation

- Added exact dev dependency `typescript: 5.9.3`; no other dependency was added or changed.
- Added authoritative `lint`, `format`, and `typecheck` package scripts; lint is
  non-mutating (`biome check .`).
- Added Make `format`, `typecheck`, and `verify-offline` targets.
- Made `verify-offline` the fast gate (`verify-m0-offline test lint typecheck check-subsystems`).
- Made `verify` the final gate (`verify-offline eval-search`).
- Added the approved documentation wording in `CLAUDE.md`, `AGENTS.md`, and `README.md`.
- `.github/workflows/eval.yml` already matched the one authoritative `make verify` gate and
  reviewed service-admin/bootstrap plus `minime` `f|t|t` child posture, so it was unchanged.

## Acceptance commands

```text
bun install --frozen-lockfile
```

Result: `Checked 290 installs across 202 packages (no changes) [30.00ms]`.

```text
bun run typecheck
bunx tsc --version
bunx --package typescript@5.9.3 tsc --noEmit --pretty false
```

Results: typecheck passed; `Version 5.9.3`; pinned invocation passed.

```text
bunx biome check .
```

Result: `Checked 164 files in 94ms. No fixes applied.` A before/after diff-numstat check
was identical, proving the lint command did not mutate files.

```text
make verify-offline
```

Result: `1086 pass`, `1 skip`, `0 fail`, `9822 expect() calls`, `Ran 1087 tests across 52
files. [203.57s]`; Biome passed with no fixes; TypeScript passed; `SUBSYSTEMS: ok`;
`real 207.40` seconds. The generated MinimeBench scorecard was removed after capture because
it is outside the approved Touches paths.

```text
make verify
```

Result: `1086 pass`, `1 skip`, `0 fail`, `9822 expect() calls`, `Ran 1087 tests across 52
files. [201.55s]`; Biome passed with no fixes; TypeScript passed; `SUBSYSTEMS: ok`;
MinimeBench mock reported `OK: all bars held, no regression`; `real 206.77` seconds.

```text
git diff --check
```

Result: clean (no output).

Review-fix pre-commit `make verify` also passed: `1086 pass`, `1 skip`, `0 fail`, `9823
expect() calls`, `Ran 1087 tests across 52 files. [204.89s]`; Biome, TypeScript, and
subsystems passed; MinimeBench reported `OK: all bars held, no regression`; total `real
209.87` seconds. Its generated scorecard was removed because it is outside the approved
Touches paths.

## Contract and residue checks

- `make -n verify-offline`: exactly one unscoped `bun test`, mocked wrapper-owned `verify_m0`,
  `scripts/check-subsystems.ts`, and no milestone prerequisites, `createdb`, `minime_test`, or
  `minime_eval` paths.
- `make -n verify`: offline gate plus wrapped mock `scripts/eval-search.ts`; no milestone
  prerequisites or legacy/shared database paths.
- `package.json` and `bun.lock` dependency delta is only exact TypeScript 5.9.3 (script changes
  are the approved package contract).
- `tsconfig.json` remains strict, retains `noUncheckedIndexedAccess`, and includes exactly
  `src`, `test`, and `fixtures`.
- Post-gate process scan found no Bun test, wrapper, restore, or fixture processes.
- Post-gate PostgreSQL scan found zero generated `minime_test_*` databases and zero active
  generated-test connections.
- Role posture remained `minime | f | t | t`.
- No source-template activity/residue was found.
- An Ollama listener was already present on loopback during the checks; no established provider
  connection was present after either gate, and all offline provider paths reported mocked mode.

## Scope

Only the authorized files were changed/created. The unrelated untracked
`.superpowers/s0-template-*` files were preserved untouched. No application source, migration,
database harness, install/update script, settings, data, or backup path was modified.

The final commit SHA is reported in the execution handoff after the single commit command.

## Task 7.5 redaction-flake amendment

The exact saved a79 binding RED was preserved before editing. At candidate
`a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`, natural `/usr/bin/time -p make verify` exited with:

```text
1085 pass
1 skip
1 fail
9819 expect() calls
Ran 1087 tests across 52 files. [203.30s]
```

The failure was `test/m2.tools.test.ts:232`, `expect(raw).not.toContain("4111")`; the raw
response had correctly redacted the planted card, IBAN, and account, while the unrelated legal
UUID `40f475e9-7ebe-450c-a22b-fdb294111fcd` contained the four-digit substring `4111`.

Task 7.5 is authorized from corrected plan SHA `58d203d8a15dcc5bf713c6fff7a800d586a474c0`.
Its sole semantic implementation change is the complete-PAN negative assertion in
`test/m2.tools.test.ts`; the full IBAN/account negatives and existing card/IBAN positive markers
remain unchanged. Evidence paths are the Task 7.5 brief/report and this append-only report.

Task 7.5 pre-commit evidence: frozen install checked `290 installs across 202 packages` with
no changes; the exact named redaction case passed in `20/20` independent Bun processes, each
reporting `1 pass`, `11 filtered out`, `0 fail`, and `5 expect() calls`; complete M2 passed
`12 pass`, `0 fail`, `67 expect() calls`. Natural pre-commit `make verify` passed with `1086
pass`, `1 skip`, `0 fail`, `9823 expect() calls`, `Ran 1087 tests across 52 files. [202.94s]`,
Biome no-fix, TypeScript, subsystem, and MinimeBench bars green, and `real 208.04` seconds.
The generated benchmark scorecard was removed because it is outside the approved paths.

Task 7.5 immutable-candidate evidence: commit `d74768b4b7b366406ab9f140029cd987fd3fb3e6`,
tree `1df0f98c861b520b4b9b7e61a0ce77c8906ed95f`. The separate natural `/usr/bin/time -p make
verify` at that exact HEAD passed with `1086 pass`, `1 skip`, `0 fail`, `9823 expect() calls`,
`Ran 1087 tests across 52 files. [202.00s]`, and `real 207.09` seconds; Biome no-fix,
TypeScript 5.9.3, `SUBSYSTEMS: ok`, and MinimeBench all passed. Post-gate checks found zero
Bun test/wrapper/restore/fixture processes, zero generated test databases/connections, zero
source-template activity, no established provider connection, roles `minime | f | t | t` and
`minime_engineer_ro | f | f | f`, an empty dependency diff, and exactly the four authorized
committed paths; unrelated `.superpowers/s0-template-*` files were preserved.
