# Minime

A **local-first personal life database with agent access**. Your journal, decisions, tasks,
people, calendar, money and health — stored queryably on hardware you control, exposed to AI
agents through one audited MCP door so they can help you decide.

Spec: [minime-build-plan.md](minime-build-plan.md) · Deviations: [DECISIONS.md](DECISIONS.md)

## Install on a fresh box

1. Install [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).
2. Install Docker (preferred) — or, without Docker: `brew install postgresql@17 pgvector`.
3. Install [Ollama](https://ollama.com) and start it.
4. `ollama pull nomic-embed-text && ollama pull llama3.1:8b`
5. Clone this repo; `cd minime`.
6. `bun install`
7. `cp .env.example .env` and adjust (defaults work for local Docker/brew setups).
8. `make up` — starts Postgres, creates databases + extensions, checks Ollama models.
9. `make migrate` — applies `db/migrations/*.sql`.
10. (optional) `bun run src/cli.ts seed` — loads a fictional demo dataset to explore with.
11. `make verify-m0 && make test` — prove the environment end to end.
12. Register the MCP server with your agent:
    `claude mcp add minime -- bun run /absolute/path/to/minime/src/cli.ts serve`
13. (optional, backups) install `restic`, set `RESTIC_REPOSITORY` + `RESTIC_PASSWORD_FILE`
    (file perms 0600) in `.env`.
14. (optional, resident mode) run `bun run src/cli.ts serve` under launchd/systemd so the
    inbox watcher and the 3am dream job run continuously.
15. Paste the prompts in `agents/skills/` into your agent for the morning-brief,
    evening-review and decision-brief workflows.

## Daily use

```
bun run src/cli.ts serve            # MCP server (stdio) + inbox watcher + dream cron
bun run src/cli.ts sync             # data/brain/**/*.md -> pages + search index
bun run src/cli.ts dream            # run nightly maintenance now
bun run src/cli.ts audit --since 7d # what left the box, to which client, when
bun run src/cli.ts import:calendar export.ics
bun run src/cli.ts import:transactions june.csv --profile dbs
bun run src/cli.ts import:health export.xml
bun run src/cli.ts import:email-meta ~/Maildir
```

Capture: drop text/markdown files into `data/inbox/` (iOS Shortcut + Syncthing, share sheet,
or `minime_capture` from an agent). The watcher classifies and files them; anything it isn't
sure about waits for the evening review.

## Architecture (short version)

- **Files are the archive, rows are the state, Postgres is the index.** Prose lives as
  markdown in `data/brain/` (its own git repo); structured state lives as rows; everything is
  chunked, embedded (local Ollama) and hybrid-searchable.
- **One door.** Agents only reach data through the `minime` MCP server — 11 tools, every call
  audited to an append-only `events` table, every output redacted (card/IBAN/account numbers)
  and wrapped in an envelope carrying sources, staleness and gaps.
- **Tiers.** 0 = never leaves the DB (transactions, health) — aggregates only via whitelisted
  SQL in `metric_defs.agg_sql`. 1 = agent-readable default. 2 = journal/interactions/email
  metadata — reads require a time-boxed `minime_unlock`, writes are always allowed.
- **Numbers via SQL only.** Quantitative answers route through `minime_query_metric`; the
  model never does arithmetic over prose.

## Verification

```
make verify-m0   # environment: DB, extensions, Ollama models
make verify-m1   # schema, seed, append-only audit
make verify-m2   # MCP tools, audit rows, redaction
make verify-m3   # hybrid search retrieval eval (≥80% top-5)
make verify-m4   # importers (idempotent, golden files), inbox e2e
make verify-m5   # decision engine e2e (fake clock)
make verify-m6   # leak suite (200 fuzzed calls), unlock expiry, RLS
make restore-drill  # restore latest backup into a scratch DB and validate
```

Tests run fully offline: Ollama is mocked (`MINIME_MOCK_OLLAMA=1`), the DB is local.

## Threat model honesty

Anything an agent reads transits that agent's model provider. Tiers minimize and audit that
surface; they don't eliminate it. Tier-0 content never enters agent context at all; tier-2
requires an explicit, expiring, loudly-logged unlock. Full-disk encryption at rest is your
responsibility. `.env` is never committed; back up with restic to media you control.
