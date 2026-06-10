# Minime — System Build Plan v1.0

**Audience:** a coding agent (Claude Code / OpenClaw / Hermes) implementing this system end to end.
**This document is the spec.** Read it fully before writing code. Work milestone by milestone (§13). Do not invent scope; when the spec is ambiguous, ask the human and record the resolution in `DECISIONS.md`.

---

## 0. How to use this plan (instructions to the coding agent)

1. Implement milestones **M0 → M6 in order**. Each milestone has acceptance criteria and a `make verify-mN` target you must create and keep green.
2. One milestone per branch/PR. Never start M(n+1) while `verify-m(n)` is red.
3. Record every deviation from this spec, with reasoning, in `DECISIONS.md` at repo root.
4. **No new external network dependencies.** The only network calls allowed at runtime are to `localhost` Postgres and `localhost` Ollama. CI/tests must run fully offline (mock Ollama).
5. Never log, print, or include in test snapshots the *contents* of tier-0 rows (transactions, health). Logging row IDs is fine.
6. Prefer boring code: small modules, plain SQL, few dependencies. This system must be maintainable by one person for a decade.

---

## 1. Mission & invariants

Minime is a **local-first personal life database with agent access**. It captures the owner's data (journal, decisions, tasks, people, calendar, money, health), stores it queryably on hardware the owner controls, and exposes it to AI agents through one audited door so they can help the owner decide.

Non-negotiable invariants — every PR is checked against these:

- **I1. Local-first.** All storage and indexing happens on the owner's machine. No cloud database, no third-party SaaS API, no telemetry.
- **I2. One door.** Agents reach data only through the Minime MCP server. No agent ever gets a database connection string.
- **I3. Tiered egress.** Every row has a sensitivity tier (0/1/2). Tier 0 content never enters any agent context (aggregates only). Tier 2 requires an explicit, time-boxed, audited unlock.
- **I4. Files are the archive, rows are the state, the database is the index.** Prose lives as markdown in a git repo (`data/brain/`); state lives as rows; Postgres indexes both for search.
- **I5. Provenance everywhere.** Every row records where it came from (`source`), who wrote it (`created_by`: human or agent), and what it was derived from (`derived_from`). Derived content is marked and ranks below primary captures.
- **I6. Numbers via SQL only.** Quantitative answers route through `minime_query_metric` (SQL aggregation). The model never does arithmetic over retrieved prose.
- **I7. Honest answers.** Tool outputs carry source IDs, timestamps, staleness, and explicit gaps, so agent answers can cite and disclose rather than confabulate.
- **I8. Append-only audit.** Every tool call — including reads — writes an `events` row. `events` is never updated or deleted.

## 2. Non-goals (v1)

- No web UI / dashboard (the chat agent is the interface; a CLI exists for ops).
- No live bank/health/email APIs (Plaid, Gmail API, etc.). Mirrors ingest **exported files** only.
- No multi-user, no multi-device sync of the database (the brain git repo may be synced by the owner; the DB lives on one box).
- No cloud LLM calls from Minime itself. Cloud reasoning happens in the *agent* (Claude Code / OpenClaw), which connects as an MCP client.
- No mobile app. Mobile capture = files appearing in `data/inbox/` (owner uses iOS Shortcuts + Syncthing or equivalent; out of scope here).
- No SQLite variant in v1 (deferred, §15).

## 3. Architecture & data flow

```
                        ┌──────────────────────────── owner's box ───────────────────────────┐
  iOS Shortcut /        │                                                                     │
  share sheet ──files──▶│  data/inbox/ ──▶ watcher ──▶ classifier (Ollama, local) ──▶ rows    │
                        │  data/brain/*.md ──▶ brain-sync ──▶ pages + chunks + embeddings     │
  bank CSV, Apple       │  data/mirrors/ ──▶ importers (idempotent) ──▶ mirror tables         │
  Health XML, ICS ─────▶│                                                                     │
                        │           Postgres 16 + pgvector  (rows · edges · chunks · events)  │
                        │                              ▲                                      │
                        │                              │ SQL (server only)                    │
                        │                    Minime MCP server                                │
                        │            (tools · tier enforcement · redaction · audit)           │
                        └──────────────▲───────────────────────────────▲──────────────────────┘
                                       │ MCP (stdio, local)            │ MCP (stdio/HTTP, localhost)
                                Claude Code (interactive)       OpenClaw/Hermes (resident: cron,
                                briefs · decisions · reviews    filing, morning/evening loops)
```

