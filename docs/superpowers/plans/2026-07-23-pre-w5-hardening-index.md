# Pre-W5 Hardening Tranche Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five owner-approved integrity gaps in the fixed H2 → H3 → H1 → H4 → H5 order before any W5 design or implementation begins.

**Architecture:** The final index and five plans are first committed as one immutable plan
package, binding-reviewed by exact `PLAN_BASE_SHA`, and used as the execution baseline. Each
hardening item then lands on its own sequential branch, is fast-forwarded by exact reviewed
SHA into `codex/pre-w5-hardening`, and produces independently working, testable software.
Every branch starts from the preceding reviewed SHA, receives advisory Luna and binding Sol
review, and passes the complete project gate before the next branch is cut.

**Tech Stack:** TypeScript on Bun, PostgreSQL 16 + pgvector, raw parameterized SQL in `src/db/repo.ts`, Bash 3.2-compatible bootstrap/restore scripts, locked `@modelcontextprotocol/sdk` 1.29.0 under the committed `^1.12.0` package range using public interfaces only, `bun test`, Biome, restic, Ollama.

## Global Constraints

- Preserve I1 local-first, I2 one door, I3 tiered egress, I4 files/archive + rows/state + database/index, I5 provenance, I6 SQL-only numbers, I7 honest envelopes, and I8 append-only audit.
- No remote or LAN Ollama mode; remote inference uses only explicit cloud providers.
- No distributed transaction across PostgreSQL, files, and model calls.
- No automatic repair or deletion of graph entities or edges.
- No W5 parser registry, binary originals store, image/VLM work, review-queue redesign, ranking redesign, or access-boost redesign.
- Runtime dependencies stay within the pinned stack; no new external network dependency or ORM.
- Plain SQL strings remain only in `src/db/repo.ts`, migrations, and `metric_defs.agg_sql`; all values are parameterized.
- Tests remain fully offline, use fictional fixtures, and never log, print, or snapshot tier-0 row contents.
- Existing untracked agent configuration and benchmark files are preserved.
- Plan/review scratch belongs only in the active ignored `.claude/worktrees/<branch>`
  worktree or an OS temporary directory. Never place scratch in the owner's existing
  `.superpowers/`, `.codex/`, or `.agents/` trees.
- Briefs, ledgers, review packets, captured diffs, and gate logs follow the same rule: keep
  them in the active ignored worktree or a fresh OS temporary directory outside the repository;
  never write them into owner `.superpowers/`, `.codex/`, `.agents/`, `data/`, or `db-dump/`.
- Do not edit `.gitignore`; `.claude/worktrees/` is already ignored and every execution
  worktree path is pinned below.
- Use only the existing pinned `.claude/worktrees/<branch>` locations in the table. Assert
  `git check-ignore -q` for each relative path before use; if a location needs creation,
  create it at that exact path with `git worktree add` and never choose a sibling or add an
  ignore rule.
- `bun install` always uses `--frozen-lockfile`; `package.json` and `bun.lock` must be
  byte-identical before and after install and every branch.
- No migration or live repair script is required by this tranche.
- Historical `DECISIONS.md` entries are append-only; each branch appends only its own decision.
- No branch claims documentation or behavior belonging to a later branch.
- Two consecutive failed review/gate cycles in one area stop the tranche for owner review.
- A `final_reviewer_sol` BLOCK is binding for that cycle and cannot be waived by the primary session, Luna, or the Critical adjudicator.

---

## File and responsibility map

