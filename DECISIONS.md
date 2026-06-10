# DECISIONS

Append-only log of deviations from `minime-build-plan.md`, ambiguity resolutions, and technical
decisions (spec §0.3). Newest entries at the bottom. Use `/log-decision` to add entries.

## 2026-06-10 — Claude Code environment setup

- **Context:** Pre-M0 tooling; not part of the spec's milestones.
- **Decision:** Added `.claude/` config (CLAUDE.md guardrails, secrets-protection + biome-format
  hooks, invariant-reviewer subagent, /log-decision and /verify-milestone skills) and initialized
  the git repo on `main`.
- **Why:** The spec mandates a branch-per-milestone workflow, DECISIONS.md discipline, and
  invariant checks on every PR; encoding them in the agent environment makes them enforced rather
  than aspirational.
- **Approved by:** human (requested setup).

## 2026-06-10 — Single-pass build, no milestone gating

- **Context:** Spec §0.1–0.2 mandates one milestone per branch/PR, M0→M6 in order.
- **Decision:** Build the whole system in one pass on `main`; all `make verify-mN` targets still
  ship and must be green, they just gate the finished system rather than sequential PRs.
- **Why:** Owner's explicit directive: "Just follow the plan and keep coding until everything is
  usable. No need to gate by M0."
- **Approved by:** human.

## 2026-06-10 — Homebrew PostgreSQL 17 instead of Docker PostgreSQL 16

- **Context:** Spec §4 pins "PostgreSQL 16 + pgvector via Docker Compose" — this is a pinned-stack
  substitution.
- **Decision:** On this box Postgres runs via `brew install postgresql@17 pgvector`
  (`scripts/up.sh` auto-detects: Docker when available, Homebrew fallback otherwise).
  `docker-compose.yml` (pgvector/pgvector:pg16) ships unchanged for Docker-equipped boxes.
- **Why:** No Docker runtime is installed and installing one needs GUI/license steps; Homebrew's
  pgvector bottle only builds against postgresql@17/18, so 17 is the closest conforming version.
  Nothing in the schema uses 17-only features; everything stays on localhost (I1 intact).
- **Approved by:** agent-proposed (pending human review).

## 2026-06-10 — agg_sql convention: ($1,$2) params, 3-column result, security definer door

- **Context:** Spec §7/§8 leave the `metric_defs.agg_sql` calling convention unspecified.
- **Decision:** Every `agg_sql` takes `$1`=from-date, `$2`=to-date and returns exactly
  `(period_start date, value numeric, label text)` at day granularity (label null for
  dimensionless metrics; `spend_by_category` uses it). All execution goes through one
  `security definer` function `metric_agg(name, from, to)` (007_rls.sql); week/month series are
  summed from daily values. Labeled metrics are live-only (not persisted to `metric_values`,
  whose PK has no dimension column).
- **Why:** One parameterized door keeps I3/I6 enforceable and gives RLS-hardened roles the same
  path as the owner role; summing days is correct for all seeded additive metrics.
- **Approved by:** agent-proposed (pending human review).

## 2026-06-10 — Tests use a test-only SQL helper; error messages never echo input

- **Context:** Spec §14 confines SQL to repo.ts/migrations/agg_sql; spec §8 tool errors.
- **Decision:** `test/helpers.ts` may run raw SQL (schema reset, direct assertions like proving
  `events` UPDATE fails). Application code remains repo.ts-only. Separately, tool error/gap
  messages never echo user input (e.g. NOT_FOUND omits the searched name) so audit/leak checks
  can distinguish DB leaks from parameter echoes.
- **Why:** The M1/M6 acceptance criteria are unprovable without direct SQL probes; echo-free
  errors shrink the leak surface and made the fuzz suite's sentinel assertions sound.
- **Approved by:** agent-proposed (pending human review).

## 2026-06-10 — Dream-job simplifications (v1)

- **Context:** Spec §10 dream steps 3, 4, 7; §13 M6 restore drill.
- **Decision:** (a) Contradiction scan compares chunk pairs linked to the same person; with
  Ollama it asks the local model, in offline tests a deterministic antonym heuristic stands in.
  (b) Staleness flags pages/people untouched >180 days without the "referenced this week"
  precondition (reference tracking deferred). (c) `make restore-drill` restores the latest
  restic snapshot when restic is configured, else drills the same restore path from a fresh
  `pg_dump`; it validates schema, data presence and the append-only trigger in the scratch DB
  rather than re-running the (destructive) m1 reset suite against it.
- **Why:** Keeps every spec behavior present and testable offline without overbuilding v1;
  full reference-tracking and restic-only drills can land later without schema changes.
- **Approved by:** agent-proposed (pending human review).

## 2026-06-11 — One-command installer (scripts/install.sh) and agent contract (AGENTS.md)

- **Context:** Ops tooling on top of the spec (no §13 milestone covers installation UX).
  Touches the §4 pin indirectly: native Linux installs use PostgreSQL 16 via PGDG (matches
  the spec pin and the Docker image); native macOS stays PostgreSQL 17 (pgvector brew bottle
  constraint, already recorded 2026-06-10).
- **Decision:** `bash scripts/install.sh` is the single non-interactive setup path
  (bun → deps → postgres → .env → ollama → migrate → seed? → verify → MCP hints), idempotent
  by detect-before-act, machine-parsable output (`status:` summary block, fixed `ERROR:`/`FIX:`
  failure tail, per-step exit codes). Ollama problems *degrade* (status: degraded, exit 0) —
  the runtime already supports FTS-only search and review-queue classification — everything
  else fails loudly. AGENTS.md documents the contract for coding agents; shared bash lives in
  `scripts/lib.sh`; `scripts/pg-probe.ts` detects a provisioned DB without a psql client.
  A GitHub Actions matrix (ubuntu-22.04/24.04 + macos-14) covers the install paths this
  development machine cannot test (fresh apt/PGDG, systemd, fresh brew); it activates when
  the repo is pushed to GitHub.
- **Why:** The 15-step README install was the main adoption blocker; the owner wants
  "give an agent the GitHub link, get a verified install". Degraded-but-verified beats
  all-or-nothing because the 4.7GB model pull is the most failure-prone step and the system
  is genuinely useful without it.
- **Approved by:** human (plan approved 2026-06-11).

