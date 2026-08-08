# Minime

A **local-first personal life database with agent access**. Your journal, decisions, tasks,
people, calendar, money and health — stored queryably on hardware you control, exposed to AI
agents through one audited MCP door so they can help you decide.

Development: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · Guardrails: [CLAUDE.md](CLAUDE.md) ·
Original v1 plan: [minime-build-plan.md](minime-build-plan.md)

## What's new in this release (August 2026)

This is primarily a trust, durability, and time-correctness release. The public MCP surface remains
small—14 functions—but the paths behind it are substantially stronger:

- **Owner-approved private reads.** `minime_unlock` now creates a pending request that must be
  approved locally, expires quickly, is bound to one MCP connection, and never opens tier 0.
- **Durable, replay-safe capture.** Every inbox item has an immutable byte identity. Replaying the
  same file is idempotent; changed bytes at the same path create a new version; concurrent watcher
  and agent captures converge without duplicate derivatives.
- **Privacy-preserving derived knowledge.** People, organizations, aliases, and graph relations
  inherit the strictest source tier and provenance instead of becoming less-private facts.
- **Timezone-correct life data.** Calendar `TZID`, floating, UTC, and all-day events are interpreted
  explicitly. Metrics, decision reviews, “today,” resident jobs, and anomaly caches use declared
  calendar zones and DST-safe day arithmetic.
- **Auditable least privilege.** The MCP process receives a restricted database login and a small
  environment allowlist. Tool attempts, results, delivery disposition, and cloud egress are recorded
  without storing prompts, secrets, or returned content in the audit payload.
- **Truthful recovery.** Restores prove the selected restic snapshot's dump hash, migration ledger,
  and representative counts in a scratch database. Promotion is a separate owner action with a
  safety dump, guarded two-step cutover, and compensation if the second rename fails.
- **Reproducible lifecycle.** Install and update share one offline verification path, pin the exact
  Bun version, remember the selected PostgreSQL backend and port, and safely resume an interrupted
  first install without adopting another local database.

The detailed implementation and remaining owner-only actions are tracked in
[docs/REMEDIATION.md](docs/REMEDIATION.md).

## What data can Minime save?

| Area | Saved data | Ways in | Default access |
|---|---|---|---|
| Self-model | Profile notes, values, life/year/quarter goals, principles | `make onboard`, inbox extraction | Tier 1 |
| Plans and obligations | Tasks, due dates, status, commitments, project/reference pages | Inbox, `minime_upsert_task`, Markdown sync | Tier 1 |
| Knowledge archive | Text/Markdown notes, ideas, reading notes, agent-session summaries, searchable chunks | `data/brain/`, `data/inbox/`, `minime_capture`, optional session hook | Tier 1, or inherited source tier; session summaries are tier 2 |
| People and organizations | Canonical names, aliases, relationship context, last contact, typed graph relations | Inbox extraction, notes, `minime_log_interaction` | Tier 1, or stricter inherited source tier |
| Interactions | Meetings, calls, messages, email interactions, private notes and dates | `minime_log_interaction`, inbox | Tier 2 |
| Decisions | Question, options, criteria, choice, reasoning, confidence, expected outcome, review date, transcript, branches, actual outcome, lessons | Decision interview, `minime_log_decision`, `minime_review_decision` | Tier 1 unless raised by private evidence |
| Journal | Markdown entry, timestamp, optional mood and energy (1–5) | `minime_journal`, inbox | Tier 2 |
| Calendar | Event UID, title, start/end, location, attendees, timezone semantics | Idempotent `.ics` import | Tier 1 |
| Money | Date, amount, currency, merchant, category, account label, external reference | Profile-driven CSV import | Tier 0: aggregate answers only |
| Health | Timestamped numeric samples such as sleep, steps, and resting heart rate | Apple Health XML import | Tier 0: aggregate answers only |
| Email | Message ID, date, sender, subject, and thread ID—**never message bodies** | Maildir metadata import | Tier 2 |
| Operational history | Append-only tool/egress audit, review queue, source provenance, derived metric buckets | Recorded automatically | Content-minimized; maintenance-controlled |