Nightly, a `dream` job runs maintenance: embedding backlog, entity linking, contradiction scan, metric rollups, decision-review scheduling, backups.

## 4. Tech stack (pinned — do not substitute without a `DECISIONS.md` entry)

| Concern | Choice |
|---|---|
| Language / runtime | TypeScript on **Bun** (latest stable) |
| Database | **PostgreSQL 16** + **pgvector**, via Docker Compose |
| DB client | `postgres` (postgres.js), raw SQL; **no ORM** |
| Migrations | Plain numbered `.sql` files in `db/migrations/`, applied by a small runner (`src/db/migrate.ts`), tracked in `schema_migrations` table |
| MCP server | `@modelcontextprotocol/sdk` (TypeScript), stdio transport (HTTP+token optional in M6) |
| Local LLM/embeddings | **Ollama** at `http://localhost:11434`; embeddings: `nomic-embed-text` (**768 dims**); classification: `CLASSIFY_MODEL` env (default `llama3.1:8b`) |
| File watching | `chokidar` |
| Scheduling | `croner` (in-process cron for the resident daemon) |
| Tests | `bun test`; golden files in `fixtures/` |
| Backups | `restic` invoked by the dream job (repo path + password from env) |
| Lint/format | `biome` |

## 5. Repository layout

```
minime/
  README.md  DECISIONS.md  Makefile  .env.example  docker-compose.yml
  db/migrations/                 # 001_… .sql (the schema in §7)
  src/
    db/        client.ts migrate.ts repo.ts      # repo.ts = ONLY place SQL runs; applies tier predicate
    mcp/       server.ts tools/*.ts envelope.ts redact.ts audit.ts
    search/    chunker.ts embed.ts hybrid.ts
    pipeline/  watcher.ts classify.ts brain-sync.ts dream.ts
    importers/ calendar.ts transactions.ts health.ts email-meta.ts
    cli.ts                                    # minime <cmd>: migrate, import:*, sync, dream, serve, verify
  agents/skills/  morning-brief.md  evening-review.md  decision-brief.md
  config/tx-profiles/*.json       # per-bank CSV column mappings
  fixtures/                       # seed data, golden files, eval queries
  data/  inbox/  brain/  mirrors/  archive/    # gitignored except .gitkeep; data/brain is its own git repo
  test/
```

## 6. Configuration (`.env`)

```
DATABASE_URL=postgres://minime:minime@localhost:5432/minime
OLLAMA_URL=http://localhost:11434
EMBED_MODEL=nomic-embed-text        # 768 dims; changing model requires re-embed migration
CLASSIFY_MODEL=llama3.1:8b
TZ=Asia/Singapore
TIER2_UNLOCK_MAX_MINUTES=60
RESTIC_REPOSITORY=/mnt/backup/minime-restic
RESTIC_PASSWORD_FILE=~/.config/minime/restic.pass
DREAM_CRON=0 3 * * *
```

`make up` starts Postgres (+ creates extensions) and checks Ollama availability and required models; `make verify-m0` proves the environment.

---

## 7. Data model (migrations)

Conventions: `uuid` PKs via `gen_random_uuid()`. Every substantive table carries the **standard columns**:

