# Task 7 brief — authoritative local and CI gate

Plan: `docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md`, Task 7.

- BASE: `5b52239ed60c58e02dc296724159fc2f221f20f5`
- Worktree: `<ABS_REPO_PATH>/.claude/worktrees/stabilize-pipeline-baseline`
- Branch: `codex/stabilize-pipeline-baseline`
- Task 5/6/6.5/6.75/R2 prerequisite: joint binding PASS and closure-only commit recorded.

## Authorized paths

- Create `test/verify-contract.test.ts`
- Modify `package.json`
- Modify `bun.lock`
- Modify `tsconfig.json`
- Modify `Makefile`
- Modify `.github/workflows/eval.yml`
- Modify `CLAUDE.md`
- Modify `AGENTS.md`
- Modify `README.md`
- Create/update this brief and
  `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7-report.md`

Do not modify application source, migrations, database harness behavior, install/update
scripts, environment/settings/data/backup paths, other plans, or the unrelated untracked
`.superpowers/s0-template-*` files.

## TDD contract

1. Write `test/verify-contract.test.ts` first and run it RED. The RED must demonstrate the
   current scoped milestone prerequisites, mutating lint, and missing TypeScript gate.
2. Apply the exact approved contracts:
   - package scripts: `test=bun test`, `lint=biome check .`,
     `format=biome check --write .`, `typecheck=tsc --noEmit`;
   - exact dev dependency `typescript: 5.9.3`, with no other dependency change;
   - `tsconfig.json` remains strict with `noUncheckedIndexedAccess` and includes only
     `src`, `test`, and `fixtures`;
   - Make targets `format`, `typecheck`, `verify-m0-offline`, and `verify-offline`;
   - `verify-offline: verify-m0-offline test lint typecheck check-subsystems`;
   - `verify: verify-offline eval-search`.
3. The dry-run regression must prove exactly one unscoped `bun test`; no scoped milestone
   prerequisite; wrapper-owned `verify_m0` before `src/verify/m0.ts`; mock mode for offline
   M0; standalone live-capable `verify-m0`; non-mutating `biome check .`; `tsc --noEmit`;
   `scripts/check-subsystems.ts`; wrapped `scripts/eval-search.ts`; and no
   `createdb`, shared `minime_test`, or legacy `minime_eval` path.
4. Align `.github/workflows/eval.yml` to one `make verify` gate while preserving the sole
   reviewed service-admin template bootstrap and the `minime` `f|t|t` child posture.
5. Align `CLAUDE.md`, `AGENTS.md`, and `README.md`: `verify-offline` is the fast offline
   merge gate and `verify` is the final retrieval-inclusive gate.

Use `bun add --dev --exact typescript@5.9.3`, then verify the frozen install. Do not weaken
compiler settings or add any dependency other than exact TypeScript 5.9.3.

## Acceptance

Run serially and let every command exit naturally:

```text
bun test test/verify-contract.test.ts
bun install --frozen-lockfile
make verify-offline
make verify
git diff --check
```

Also prove lint is non-mutating, the manifest/lock delta is TypeScript-only, exact TypeScript
5.9.3 is active, no provider socket opens during `verify-offline`, no guarded database or
source-template activity remains, no test/wrapper/fixture process remains, and the changed
paths are exactly authorized.

Commit once with exact message:

```text
ci: make full offline verification authoritative
```

Report the RED, focused GREEN, full gate counts/durations, dependency diff, residue checks,
exact commit SHA, and any deviations. Stop immediately on a protected-path edit, provider
egress, dependency drift, shared/legacy database path, compiler weakening, or unresolved
Critical/Important finding.