Privacy tiers are monotonic: derived rows inherit stricter evidence, tier 2 needs a local owner
approval to read, and tier 0 rows are never returned to an agent under any configuration.

## Install (one command)

```
git clone https://github.com/HengL2022/Minime minime && cd minime && bash scripts/install.sh
```

Non-interactive, safe to re-run, installs everything missing (bun, Postgres+pgvector via
Docker/brew/apt, Ollama + models), migrates, verifies, and prints how to register the MCP
server. Add `--with-demo` for a fictional dataset to explore. Full contract — flags,
degraded modes, machine-parsable output for coding agents — in [AGENTS.md](AGENTS.md).

**Agent orientation after install:** before using Minime MCP tools, an AI harness should read
[agents/skills/RESOLVER.md](agents/skills/RESOLVER.md), then read the specific skill file it
routes to. The resolver is the agent-facing map for what to use: query, graph-query,
person-brief, capture, review-triage, morning-brief, evening-review, decision-brief, and
decision-interview. For decisions, use [decision-brief](agents/skills/decision-brief.md) to
retrieve past context before choosing, and [decision-interview](agents/skills/decision-interview.md)
to log the six-question raw transcript plus structured fields. If the harness knows the
owner's current IANA timezone, include `time_zone` on MCP calls; Minime stores canonical
timestamps but interprets "today" and date-only inputs in that timezone and renders timestamp
outputs with that timezone's offset.

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

