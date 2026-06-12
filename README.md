# Minime

A **local-first personal life database with agent access**. Your journal, decisions, tasks,
people, calendar, money and health — stored queryably on hardware you control, exposed to AI
agents through one audited MCP door so they can help you decide.

Spec: [minime-build-plan.md](minime-build-plan.md) · Deviations: [DECISIONS.md](DECISIONS.md)

## Install (one command)

```
git clone https://github.com/HengL2022/Minime minime && cd minime && bash scripts/install.sh
```

Non-interactive, safe to re-run, installs everything missing (bun, Postgres+pgvector via
Docker/brew/apt, Ollama + models), migrates, verifies, and prints how to register the MCP
server. Add `--with-demo` for a fictional dataset to explore. Full contract — flags,
degraded modes, machine-parsable output for coding agents — in [AGENTS.md](AGENTS.md).

**Have an AI agent install it for you** — paste this into Claude Code (or any agent with
shell access):

> Retrieve and follow the instructions at:
> https://raw.githubusercontent.com/HengL2022/Minime/main/AGENTS.md

**Want cloud models or off-site backups?** Run the guided wizard first — it walks you
through provider credentials (Bedrock/Anthropic/OpenAI/OpenRouter) and backup storage
(local disk, Backblaze B2, or S3), writing a private `.env`:

```
make setup     # interactive; the local-Ollama defaults need no credentials at all
```

<details>
<summary>Manual install (what the script does, step by step)</summary>

1. Install [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).
2. Install Docker (preferred) — or natively: `brew install postgresql@17 pgvector` (macOS)
   / `apt-get install postgresql-16 postgresql-16-pgvector` from PGDG (Debian/Ubuntu).
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

</details>

After install (optional): install `restic` + set `RESTIC_REPOSITORY`/`RESTIC_PASSWORD_FILE`
for backups; run `bun run src/cli.ts serve` under launchd/systemd for resident mode; load
the `agents/skills/` prompts into your agent — `RESOLVER.md` routes requests to the right
skill (query, graph-query, person-brief, capture, review-triage, morning-brief,
evening-review, decision-brief).

## Daily use

**New here? Read the [owner's guide](docs/GUIDE.md)** — how to capture notes and ideas,
journal, log decisions, import your data, and build the habits that make it compound.

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

Session capture (optional): `make install-hooks` adds a Claude Code `SessionEnd` hook that
summarizes every agent work session — first request, outcome, files touched — into
`data/inbox/` (heuristic extraction, no model call, trivial sessions skipped). Same inbox
door as any other capture; sessions file as tier-2 pages (verbatim prompt text stays behind
the unlock gate). Confirmation-gated install, backs up `~/.claude/settings.json` first.

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
make verify-m7   # typed-edge knowledge graph (orgs, works_at, relations)
make verify-m8   # CJK-aware FTS + chunker (bigram fold)
make verify-m9   # fusion / eval-harness / notes / reranker suites
make verify      # all of the above + the retrieval-regression gate (eval-search)
make restore-drill  # restore latest backup into a scratch DB and validate
```

Tests run fully offline: Ollama is mocked (`MINIME_MOCK_OLLAMA=1`), the DB is local.

## How good is the retrieval? (eval data)

**Public benchmarks** (full engine: RRF hybrid + local bge-reranker-v2-m3 + autocut; live
qwen3-embedding-8b):

| Benchmark | Metric | No reranker | Full engine | Reference |
|---|---|---|---|---|
| [LongMemEval-s](docs/benchmarks/2026-06-12-longmemeval-s.md) (500 q) | recall@5 | 94.0% | **97.2%** | gbrain 97.6% |
| | recall@1 | 74.8% | **88.6%** | |
| | MRR@10 | 0.830 | **0.925** | |
| [PrecisionMemBench](docs/benchmarks/2026-06-12-live-rerank-precisionmembench.md) (precision-only) | mean precision | 6.5% | **52.3%** | recall stays 94% |

LongMemEval-s is judge-free (session-evidence labels). PrecisionMemBench scores *precision*
only — it punishes returning extras for the model to sort out; the reranker + autocut are what
move it from 6.5% to 52.3%, and we publish the bad default because optimizing for it alone
would hurt the common case (recall). `make eval-longmemeval`, `make eval-pmb`.

**MinimeBench** — eight in-house areas with committed bars, run live each integration
([latest](docs/benchmarks/2026-06-12-live-qwen3-minimebench.md)): retrieval-en 97% hit@3,
retrieval-zh 100% (bilingual zh/en/mixed), graph/identity/time 100% hit@3, provenance 100%,
robustness 100% (22 adversarial inputs, no crash, no tier leak). `make eval-search-live`.

**Skills layer** — the `agents/skills/*.md` playbooks are eval'd too, not just the engine:
[SkillEval](docs/benchmarks/2026-06-12-live-r1-skilleval.md) drives them through the audited
tool door and scores from the events log (12/13 behavioral contracts pass);
[SkillOpt](docs/benchmarks/2026-06-12-cat30-skillopt-query.md) is a validation-gated optimizer
loop — a deliberately deficient skill rewrote itself 0→perfect on held-out tasks (3/5 → 4/5),
gated against contamination and held-out regression so it cannot cheat. `make eval-skills`,
`make optimize-skill SUITE=<name>`.

Kept honest: sealed answer keys (loaded only by the scorer), a CI regression gate on every
push (`make eval-search` vs committed floors), fictional corpora, N=3 live runs — scorecards
in [docs/benchmarks/](docs/benchmarks/) publish the weak numbers too.

Honest weak spots, on purpose: PrecisionMemBench scope-disambiguation (3/12) and
supersession-exclusion (0/3) are open; one MinimeBench content gap persists ("home address",
no doc states it). See the scorecards.

## Threat model honesty

Anything an agent reads transits that agent's model provider. Tiers minimize and audit that
surface; they don't eliminate it. Tier-0 content never enters agent context at all; tier-2
requires an explicit, expiring, loudly-logged unlock. Full-disk encryption at rest is your
responsibility. `.env` is never committed; back up with restic to media you control.

Optionally, the internal pipeline (embeddings, classification, contradiction scan) can route
to cloud providers instead of local Ollama (`EMBED_PROVIDER`/`CLASSIFY_PROVIDER` — Anthropic,
OpenAI, OpenRouter, Bedrock; see [AGENTS.md](AGENTS.md)). That widens the egress surface
deliberately: content up to `CLOUD_MAX_TIER` (default 2) transits the chosen provider, every
call is recorded in the append-only audit log (`egress:*` events), and tier-0 content never
leaves under any configuration.