```sql
created_at  timestamptz not null default now(),
updated_at  timestamptz not null default now(),
created_by  text not null default 'human',          -- 'human' | 'agent:<name>' | 'importer:<name>'
source      text not null default 'manual',         -- e.g. 'capture', 'importer:calendar', 'dream'
derived_from uuid,                                   -- set when content was generated from other rows
supersedes_id uuid,                                  -- newer version of an older row
tier        smallint not null                        -- 0 | 1 | 2  (see §12)
```

An `updated_at` trigger function is applied to all tables. Migration files:

**`001_extensions.sql`**
```sql
create extension if not exists vector;
create extension if not exists pgcrypto;
```

**`002_core.sql`** — self-model, state, memory (all include the standard columns; shown abbreviated as `STD`):

```sql
create table values_items ( id uuid primary key default gen_random_uuid(),
  statement text not null, priority int not null default 100, notes text, STD );        -- tier default 1

create table goals ( id uuid pk…, horizon text not null check (horizon in ('life','year','quarter')),
  statement text not null, why text, status text not null default 'active'
    check (status in ('active','achieved','dropped')), parent_id uuid references goals(id), STD ); -- tier 1

create table principles ( id uuid pk…, rule text not null, domain text,
  learned_from_decision uuid, STD );                                                     -- tier 1

create table tasks ( id uuid pk…, goal_id uuid references goals(id), title text not null,
  body text, status text not null default 'inbox'
    check (status in ('inbox','active','waiting','done','dropped')),
  due date, completed_at timestamptz, STD );                                             -- tier 1

create table commitments ( id uuid pk…, what text not null, to_whom text not null,
  due date, status text not null default 'open'
    check (status in ('open','kept','renegotiated','broken')), STD );                    -- tier 1

create table decisions ( id uuid pk…, question text not null, options jsonb not null,
  criteria jsonb, choice text, reasoning text, expected_outcome text,
  decided_at timestamptz, review_at date, actual_outcome text, reviewed_at timestamptz,
  principle_id uuid references principles(id), STD );                                    -- tier 1

create table journal_entries ( id uuid pk…, at timestamptz not null default now(),
  entry_md text not null, mood smallint check (mood between 1 and 5),
  energy smallint check (energy between 1 and 5), STD );                                 -- tier 2

create table people ( id uuid pk…, canonical_name text not null, relation text,
  context text, last_contact_at timestamptz, STD );                                      -- tier 1
create table person_aliases ( person_id uuid not null references people(id),
  alias text not null, primary key (person_id, alias) );

create table interactions ( id uuid pk…, person_id uuid references people(id),
  kind text not null check (kind in ('meeting','call','message','email','note')),
  summary text not null, occurred_at timestamptz not null, STD );                        -- tier 2

create table pages ( id uuid pk…, path text not null unique,   -- relative path in data/brain/
  title text not null, body_md text not null, content_hash text not null,
  status text not null default 'active' check (status in ('active','deleted')), STD );   -- tier from frontmatter, default 1

create table metric_defs ( name text primary key, unit text, description text,
  agg_sql text );   -- whitelisted SQL template used by rollups & query_metric; ONLY path to tier-0 data
create table metric_values ( metric text not null references metric_defs(name),
  period_start date not null, granularity text not null check (granularity in ('day','week','month')),
  value numeric not null, source text not null, computed_at timestamptz not null default now(),
  primary key (metric, granularity, period_start) );                                     -- tier 1
```

**`003_graph_audit.sql`**

```sql
create table edges ( id uuid primary key default gen_random_uuid(),
  src_type text not null, src_id uuid not null, rel text not null,
  dst_type text not null, dst_id uuid not null,
  valid_from date, valid_to date,
  source_table text, source_id uuid,            -- the row this edge was extracted from
  extracted_by text not null default 'human', confidence real not null default 1.0,
  created_at timestamptz not null default now() );
create index on edges (src_type, src_id, rel);
create index on edges (dst_type, dst_id, rel);

create table events ( id bigint generated always as identity primary key,
  at timestamptz not null default now(), actor text not null,      -- 'human' | 'agent:<client>' | 'system:<job>'
  verb text not null,                                              -- 'tool:minime_search', 'write:journal', …
  entity_type text, entity_id uuid, payload jsonb not null default '{}' );
-- append-only: revoke UPDATE, DELETE on events from app role.

create table review_queue ( id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('contradiction','stale','duplicate','decision_review','inbox_unfiled')),
  payload jsonb not null, status text not null default 'open'
    check (status in ('open','resolved','dismissed')),
  created_at timestamptz not null default now(), resolved_at timestamptz );

create table session_unlocks ( id uuid primary key default gen_random_uuid(),
  scope text not null default 'tier2', granted_at timestamptz not null default now(),
  expires_at timestamptz not null, granted_via text not null );
```

