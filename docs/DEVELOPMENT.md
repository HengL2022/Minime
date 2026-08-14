# Minime development workflow

**Status:** active from 2026-08-04. This is the current engineering process and completion
roadmap for a single owner working with AI agents.

The product and privacy guardrails in `CLAUDE.md` remain binding. The original
`minime-build-plan.md`, `DECISIONS.md`, and `docs/superpowers/` files are design history and
technical reference, not executable workflow. When process instructions conflict, use this
file. A direct owner instruction can change the process or product direction.

## Default: finish the task

An agent should take a requested coding task from inspection through implementation and
proportionate verification without pausing for routine approval.

1. Read `CLAUDE.md`, this file, and only the code/tests relevant to the task.
2. State a short working plan when the task has more than one meaningful step.
3. Make conservative, reversible assumptions and keep going. Mention them in the handoff.
4. Implement the complete outcome, including necessary tests and nearby documentation.
5. Run the narrowest credible verification from the table below.
6. Review the final diff once, fix issues found, and report the result and any real residual risk.

No separate design approval, plan approval, task authorization, branch approval, or review
approval is required for repository-local work already covered by the owner's request. This
includes inspection, edits, focused tests, temporary fixtures, worktrees when useful, and local
commits. A branch or PR is optional, not a unit of work.

Ask the owner only before an action that changes authority or is difficult to recover:

- pushing, opening a public PR, deploying, publishing, or sending external messages;
- rewriting Git history, force-pushing, deleting material files, or destructive cleanup;
- mutating the owner's live data outside normal product tools, applying a migration to the live
  database, or promoting a restored database;
- adding a paid or credentialed external service, weakening a privacy/tier boundary, or exposing
  personal content; or
- choosing between materially different product directions when no safe reversible default exists.

If one of those actions is not needed, do not stop merely because a plan drifted, a branch SHA
changed, a live benchmark is unavailable, or a first attempt failed. Re-plan and continue.

## Planning budget

Most work needs only an in-conversation plan of 3–7 outcome-level steps. Create or expand a
task-specific written plan only when work spans several independent deliverables, has a risky data
operation, or will be handed across sessions. Keep it under roughly 100 lines and include only:

- outcome and non-goals;
- files or components likely to change;
- dependencies that truly impose order;
- risk controls; and
- observable acceptance checks.

Do not write step-by-step code snippets, exact-SHA authority locks, custody ledgers, reviewer
scripts, approval receipts, or a separate spec for routine work. Update the plan when reality
changes; do not re-ratify it.

Superpowers and other skills are optional tools. Use a focused skill when it directly helps the
task. Do not automatically chain brainstorming → spec → plan → worktree → execution → multiple
reviews. The owner's request for end-to-end execution overrides those ceremonial gates.

## Multi-agent use

Use one coordinating agent and parallel workers only for genuinely independent work. Give each
worker a bounded file or outcome scope, let it implement and test that scope, then integrate once.
Do not create fresh agents for planning, test design, first-pass review, binding review, and
adjudication of the same small change.

Self-review is the default. Add one independent reviewer only when a change could expose or
destroy owner data, changes tier/auth enforcement, changes a live migration, or changes
backup/restore behavior. That review is advisory unless it identifies a concrete safety or
correctness defect. There is no model hierarchy or mandatory Luna/Sol sequence.

## Verification by risk

| Change | Required before handoff |
|---|---|
| Documentation or process only | `git diff --check` plus a targeted consistency/search check |
| Isolated code or bug fix | focused test(s); lint/format on touched code; typecheck when a TypeScript boundary changed |
| Cross-module runtime, MCP, or search behavior | focused tests, then `make verify-offline` once at the end |
| Privacy, tier/auth, migration, install/update, backup, or restore | focused adversarial tests, `make verify-offline`, and the relevant scratch/local E2E; one independent review when owner data could be exposed or lost |
| Search ranking change | the relevant search tests and `make eval-search`; run the live N=3 eval before release, not after every edit |
| Release candidate | `make verify`; add `make restore-drill` when recovery changed or for a release that claims restore readiness |

