# Minime — agent instructions

Minime is a local-first personal life database with agent access (MCP). The full spec is
[minime-build-plan.md](minime-build-plan.md) — **read it before implementing anything; it is the
source of truth.** This file is only the distilled guardrails.

## Workflow rules (spec §0, §13)

- Implement milestones **M0 → M6 in order**. Each ships a `make verify-mN` target that must stay green.
- One milestone per branch/PR. Never start M(n+1) while `verify-m(n)` is red.
- Record every deviation from the spec in `DECISIONS.md` (use `/log-decision`). When the spec is
  ambiguous, ask the human — do not invent scope.
- TDD where cheap: write the verify target's failing test first for each acceptance criterion.

## Non-negotiable invariants (spec §1 — every PR is checked against these)

- **I1 Local-first**: no cloud DB, no SaaS APIs, no telemetry. Runtime network = localhost Postgres
  + localhost Ollama only. CI/tests run fully offline (mock Ollama).
- **I2 One door**: agents reach data only through the Minime MCP server; never hand out a DB
  connection string.
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
  Everything parameterized — string-interpolated SQL is a review-blocker.
- `repo.ts` is the only place SQL runs; it appends the tier predicate to every content read.
- Functions under ~60 lines; no clever metaprogramming; comments explain *why*, not *what*.
- Prefer boring code: small modules, plain SQL, few dependencies — maintainable by one person for
  a decade. No new external network dependencies, ever.
- Fixtures are realistic but **fictional** — never the owner's real data.

## Commands

```
make up            # start Postgres (+extensions), check Ollama models
make verify-mN     # acceptance gate for milestone N
bun test           # test suite (offline; Ollama mocked)
bunx biome check --write .   # lint + format
```

Before claiming a milestone done, run its `verify-mN` target **and** all previous ones.