**`004_search.sql`**

```sql
create table chunks ( id uuid primary key default gen_random_uuid(),
  parent_type text not null,            -- 'page' | 'journal' | 'interaction' | 'decision' | …
  parent_id uuid not null, ord int not null,
  text text not null, tier smallint not null,
  embed_model text, embedding vector(768),
  tsv tsvector generated always as (to_tsvector('english', text)) stored,
  updated_at timestamptz not null default now(),
  unique (parent_type, parent_id, ord) );
create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_vec_idx on chunks using hnsw (embedding vector_cosine_ops);
```

**`005_mirrors.sql`** — read-only mirrors of exported data:

```sql
create table calendar_events ( id uuid pk…, uid text not null unique, starts_at timestamptz not null,
  ends_at timestamptz, title text not null, location text, attendees jsonb, STD );       -- tier 1

create table transactions ( id uuid pk…, occurred_at date not null, amount_cents bigint not null,
  currency char(3) not null, merchant text, category text, account_label text not null,
  external_ref text not null, unique (account_label, external_ref), STD );               -- tier 0

create table health_samples ( id uuid pk…, kind text not null,                          -- 'sleep_minutes','steps','hr_resting',…
  at timestamptz not null, value numeric not null, unit text not null,
  unique (kind, at, source), STD );                                                      -- tier 0

create table email_meta ( id uuid pk…, message_id text not null unique, at timestamptz not null,
  from_addr text not null, subject text, thread_id text, STD );                          -- tier 2

create table inbox_items ( id uuid pk…, received_at timestamptz not null default now(),
  raw_path text not null, mime text, status text not null default 'pending'
    check (status in ('pending','filed','rejected')),
  filed_table text, filed_id uuid, classifier_output jsonb, STD );                       -- tier 1
```

**`006_seed.sql`** — seed `metric_defs`: `spend_total`, `spend_by_category`, `sleep_minutes`, `steps`, `deep_work_minutes`, `journal_streak`, plus `fixtures/seed.ts` inserting a realistic demo dataset (≈30 pages, 20 journal entries, 10 people, 8 decisions, 200 transactions, 500 health samples) used by tests and the M3 retrieval eval.

---

## 8. MCP server spec (`src/mcp/`)

One server, stdio transport, name `minime`. **All SQL goes through `src/db/repo.ts`**, which appends the tier predicate to every content read: `tier <= allowed_tier()` where `allowed_tier()` is 1, or 2 if a non-expired `session_unlocks` row exists. Tier-0 tables are *not readable as content at all* — they are reachable only through `metric_defs.agg_sql` aggregation.

Every tool call: (a) logs an `events` row — actor (MCP client name), verb, params hash, and the IDs of returned rows (never contents); (b) passes output through `redact.ts` (Luhn-valid card numbers, IBANs, 9+ digit account-like numbers → `[REDACTED:type]`); (c) returns the **envelope**:

```ts
{ data: …,                       // tool-specific payload
  sources: [{type, id, title?, updated_at, created_by, derived: bool}],
  staleness?: string,            // e.g. "newest matching item is 142 days old"
  gaps?: string[] }              // e.g. ["no entries mention 'Tokyo' after 2026-01"]
```

### Tools