| Plan | Branch | Pinned ignored worktree | Responsibility | `START_SHA` |
|---|---|---|---|---|
| [H2 — loopback-only Ollama](2026-07-23-h2-ollama-loopback.md) | `codex/hardening-ollama-loopback` | `.claude/worktrees/hardening-ollama-loopback` | Validate Ollama configuration twice, direct/pinned no-proxy HTTP, redirect refusal, safe shell bootstrap parity | exact binding-approved `PLAN_BASE_SHA` |
| [H3 — repository-stable data root](2026-07-23-h3-data-root.md) | `codex/hardening-data-root` | `.claude/worktrees/hardening-data-root` | Canonical repository/data/dump roots and private temporary restore artifacts | reviewed H2 branch SHA |
| [H1 — tier-preserving compiled-note archives](2026-07-23-h1-note-tier.md) | `codex/hardening-note-tier` | `.claude/worktrees/hardening-note-tier` | Canonical archive bytes, tier recovery, identity-stable paths, crash-resumable reconciliation | reviewed H3 branch SHA |
| [H4 — durable tool audit attempt](2026-07-23-h4-audit-attempt.md) | `codex/hardening-audit-attempt` | `.claude/worktrees/hardening-audit-attempt` | Raw-receipt attempt audit, pre-release result audit, transport gateway/race handling | reviewed H1 branch SHA |
| [H5 — production-shaped contradiction scan](2026-07-23-h5-contradiction-scan.md) | `codex/hardening-contradiction-scan` | `.claude/worktrees/hardening-contradiction-scan` | Pair real parent-anchored extractor evidence and exclude compiled summaries | reviewed H4 branch SHA |

The immutable package is exactly these six files: this index plus the five plans H1–H5. There
is no H6 plan in this tranche; any other `docs/superpowers/plans/2026-07-23-*` path is outside
the package and must make the staged-ledger equality check fail.

The order is immutable without owner approval. H2 closes the live egress bypass first. H3 establishes the canonical roots consumed by H1 recovery. H1 establishes compiled-note recognition consumed by H5 exclusion. H4 is isolated after filesystem/config hardening because it changes the MCP transport boundary. H5 remains last because it changes nightly model work and must recognize both repaired and temporarily mis-provenanced H1 archives.

## Immutable plan package, worktree, and merge protocol

- [ ] **Step 1: Commit the final plan package and record `PLAN_BASE_SHA`**

Before any implementation branch or implementation subagent exists, run from the owner
repository:

```bash
git merge-base --is-ancestor 80760f6 HEAD
test -z "$(git status --porcelain --untracked-files=no)" || {
  echo "ERROR: tracked worktree is not clean; stop without touching owner changes." >&2
  exit 1
}
test -z "$(git diff --cached --name-only)" || {
  echo "ERROR: staging area already contains tracked paths; stop without unstaging owner changes." >&2
  exit 1
}
git diff --check
git add \
  docs/superpowers/plans/2026-07-23-pre-w5-hardening-index.md \
  docs/superpowers/plans/2026-07-23-h2-ollama-loopback.md \
  docs/superpowers/plans/2026-07-23-h3-data-root.md \
  docs/superpowers/plans/2026-07-23-h1-note-tier.md \
  docs/superpowers/plans/2026-07-23-h4-audit-attempt.md \
  docs/superpowers/plans/2026-07-23-h5-contradiction-scan.md
EXPECTED_PLAN_LEDGER="$(mktemp "${TMPDIR:-/tmp}/minime-plan-ledger.XXXXXX")"
ACTUAL_PLAN_LEDGER="$(mktemp "${TMPDIR:-/tmp}/minime-plan-staged.XXXXXX")"
trap 'rm -f "$EXPECTED_PLAN_LEDGER" "$ACTUAL_PLAN_LEDGER"' EXIT
cat >"$EXPECTED_PLAN_LEDGER" <<'EOF'
docs/superpowers/plans/2026-07-23-h1-note-tier.md
docs/superpowers/plans/2026-07-23-h2-ollama-loopback.md
docs/superpowers/plans/2026-07-23-h3-data-root.md
docs/superpowers/plans/2026-07-23-h4-audit-attempt.md
docs/superpowers/plans/2026-07-23-h5-contradiction-scan.md
docs/superpowers/plans/2026-07-23-pre-w5-hardening-index.md
EOF
git diff --cached --name-only | LC_ALL=C sort >"$ACTUAL_PLAN_LEDGER"
diff -u "$EXPECTED_PLAN_LEDGER" "$ACTUAL_PLAN_LEDGER"
git commit -m "docs(plans): finalize pre-W5 hardening tranche"
PLAN_BASE_SHA="$(git rev-parse HEAD)"
test -n "$PLAN_BASE_SHA"
git merge-base --is-ancestor 80760f6 "$PLAN_BASE_SHA"
git status --short --untracked-files=no
```