1. Install the exact [Bun](https://bun.sh) version recorded in `.bun-version`.
2. Install Docker (preferred) — or natively: `brew install postgresql@17 pgvector` (macOS)
   / `apt-get install postgresql-16 postgresql-16-pgvector` from PGDG (Debian/Ubuntu).
3. Install [Ollama](https://ollama.com) and start it.
4. `ollama pull nomic-embed-text && ollama pull llama3.1:8b`
5. Clone this repo; `cd minime`.
6. `bun install --frozen-lockfile`
7. Optionally run `make setup` to prepare `.env` provider/backup choices.
8. Run `bash scripts/install.sh --skip-verify` (add `--native` or `--no-ollama` if wanted) for
   the first database bootstrap. It persists the selected backend/port, creates the databases and
   extensions, applies migrations, and provisions the restricted resident role. `make up` is only
   for an already-installed backend and deliberately refuses a setup-only or interrupted-bootstrap
   `.env`; after any interruption, rerun `scripts/install.sh` to resume the exact persisted target.
9. (optional) `bun run src/cli.ts seed` — loads a fictional demo dataset to explore with.
10. `make verify-offline` — run the fast offline development gate end to end.
11. Register the MCP server with your agent:
    `claude mcp add minime -- bun run /absolute/path/to/minime/src/cli.ts serve`

</details>

After install (optional): install `restic` + set `RESTIC_REPOSITORY`/`RESTIC_PASSWORD_FILE`
for backups; run `bun run src/cli.ts serve` under launchd/systemd for resident mode; load
the `agents/skills/` prompts into your agent — `RESOLVER.md` routes requests to the right
skill (query, graph-query, person-brief, capture, review-triage, morning-brief,
evening-review, decision-brief, decision-interview).

## Daily use

**New here?** Run `make onboard` — a 5-minute interview that seeds your values, goals,
principles, key people, and current projects, so your agents have something to work with
from day one. Then read the [owner's guide](docs/GUIDE.md) — how to capture notes and
ideas, journal, log decisions, import your data, and build the habits that make it
compound.

```
make onboard                        # first-run interview (optional, skippable, re-runnable)
make update                         # pull the latest version — never touches .env or data
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

## Agent functions and release changes

One new top-level MCP function was added in this release: `minime_list_metrics`, which lists
every queryable metric (name, unit, description, rollup) with no SQL exposed, so agents can find
a valid metric name before calling `minime_query_metric`—the same tool `UNKNOWN_METRIC` errors
now point to. The public set is now the 14 functions below. Several other contracts changed in
ways clients should notice:

- `minime_unlock` now returns a pending request and a local approval command instead of unlocking
  immediately.
- `minime_capture` returns an `inbox_item_id`, not a host filesystem path.
- `minime_log_interaction` returns only the interaction ID; it no longer reveals person/org IDs or
  whether those rows were created or reused.
- `minime_get_context` now includes complete edge provenance, and `minime_query_metric` now applies
  the caller's timezone plus the metric's declared rollup rule.

The new owner-side entry points are `bun run src/cli.ts unlock:approve <request-id>` and
`make verify-restore-e2e`.

| MCP function | What it does |
|---|---|
| `minime_search` | Hybrid-searches readable notes and structured memory with source citations. |
| `minime_get_context` | Returns one entity plus readable relations, tasks, commitments, and exact provenance. |
| `minime_state` | Builds a today-oriented snapshot: calendar, tasks, commitments, reviews, anomalies, and queue counts. |
| `minime_list_metrics` | Lists every queryable metric—name, unit, description, rollup—with no SQL exposed; call before `minime_query_metric` when unsure of a name. |
| `minime_query_metric` | Computes allowlisted numeric series in the caller's timezone; the only aggregate path to tier-0 data. |
| `minime_capture` | Durably allocates and publishes an immutable text/Markdown inbox capture. |
| `minime_journal` | Writes a private journal entry with optional mood and energy. |
| `minime_log_decision` | Saves a decision, its options/reasoning, review date, branches, and optional interview transcript. |
| `minime_review_decision` | Records the actual outcome and can turn a learned lesson into a linked principle. |
| `minime_upsert_task` | Creates or updates a task with status, due date, body, provenance, and optional recurrence (auto-materializes its next instance on completion). |
| `minime_agenda` | Lists forward-looking tasks over a caller-zone date window. |
| `minime_log_interaction` | Records a person/org interaction and updates relationship recency. |
| `minime_review_queue` | Lists review flags and marks them resolved or dismissed; it never edits the flagged source rows. |
| `minime_unlock` | Requests a time-boxed tier-2 read; the owner must approve it in a local terminal. |

## Architecture (short version)

- **Files are the archive, rows are the state, Postgres is the index.** Curated prose lives in
  the gitignored Markdown archive at `data/brain/`; run `bun run src/cli.ts sync` after direct
  edits. Structured state lives as rows; everything is chunked, embedded (local Ollama) and
  hybrid-searchable.
- **One door.** Agents only reach data through the `minime` MCP server. `serve` supervises an
  app-only stdio child, so the MCP-reachable process never receives the owner database or backup
  credential. Every call is audited to an append-only `events` table; outputs are redacted and
  wrapped in an envelope carrying sources, staleness and gaps.
- **Tiers.** 0 = never leaves the DB (transactions, health) — aggregates only via whitelisted
  SQL in `metric_defs.agg_sql`. 1 = agent-readable default. 2 = journal/interactions/email
  metadata — reads require an owner-approved, time-boxed unlock bound to the current MCP
  connection; `minime_unlock` creates the pending request and the owner activates it locally with
  `bun run src/cli.ts unlock:approve <request-id>` within 10 minutes. Writes are always allowed.
- **Numbers via SQL only.** Quantitative answers route through `minime_query_metric`; the
  model never does arithmetic over prose. A call's `time_zone` controls live day buckets;
  weekly/monthly rollups follow each metric's declared `sum` or `last` rule. Only the trusted
  nightly job persists the configured-owner-timezone cache used by state anomalies. The cache
  records that timezone identity, rebuilds atomically when it changes, and reconciles mutable
  source windows without overwriting manual values.

## Verification

```
make verify-offline # fast offline development gate: mocked M0, full tests, lint, typecheck, subsystem check
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
make verify      # release/search gate: offline gate + retrieval regression (eval-search)
make verify-restore-e2e  # isolated fictional-data Postgres + real restic round trip
make restore-drill  # restore the latest configured restic snapshot into scratch and validate it
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

**MinimeBench** — eight in-house areas with committed bars, run live before search releases
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
push (`make eval-search` vs committed floors), fictional corpora, and N=3 live runs for search
releases — scorecards
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