| Tool | Input (JSON schema, required*) | Behavior / output `data` |
|---|---|---|
| `minime_search` | `query*`, `types?: string[]`, `limit?=10`, `include_derived?=false` | Hybrid search (§9) over `chunks` joined to parents. Returns hits `{type,id,title,snippet,score,updated_at,derived}` + envelope. |
| `minime_get_context` | `type*`, `id*` — or `person_name*` | Resolve entity (aliases included); return the row, related rows via `edges` and FKs (recent 20), open items, and provenance. Compute `staleness`/`gaps`. |
| `minime_state` | — | Snapshot: today+tomorrow `calendar_events`; `tasks` due/overdue; `commitments` open; `decisions` with `review_at <= today+3`; `review_queue` open count; metric anomalies (latest value vs trailing-28-day mean ± 2σ, from `metric_values` only). |
| `minime_query_metric` | `name*`, `from*`, `to*`, `granularity?` | Read `metric_values`; if missing periods, compute via `metric_defs.agg_sql` (parameterized, never string-interpolated). Returns series + unit. **Only path to numbers.** |
| `minime_capture` | `text*`, `hint?` | Write raw text to `data/inbox/` and an `inbox_items` row; watcher files it. Returns `inbox_item_id`. |
| `minime_journal` | `entry_md*`, `mood?`, `energy?`, `at?` | Insert `journal_entries` (tier 2) + chunks. |
| `minime_log_decision` | `question*`, `options*`, `criteria?`, `choice?`, `reasoning?`, `expected_outcome?`, `review_in_days?=90` | Insert `decisions`; sets `review_at`. If `choice` is null the decision is "open" and appears in `minime_state`. |
| `minime_review_decision` | `decision_id*`, `actual_outcome*`, `lesson?` | Set outcome + `reviewed_at`; if `lesson`, insert `principles` row with `learned_from_decision`, link back. |
| `minime_upsert_task` | `id?`, `title*`, `status?`, `due?`, `goal_id?` | Insert/update task. |
| `minime_log_interaction` | `person_name*`, `kind*`, `summary*`, `occurred_at?` | Resolve/create person (+alias), insert interaction (tier 2 — write allowed without unlock; reads are gated), update `last_contact_at`, add `edges` row. |
| `minime_unlock` | `minutes*` (≤ `TIER2_UNLOCK_MAX_MINUTES`) | Insert `session_unlocks`; log loudly. Tier 0 is **never** unlockable. |

Writes from agents set `created_by='agent:<client>'` automatically. Any tool may refuse with a structured error `{code, message}` — e.g. `TIER_LOCKED`, `UNKNOWN_METRIC`.

## 9. Hybrid search spec (`src/search/`)

- **Chunking:** markdown-aware; target 250–400 tokens, 40-token overlap; headings prepended to chunk text. Re-chunk when `content_hash` changes.
- **Embedding:** Ollama `EMBED_MODEL`, batch ≤ 32, store model name per chunk. Missing embeddings = backlog drained by `dream` (and `make embed`).
- **Query path:** filter (`tier <= allowed`, optional `types`) → candidates = top-50 by cosine ∪ top-50 by `ts_rank_cd` → score each candidate:

```
score = 0.55·cosine_norm + 0.30·fts_norm + 0.10·recency + 0.05·graph_boost
recency  = exp(-age_days/180)
graph_boost = 1 if chunk's parent is within 1 edge hop of an entity literally named in the query, else 0
if derived_from is set and !include_derived → score ×= 0.85
```

- Dedupe to best chunk per parent; return top `limit` with snippets (±1 sentence around best match).
- Weights are starting values; tune only against the M3 eval, record changes in `DECISIONS.md`.

## 10. Pipelines (`src/pipeline/`, `src/importers/`)