Expected: `80760f6` is an ancestor, `diff -u` is silent because the staged ledger contains
exactly the six listed plan paths, the commit succeeds, and tracked status is empty. Any
pre-staged extra path makes `diff -u` fail before commit; do not unstage, delete, or otherwise
mutate that owner change—stop and request owner review. Unrelated untracked files may remain
and must stay untouched. This commit is the immutable `PLAN_BASE_SHA`; H2 must start exactly at
it. Any later plan edit creates a new `PLAN_BASE_SHA`, invalidates the prior plan review, and
requires a fresh binding review before execution.

- [ ] **Step 2: Obtain binding plan approval for the exact commit**

Provide a fresh `final_reviewer_sol` the exact committed package:

```bash
git show --stat --oneline "$PLAN_BASE_SHA"
git diff "$PLAN_BASE_SHA^" "$PLAN_BASE_SHA" -- docs/superpowers/plans
```

Expected: an explicit binding `PASS` names the exact `PLAN_BASE_SHA` and covers design
fidelity, interfaces, tests, branch dependencies, and gates. A `BLOCK` stops implementation
until the plan is corrected, recommitted, assigned a new `PLAN_BASE_SHA`, and re-reviewed.

- [ ] **Step 3: Create the named tranche-base worktree**

Run from the owner repository:

```bash
TRANCHE_ROOT="$(git rev-parse --show-toplevel)"
TRANCHE_BRANCH="codex/pre-w5-hardening"
TRANCHE_WORKTREE_REL=".claude/worktrees/pre-w5-hardening"
TRANCHE_WORKTREE_PATH="$TRANCHE_ROOT/$TRANCHE_WORKTREE_REL"
test "$(git rev-parse HEAD)" = "$PLAN_BASE_SHA"
test "$TRANCHE_BRANCH" = "codex/pre-w5-hardening"
git check-ignore -q "$TRANCHE_WORKTREE_REL"
git worktree add "$TRANCHE_WORKTREE_PATH" -b "$TRANCHE_BRANCH" "$PLAN_BASE_SHA"
test "$(git -C "$TRANCHE_WORKTREE_PATH" rev-parse HEAD)" = "$PLAN_BASE_SHA"
git -C "$TRANCHE_WORKTREE_PATH" status --short --untracked-files=no
```

Expected: the ignored pinned worktree exists on `codex/pre-w5-hardening`, starts exactly at
`PLAN_BASE_SHA`, and has no tracked changes. Do not add an ignore rule.

- [ ] **Step 4: Create each execution worktree only after its predecessor is integrated**

At execution time, use `superpowers:using-git-worktrees`. Record the branch, integrated
predecessor SHA, and pinned relative path from the table in `BRANCH_NAME`,
`PREDECESSOR_SHA`, and `WORKTREE_REL`, then run from the owner repository:

```bash
test -n "${BRANCH_NAME:?set BRANCH_NAME from the current plan branch row}"
test -n "${PREDECESSOR_SHA:?set PREDECESSOR_SHA to the integrated predecessor SHA}"
test -n "${WORKTREE_REL:?set WORKTREE_REL from the pinned worktree column}"
WORKTREE_PATH="$TRANCHE_ROOT/$WORKTREE_REL"
git check-ignore -q "$WORKTREE_REL"
test "$(git -C "$TRANCHE_WORKTREE_PATH" rev-parse HEAD)" = "$PREDECESSOR_SHA"
git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" "$PREDECESSOR_SHA"
test "$(git -C "$WORKTREE_PATH" rev-parse HEAD)" = "$PREDECESSOR_SHA"
START_SHA="$(git -C "$WORKTREE_PATH" rev-parse HEAD)"
test "$START_SHA" = "$PREDECESSOR_SHA"
git -C "$WORKTREE_PATH" status --short --untracked-files=no
```

Expected: the SHA equalities exit 0, tracked status is empty, and `START_SHA` is recorded in
the branch evidence packet. H2 uses `PLAN_BASE_SHA` as both predecessor and `START_SHA`; it
never diffs directly from `80760f6`.

- [ ] **Step 5: Install frozen dependencies and run the clean baseline gate**

Before the first red test on every branch:

```bash
PACKAGE_SHA_BEFORE="$(git -C "$WORKTREE_PATH" hash-object package.json)"
LOCK_SHA_BEFORE="$(git -C "$WORKTREE_PATH" hash-object bun.lock)"
(
  cd "$WORKTREE_PATH"
  bun install --frozen-lockfile
  bun test
  bunx tsc --noEmit
  bunx biome check .
  git diff --check
  make check-subsystems
  make verify
)
test "$(git -C "$WORKTREE_PATH" hash-object package.json)" = "$PACKAGE_SHA_BEFORE"
test "$(git -C "$WORKTREE_PATH" hash-object bun.lock)" = "$LOCK_SHA_BEFORE"
git -C "$WORKTREE_PATH" diff --exit-code -- package.json bun.lock
git -C "$WORKTREE_PATH" status --short --untracked-files=no
```

Expected: the unmodified baseline is green, dependency manifests are byte-identical, and
tracked status is empty. A baseline failure stops the branch; do not attribute it to the
hardening implementation.

- [ ] **Step 6: Assign one bounded implementation card at a time**

Use `executor_luna` at GPT-5.6 Luna / xhigh. Give the executor ownership only of the files
listed by the current task in the subsystem plan. The executor must start with the prescribed
failing test, may not weaken assertions, and may not edit the approved design.

Expected: a focused commit matching the task's stated commit message and file set, with the
task's targeted test green.

- [ ] **Step 7: Review the complete branch before integration**

The executor completes the bounded cards test-first. After implementation and the full gate,
a fresh `first_pass_reviewer_luna` performs the complete-branch advisory review. Resolve all
Critical/Important findings. A disputed Luna Critical goes to a fresh
`critical_adjudicator_sol`; this closes only that finding and does not replace binding review.
Then one fresh `final_reviewer_sol` performs the binding complete-branch review. All scope
ledgers and review diffs use the branch worktree and recorded `START_SHA`:

```bash
git -C "$WORKTREE_PATH" status --short
git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD --stat
git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD --check
git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD
```

Expected: no unresolved Critical/Important Luna findings and an explicit binding Sol `PASS`
for the exact reviewed branch SHA before integration. A Sol `BLOCK` returns the exact
findings to the executor and counts as one failed review/gate cycle.

- [ ] **Step 8: Fast-forward the named tranche base to the exact reviewed SHA**

Set `REVIEWED_BRANCH_SHA` to the exact SHA named by the branch's binding PASS. Then run:

```bash
test -n "${REVIEWED_BRANCH_SHA:?set exact SHA named by binding branch PASS}"
test "$(git -C "$WORKTREE_PATH" rev-parse HEAD)" = "$REVIEWED_BRANCH_SHA"
git -C "$WORKTREE_PATH" status --short --untracked-files=no
test "$(git -C "$TRANCHE_WORKTREE_PATH" rev-parse HEAD)" = "$PREDECESSOR_SHA"
git -C "$TRANCHE_WORKTREE_PATH" merge --ff-only "$REVIEWED_BRANCH_SHA"
test "$(git -C "$TRANCHE_WORKTREE_PATH" rev-parse HEAD)" = "$REVIEWED_BRANCH_SHA"
PREDECESSOR_SHA="$REVIEWED_BRANCH_SHA"
```

Expected: the tranche base starts exactly at the predecessor, fast-forwards without a merge
commit, ends exactly at the reviewed branch SHA, and that exact SHA becomes the next
branch's predecessor and `START_SHA`. Do not substitute a branch name, use a non-fast-forward
merge, or continue after any equality or `--ff-only` check fails; a non-FF or SHA mismatch
stops the tranche for owner review.

- [ ] **Step 9: Prove the next branch cannot start from a stale sibling**

Run:

```bash
test "$(git -C "$TRANCHE_WORKTREE_PATH" branch --show-current)" = \
  "codex/pre-w5-hardening"
test "$(git -C "$TRANCHE_WORKTREE_PATH" rev-parse HEAD)" = "$PREDECESSOR_SHA"
git -C "$TRANCHE_WORKTREE_PATH" merge-base --is-ancestor \
  "$PLAN_BASE_SHA" "$PREDECESSOR_SHA"
```