Write a regression test for a reproduced bug and a behavioral test for meaningful new logic.
TDD is useful for risky or subtle behavior but is not required for prose, mechanical refactors,
or obvious configuration changes. Do not rerun all historical milestone targets: `make
verify-offline` already owns the complete offline suite.

A task is done when the requested behavior works, the applicable row above is green, the final
diff contains no unrelated changes, and remaining limitations are stated plainly. A PR, review
report, scorecard, decision entry, or commit is not intrinsically part of done.

## Decisions and subsystem records

Add a concise `DECISIONS.md` entry only for a durable change to a product invariant, privacy or
egress rule, schema meaning, public interface, dependency, or recovery contract. Routine bug
fixes, test details, branch mechanics, reviewer findings, and plan adjustments belong in commits
or the task handoff, not the decision log. Existing entries remain append-only history.

Keep `docs/SUBSYSTEMS.md` as a lightweight inventory. Add or update a row when a long-lived
subsystem is introduced or materially changed. A quantitative floor is required only when the
subsystem has meaningful measurable behavior; it is not a prerequisite for ordinary plumbing.

## Active release closure

The old remediation train is no longer a release plan. This is the complete blocking list for the
current release; everything else returns to the ordinary product backlog below.

### 1. Close the privacy and least-privilege boundary

- **Delivered 2026-08-04:** `make check-tracked-privacy BASE=<local-base-ref>` scans the tracked
  current tree and outgoing commit range for private text using terms supplied through stdin. It
  reports only sanitized locations/counts and does not create evidence receipts or publication
  paperwork.
- **Delivered 2026-08-05:** resident `serve` keeps owner maintenance in a non-MCP supervisor and
  launches a scrubbed `minime_app` child. Scratch evaluators mint unique app roles, and the
  installer/serve endpoint checks refuse split or remote database targets.
- **Delivered 2026-08-05:** behavioral tests cover tier-0 insert-only access, locked tier-2
  omission, and tier-preserving edge writes.
- **Delivered 2026-08-06:** effective classification routing rejects a cloud provider above
  `CLOUD_MAX_TIER` before fetch or egress audit; derived people, orgs, aliases, and edges
  inherit source privacy tier and provenance with monotonic promotion; tier-2 unlocks are
  strictly bounded pending requests that require local owner approval and bind to a fresh MCP
  connection session.

**Accept:** privacy/role/reader tests and `make verify-offline` pass. Use one independent privacy
review. Before the next push, scan the outgoing tree/range; if private text is already public,
the owner chooses forward redaction or history repair because that remote action is consequential.

### 2. Establish minimum honest recovery

- **Delivered 2026-08-05:** each consistent dump has a private manifest binding its exact hash,
  migration ledger, and representative counts; the prior verified pair is retained before
  replacement.
- **Delivered 2026-08-05:** an actual fictional-data restic snapshot was restored into the fixed
  `minime_drill` scratch database and its ledger/counts matched without reading or changing live.
- **Delivered 2026-08-06:** Make recovery commands use one inert-data `.env` wrapper and a narrow
  child environment. The drill labels and requires a real restic source, validates the historical
  manifest/counts, migrates only the scratch database, and checks the exact current ledger and
  safety posture. `make verify-restore-e2e` exercises this with fictional data in an isolated
  PostgreSQL cluster and local restic repository.
- The compatibility command `restore-pitr` performs a logical snapshot restore at or before
  `TIME`, validates and upgrades `minime_restore`, and leaves it for inspection. It is not WAL/PITR
  and does not claim point-in-time recovery semantics.
- **Delivered 2026-08-05:** `typecheck-ops` covers maintained recovery scripts outside the main
  `tsconfig`; do not broaden it to disposable evidence scripts.
- **Delivered 2026-08-06:** promotion remains manual. It requires idle databases and exact schema
  posture, writes a pre-promotion dump, blocks connections, uses a guarded two-step rename, and
  compensates a failed second rename back to the original live name. The prior live database is
  retained connection-blocked after success. Do not build an automatic recovery state machine or
  WAL-PITR claim for this release.