**Watcher** (`minime serve` runs it alongside MCP): chokidar on `data/inbox/`. New file → copy original to `data/archive/YYYY/MM/` → create `inbox_items` → classify via Ollama with a strict-JSON prompt returning `{type: task|journal|interaction|note|decision_note|unknown, confidence, fields}` → if `confidence ≥ 0.7`, insert the typed row (`source='capture'`, `created_by='agent:classifier'`, `derived_from=inbox_item`), chunk+embed, mark `filed`; else leave `pending` and add `review_queue(kind='inbox_unfiled')` for the evening review.

**Importers** — CLI verbs, all **idempotent** (natural-key upsert, re-running an export is a no-op), all stamping `source='importer:<name>'`:
- `minime import:calendar <file.ics>` → `calendar_events` by `uid`.
- `minime import:transactions <file.csv> --profile <bank>` → mapping from `config/tx-profiles/<bank>.json` (column names, date format, sign convention); dedupe on `(account_label, external_ref)` or row-hash fallback.
- `minime import:health <export.xml>` → stream-parse Apple Health export; whitelist of `kind`s; dedupe on `(kind, at, source)`.
- `minime import:email-meta <Maildir/>` → headers only (From, Date, Subject, Message-ID, thread); bodies are never stored in v1.

**Brain sync** — `minime sync`: walk `data/brain/**/*.md`; frontmatter `title`, `tier?`, `status?`; upsert `pages` by `path` (hash-diff), soft-delete missing files, re-chunk changed pages.

**Dream** (`minime dream`, cron `DREAM_CRON`): in order — (1) drain embedding backlog; (2) entity-link pass: scan new chunks for `people.canonical_name`/aliases, write `edges` (`extracted_by='system:dream'`, confidence 0.8); (3) contradiction scan: for entity pairs of claims touching the same person/topic, ask local model "do these conflict?" → `review_queue(kind='contradiction')` — **flag, never auto-resolve**; (4) staleness: pages/people untouched > 180 days referenced this week → `review_queue(kind='stale')`; (5) metric rollups from `metric_defs.agg_sql` into `metric_values`; (6) enqueue `decision_review` items where `review_at <= today`; (7) `restic backup data/ db-dump/` (pg_dump first), prune per policy `--keep-daily 7 --keep-weekly 8 --keep-monthly 24`; (8) write a `system:dream` summary event.

---

## 11. Agent skills (`agents/skills/*.md`) — deliverables, not code

Markdown prompt files the owner pastes into Claude Code / OpenClaw. Each states which tools to call and the **answer rules** (cite source IDs, disclose `gaps` and `staleness`, numbers only via `minime_query_metric`, prefer primary over derived, never present inference as memory).

- **morning-brief.md** — call `minime_state`; produce a ≤200-word brief: today's calendar, due tasks/commitments, decision reviews due, metric anomalies. No fluff, no advice unless asked.
- **evening-review.md** — a 5-minute conversation: ask (1) how did today go → `minime_journal`; (2) anything decided? → `minime_log_decision`; (3) anything promised? → commitments via `minime_upsert_task`/`minime_log_interaction`; then triage `review_queue` inbox_unfiled items.
- **decision-brief.md** — given a question: `minime_search` for similar past decisions **and their actual_outcome**, relevant `principles`, `minime_get_context` on involved people, `minime_state` for load, `minime_query_metric` for any numbers; output options × criteria, what past-you learned, what's unknown. End by offering `minime_log_decision`.

## 12. Privacy & security spec