Expected: exit 0. Pass exactly `PREDECESSOR_SHA` to the next table row. Stop if the next
worktree is based on an earlier sibling, `80760f6`, or any SHA other than the current
tranche-base head.

## Shared branch acceptance gate

Every subsystem plan has a narrower red/green sequence. Before each branch review, run this
exact shared gate from that branch worktree:

```bash
(
  cd "$WORKTREE_PATH"
  bun test
  bunx tsc --noEmit
  bunx biome check .
  git diff --check
  make check-subsystems
  make verify
)
```

Expected:

- all Bun tests pass with no new skip masking the regression;
- TypeScript reports no diagnostics;
- Biome reports no diagnostics and performs no fixes;
- `git diff --check` prints nothing;
- subsystem inventory coverage is green;
- every milestone suite and offline MinimeBench floor in `make verify` is green.

The branch evidence packet must contain:

```text
branch name
absolute pinned worktree path
PLAN_BASE_SHA
START_SHA
reviewed commit SHA
red test command and pre-fix failure
targeted green command and counts
clean baseline gate commands and exit codes
full gate commands and exit codes
package.json and bun.lock before/after hashes
first-pass Luna disposition
Critical adjudication disposition, when one occurred
binding Sol PASS
DECISIONS.md heading added
docs/SUBSYSTEMS.md row(s) changed
```

## Documentation ownership

- H2 appends `## 2026-07-23 — H2: loopback-only Ollama` and updates only the provider-layer inventory row.
- H3 appends `## 2026-07-23 — H3: repository-stable archive and dump roots` and updates only the Backup/PITR row plus owner/operator path documentation.
- H1 appends `## 2026-07-23 — H1: canonical compiled archives and reconciliation recovery` and updates only the Compiled notes row.
- H4 appends `## 2026-07-23 — H4: raw-receipt attempt and pre-release result auditing` and updates only the MCP door and access-frequency rows.
- H5 appends `## 2026-07-23 — H5: production parent contradiction pairing` and updates only the Dream job row.

Each decision entry states the Context, Decision, Why, validation evidence, and owner approval source (`docs/superpowers/specs/2026-07-23-pre-w5-hardening-design.md`). The executor never edits an older decision to make the new behavior appear historical.

## Integrated acceptance and W5 stop line

- [ ] **Step 1: Run the complete gate on the five-branch integrated base**

```bash
test "$(git -C "$TRANCHE_WORKTREE_PATH" branch --show-current)" = \
  "codex/pre-w5-hardening"
test "$(git -C "$TRANCHE_WORKTREE_PATH" rev-parse HEAD)" = "$PREDECESSOR_SHA"
(
  cd "$TRANCHE_WORKTREE_PATH"
  bun test
  bunx tsc --noEmit
  bunx biome check .
  git diff --check
  make check-subsystems
  make verify
)
```

Expected: all commands exit 0 on the integrated base.

- [ ] **Step 2: Obtain integrated binding review**

Give a fresh `final_reviewer_sol` the exact integrated diff and evidence:

```bash
git -C "$TRANCHE_WORKTREE_PATH" diff "$PLAN_BASE_SHA"...HEAD --stat
git -C "$TRANCHE_WORKTREE_PATH" diff "$PLAN_BASE_SHA"...HEAD --check
git -C "$TRANCHE_WORKTREE_PATH" diff "$PLAN_BASE_SHA"...HEAD
```

Expected: binding `PASS` names both exact `PLAN_BASE_SHA` and exact integrated `HEAD`, and
covers cross-branch configuration, archive, MCP, audit, and contradiction-scan interactions.

- [ ] **Step 3: Enforce the W5 stop line**

W5 design or implementation may begin only when all of the following are true:

```text
H2 merged and binding-reviewed
H3 merged and binding-reviewed
H1 merged and binding-reviewed
H4 merged and binding-reviewed
H5 merged and binding-reviewed
integrated full gate green
integrated binding Sol PASS
no unresolved owner decision or approved-design deviation
```

Stop immediately and return to the owner if any plan requirement is infeasible on the live baseline, a branch needs a design deviation, a protected/user file would need destructive handling, a second consecutive review/gate cycle fails in one area, or a binding Sol review returns BLOCK.
