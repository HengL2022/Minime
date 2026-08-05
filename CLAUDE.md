# Minime — agent instructions

Minime is a local-first personal life database with agent access (MCP). This file contains the
product and safety guardrails for code changes. The active single-owner workflow and completion
roadmap are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). The original
[minime-build-plan.md](minime-build-plan.md) is the historical v1 foundation, not an execution
checklist.

## Workflow rules

- Take the owner's requested task from inspection through implementation and proportionate
  verification. Do not pause for routine plan, branch, commit, or review approval.
- Use a short outcome-level plan when helpful. Repository-local skills, worktrees, branches, PRs,
  and subagents are optional tools, not mandatory stages.
- Make conservative, reversible assumptions and continue. Ask only at the high-impact boundaries
  listed in `docs/DEVELOPMENT.md` (publication, destructive/live-data actions, privacy/egress
  changes, paid external services, or a materially divergent product choice).
- Use focused tests while iterating and the risk-based verification ladder in
  `docs/DEVELOPMENT.md`. Do not rerun historical milestone chains.
- Record only durable contract decisions in `DECISIONS.md`: invariants, privacy/egress, schema
  meaning, public interfaces, dependencies, and recovery semantics. Routine fixes and plan drift
  do not need an entry or human ratification.
- **Complexity budget (W2):** keep `docs/SUBSYSTEMS.md` structurally current for long-lived
  subsystems and explain why net surface grows. Add a committed quantitative floor only when the
  subsystem has meaningful measurable behavior. `make check-subsystems` enforces path coverage.

## Non-negotiable invariants (preserve in every change)

- **I1 Local-first**: no cloud DB, no SaaS APIs, no telemetry. Default runtime network =
  localhost Postgres + localhost Ollama. Amendment (DECISIONS.md 2026-06-11 + W3): optional
  cloud LLM providers for embed/classify, gated by `CLOUD_MAX_TIER` and per-tier
  `PROVIDER_ROUTE_*` (stricter-only), every call audited as `egress:*`; tier-0 content never
  leaves on any path. CI/tests still run fully offline (mock Ollama).
- **I2 One door**: agents reach data only through the Minime MCP server; never hand out a DB
  connection string. (Recorded exception, DECISIONS 2026-07-18/W4: the committed
  `.env.engineering` DSN is SELECT-only + RLS-tier-gated for engineering sessions — full-rights
  DSNs remain daemon-only.)
- **I3 Tiered egress**: tier 0 content (transactions, health) never enters agent context —
  aggregates only via `metric_defs.agg_sql`. Tier 2 reads require a time-boxed, audited unlock.
- **I5 Provenance**: every row stamps `source`, `created_by`, `derived_from`.
- **I6 Numbers via SQL only**: quantitative answers go through `minime_query_metric`, never model
  arithmetic over prose.
- **I8 Append-only audit**: every tool call (reads included) writes an `events` row; `events` is
  never updated or deleted.
- **Never log, print, or snapshot the contents of tier-0 rows.** Row IDs are fine.

## Tech stack (pinned — spec §4; substitutions require a DECISIONS.md entry)

TypeScript on **Bun** · **PostgreSQL 16 + pgvector** via Docker Compose · `postgres` (postgres.js)
raw SQL, **no ORM** · plain numbered `.sql` migrations in `db/migrations/` ·
`@modelcontextprotocol/sdk` (stdio) · Ollama (`nomic-embed-text` 768 dims, `llama3.1:8b`) ·
`chokidar` · `croner` · `bun test` · `biome` · `restic`.

## Code conventions (spec §14)

- Plain SQL strings live **only** in `src/db/repo.ts`, migrations, and `metric_defs.agg_sql`.
  Everything is parameterized; never ship string-interpolated SQL.
- `repo.ts` is the only place SQL runs; it appends the tier predicate to every content read.
- Functions under ~60 lines; no clever metaprogramming; comments explain *why*, not *what*.
- Prefer boring code: small modules, plain SQL, few dependencies — maintainable by one person for
  a decade. No new external network dependencies, ever.
- Fixtures are realistic but **fictional** — never the owner's real data.
- **Engineering sessions never write the live DB directly.** Ad-hoc DB access uses the
  SELECT-only DSN in `.env.engineering` (`make psql-ro`). Live writes go through the MCP
  tools, `make migrate`, or `bun run scripts/repair.ts <committed-script>` (auto pre-image
  backup + `repair:*` audit). New tier-0 tables must add an explicit
  `revoke select ... from minime_engineer_ro` in their migration.

## Commands

```
make up            # start Postgres (+extensions), check Ollama models
make verify-mN     # focused legacy area suite when useful
make verify-offline # fast offline development gate: mocked M0, full tests, lint, typecheck, subsystem check
make verify        # release/search gate: verify-offline plus retrieval regression
make eval-search   # offline MinimeBench vs committed floors (fixtures/qrels/baseline.ndjson)
make eval-search-live          # live embeddings, N=3 (owner-run; writes docs/benchmarks/)
make eval-snapshot ROUND=vX    # dated release scorecard for the stability streak
bun test           # test suite (offline; Ollama mocked)
bun run lint       # non-mutating lint
bun run format     # format files
bun run typecheck  # strict TypeScript check
```

During development, run focused tests. Use `make verify-offline` once at the end of cross-module
or safety-sensitive work. Use `make verify` for ranking changes and release candidates; it already
includes `verify-offline`. Recovery changes also need their relevant scratch restore E2E. See
`docs/DEVELOPMENT.md` for the complete risk-based table.