- **Tiers.** 0 = contents never leave the DB (transactions, health_samples); aggregates only via `metric_defs.agg_sql`. 1 = agent-readable default (tasks, goals, values, principles, decisions, people, pages, calendar, metric_values, inbox). 2 = unlock required to **read** (journal_entries, interactions, email_meta); writes allowed without unlock.
- **Enforcement layers:** (a) `repo.ts` predicate on every read; (b) Postgres **row-level security** as belt-and-braces in M6 — app role `minime_app` with RLS policies mirroring the tier rules; tier-0 tables get `SELECT` revoked from `minime_app` except via `security definer` aggregate functions generated from `metric_defs`.
- **Redaction** on every outbound string (§8). **Audit** via `events` incl. reads. `minime audit --since 7d` CLI prints which rows left the box, to which client, when.
- **At rest:** rely on full-disk encryption (owner's responsibility, documented in README); `RESTIC_PASSWORD_FILE` perms 0600; `.env` never committed.
- **Threat model honesty (README section):** anything an agent reads transits that agent's model provider. Tiers minimize and audit that surface; they don't eliminate it.

## 13. Milestones & acceptance criteria

Each milestone ships a `make verify-mN` target; AC = what that target proves.

**M0 — Environment.** Compose file (Postgres16+pgvector), Ollama check script, migration runner, CI (offline). *AC:* `make up && make verify-m0` → DB reachable, extensions present, required Ollama models listed (or mocked in CI).

**M1 — Schema + seed.** All §7 migrations; seed dataset; `updated_at` triggers; events append-only enforced. *AC:* migrations apply cleanly twice (idempotent runner); inserting/updating/deleting an `events` row as app role fails; seed loads; one round-trip test per table.

**M2 — MCP core.** Server with `search` (FTS-only for now), `state`, `capture`, `journal`, `log_decision`, `upsert_task`, `query_metric` (over seeded `metric_values`); envelope, audit, redaction. *AC:* scripted MCP client (test harness) exercises every tool; every call produced an `events` row; redaction test (fixture with a card number) passes; Claude Code connects via `claude mcp add minime -- bun run src/cli.ts serve` (manual check, documented).

**M3 — Hybrid search.** Chunker, embeddings (mock Ollama in CI with deterministic vectors), fusion scoring, `include_derived`. *AC:* retrieval eval — `fixtures/eval-queries.json` (25 queries → expected parent IDs over the seed corpus): expected hit in top-5 for ≥ 80%; derived-penalty and tier-filter unit tests pass.

**M4 — Capture + importers.** Watcher + classifier (mocked in CI), 4 importers with golden-file tests. *AC:* each importer run twice on the same fixture yields identical row counts (idempotency); malformed-row handling logged not fatal; an inbox text file becomes a filed task in the e2e test.

**M5 — Decision engine.** Open decisions in `state`, review scheduling, `review_decision` → principle creation; fake-clock test utilities. *AC:* e2e — log decision with `review_in_days=1`, advance clock, `state` shows review due, review it with a lesson, principle exists and `minime_search "lesson topic"` finds it.

**M6 — Trust & ops.** Tier-2 unlock flow, RLS hardening, dream job (all 8 steps), restic backup + **restore drill script** (`make restore-drill` restores latest snapshot into a scratch DB and runs verify-m1 against it), `minime audit`. *AC:* **leak test suite** — 200 fuzzed tool calls (incl. SQL-injection-shaped metric names, sneaky search queries, tier-2 reads without unlock) return zero tier-0 content and zero tier-2 content while locked; unlock expiry honored; restore drill green.

**Definition of done (whole project):** all verify targets green; `README.md` covers install on a fresh box in ≤ 15 steps; `agents/skills/` files tested manually with Claude Code; `DECISIONS.md` current.

## 14. Working conventions for the coding agent

- TDD where cheap: write the verify target's failing test first for each AC.
- Plain SQL strings live only in `repo.ts`, migrations, and `metric_defs.agg_sql`. Everything is parameterized; string-interpolated SQL is a review-blocker.
- Keep functions under ~60 lines; no clever metaprogramming; comments explain *why*, not *what*.
- Fixtures are realistic but fictional — never use the owner's real data in tests.
- Update this plan only via `DECISIONS.md` entries; the spec stays the source of truth.

## 15. Deliberately deferred (do not build in v1)

SQLite/SQLCipher single-file variant · email body indexing · voice transcription · photo/location ingestion · web dashboard · multi-device DB sync · HTTP MCP with OAuth for remote agents · automatic principle suggestion from journal patterns · wiki-style consolidated entity pages (the "materialized view" layer — design exists, build after a month of real data).