**Accept:** focused backup/restore tests, one fictional-data restic round trip, the scratch restore
E2E, and `make verify-offline` pass. This must land before a new migration is applied to owner data.

### 3. Make routine evaluation read-only

- **Delivered 2026-08-05:** deterministic mock regression floors are separate from live
  measurements.
- **Delivered 2026-08-05:** routine `make eval-search` is read-only: a missing committed baseline
  fails, and only explicit
  live/release commands write scorecards or update floors.
- For live reports record only the metadata needed for comparison: evaluated commit, model and
  configuration, dataset hash, seeds, and per-run results.

No ranking code changed in this release, so there is no boost experiment or live N=3 requirement.

**Accept:** evaluator tests and `make eval-search` pass without changing the working tree. No CAS
ratchet, evidence-hash hierarchy, or approval receipt is needed.

### 4. Release

- **Delivered 2026-08-14:** owner and agent documentation matches the 22-tool surface
  (`README.md`, `AGENTS.md`, `agents/skills/RESOLVER.md`). Stale "14 functions" / "14 tools"
  claims are gone. A contract test pins every registered tool name in those three files
  and reads Make recipes without nested `--print-directory` banners.
  `make eval-search` held every committed mock floor. Lint, typecheck, typecheck-ops, and
  `check-subsystems` pass. Focused suites for the 22-tool contract, multi-entity companion
  split, and single inbox-watcher lock pass. A cloud-VM `make verify-offline` was 1860
  pass / 1 skip / 9 fail; the three nested-Make contract dry-run failures are gone.
- Remaining owner-only gates (do not start these from an agent session without an explicit
  ask): a full `make verify` on the owner's machine. This cloud VM already binds native
  Postgres on 5432 and skipped Ollama, so installer/launch suites cannot prove a clean
  first-install path here. Its Git 2.43 `rev-list --objects -z` also does not emit the
  NUL/`path=` records the privacy scanner parses, so three outgoing-blob fixture cases
  report `outgoing_blobs=0` and cannot stand in for the owner scan. One inbox-identity
  watcher case timed out (known flake). Then: a real-snapshot `make restore-drill`, the
  outgoing privacy scan with the owner's private terms, live migrate through 040 after
  backup, and the release handoff. Merging to `main` and any history rewrite remain the
  owner's explicit action. Do not create another release train unless the owner asks
  for one.

## Ordinary product backlog (not release blockers)

After the release gate, resume product work as outcome-sized tasks under this workflow. Current
known candidates are:

- W6 image capture after an owner VLM bake-off of 10 fictional images (the parse
  slot is now complete; CLIP/SigLIP stays deferred);
- optional `source_file` frontmatter on capture-filed notes pointing at the
  originals-store path (deferred from this W5 slice — recovery-sensitive);
- LLM segment pre-pass (the 2026-08-14 deterministic companion split covers
  legal-suffix / enumerated-company captures; first-class org/person capture
  types shipped 2026-08-14 — see
  `docs/known-issues/classifier-multi-entity-captures.md`); and
- close remaining known-issue documents once their behavioral regressions pass
  (extractor-phantom-orgs Fix C / high-edge watchdog shipped 2026-08-14; the
  live pre-Fix-B sweep and the LLM segmenter remain).

Agent skill wording for owner-approved tier-2 unlocks and timezone-aware output should stay aligned
as ordinary documentation maintenance. These improvements matter, but bundling them into the
security/recovery release made the plan unnecessarily serial and slow.

## Retired ceremony

The following old requirements are explicitly inactive: mandatory Superpowers pipelines,
M0→M6 branch order, one branch/PR per milestone, feature freezes spanning the whole remediation
train, plan ratification, fresh-agent review chains, exact-SHA review invalidation, authority
locks, custody ledgers, accepted tags, universal gates after every subtask, owner receipts for
local evidence, and stopping after an arbitrary number of correction cycles.

The files under `docs/superpowers/` and `.superpowers/` may still explain edge cases. Consult one
only when its technical detail is relevant; never execute one as a checklist unless the owner
explicitly revives it.
