# Minime — agent install & operations contract

Minime is a local-first personal life database with MCP agent access. All data stays on this
machine (localhost Postgres + localhost Ollama only); anything an agent reads transits that
agent's model provider — tiered access minimizes and audits that surface.

## Install (one command, non-interactive)

```
git clone https://github.com/HengL2022/Minime minime && cd minime && bash scripts/install.sh
```

- **Safe to re-run** after any failure — every step detects before acting.
- Never prompts. On Linux, package installs need root or passwordless sudo
  (exit 4 tells you exactly what to do otherwise). macOS needs Homebrew or Docker.
- Disk: ~6 GB with the local models, ~300 MB without (`--no-ollama`).
- `make install` is an alias.

### Flags & knobs

| Flag | Effect |
|---|---|
| `--with-demo` | Load the fictional demo dataset (off by default — this is a personal database) |
| `--no-ollama` | Skip the LLM stack → degraded mode (see below) |
| `--skip-verify` | Skip the post-install verification suite |
| `--native` | Select native Postgres on first install even when Docker is available |
| `--dry-run` | Print what would happen; only read-only detection runs |

| Env var | Default | Meaning |
|---|---|---|
| `MINIME_PG_BACKEND` | auto-detect once | First-install choice (`native` or `docker`); installer persists it in `.env` |
| `MINIME_PG_PORT` | 5432 | First-install host port (1–65535); installer persists it in `.env` |
| `MINIME_PULL_TIMEOUT` | 2400 | Seconds before a model pull degrades instead of blocking |
| `MINIME_PULL_MODELS` | both models | Override which Ollama models to pull |
| `OLLAMA_URL` | http://localhost:11434 | Existing Ollama server to use |

OLLAMA_URL is loopback-only. Minime validates it before every CLI/install/up action, connects
directly without proxy environment or DNS for localhost, and never follows redirects.
HTTPS/base-path endpoints are treated as existing local proxies; Minime will not launch a
different plain ollama serve for them. Remote inference uses an explicit cloud provider.

Postgres backend, port, and the exact owner `DATABASE_URL` are one persisted lifecycle identity.
Install, `make up`, and `make down` reuse it; reruns do not switch merely because Docker later
appears or disappears. Invalid, remote, split, or ambiguous legacy state fails before database
actions and never prints credentials. Before first bootstrap, the installer records the exact
identity with an internal `MINIME_PG_INSTALL_PENDING=1` marker and clears it only after both
databases, extensions, role ownership, and exact credentials pass. If interrupted, rerun the
installer; daily start, update, migrate, and serve deliberately refuse pending state.

## Reading the output

One line per step: `[N/9] OK|SKIP|WARN|FAIL <step>: <detail>`. On failure the **last two
lines** are always `ERROR: <sentence>` and `FIX: <copy-pasteable command>`.

Exit codes: `0` installed (parse `status:` below), `2` bad flag, `3` unsupported OS,
`4` root needed, `10` bun, `11` deps, `20–24` postgres, `40` env, `50` migrate,
`60` seed, `70` verify.

Final block is machine-parsable — **parse `status:` from it**:

```
==== MINIME INSTALL SUMMARY ====
status: ok | degraded
postgres: docker pg16 @ 127.0.0.1:5432
ollama: ok (nomic-embed-text,llama3.1:8b)
demo: seeded | not requested
verify: pass | pass-degraded | skipped
mcp: .mcp.json (in-repo) — see AGENTS.md to register elsewhere
first-run: bun run src/cli.ts onboard   (5-min interview: seed your values, goals, people)
next: bun run src/cli.ts serve
================================
```

## Degraded mode (status: degraded)

Everything works without Ollama except two features:

| Missing | Effect | Recover |
|---|---|---|
| Embedding model | Search falls back to full-text only (no semantic matches) | `ollama pull nomic-embed-text && make embed` |
| Classify model | Inbox captures queue for manual review instead of auto-filing | `ollama pull llama3.1:8b` |
| Docker | Native Postgres instead: PG16 via PGDG on Linux, PG17 via Homebrew on macOS | nothing to do |

OLLAMA_URL is loopback-only. Minime validates it before every CLI/install/up action, connects
directly without proxy environment or DNS for localhost, and never follows redirects.
HTTPS/base-path endpoints are treated as existing local proxies; Minime will not launch a
different plain ollama serve for them. Remote inference uses an explicit cloud provider.

## Cloud LLM providers (optional, instead of Ollama)

The three internal model jobs (embeddings, inbox classification, contradiction scan) default
to local Ollama but can route to cloud providers — set in `.env` and skip Ollama entirely
(`--no-ollama` at install):

| Provider | `CLASSIFY_PROVIDER` | `EMBED_PROVIDER` | Required env |
|---|---|---|---|
| Ollama (default) | ✓ | ✓ | — |
| Anthropic | ✓ (`ANTHROPIC_MODEL`, default claude-opus-4-8) | — | `ANTHROPIC_API_KEY` |
| OpenAI | ✓ (`OPENAI_MODEL`) | ✓ (text-embedding-3-* @ 768 dims) | `OPENAI_API_KEY` |
| OpenRouter | ✓ (`OPENROUTER_MODEL`) | ✓ (`OPENROUTER_EMBED_MODEL`, default qwen/qwen3-embedding-8b @ 768 dims) | `OPENROUTER_API_KEY` |
| Bedrock (IAM) | ✓ (`BEDROCK_MODEL`, required) | — | resident: `BEDROCK_AWS_ACCESS_KEY_ID`, `BEDROCK_AWS_SECRET_ACCESS_KEY`, `BEDROCK_AWS_REGION` |

**Switching the embedding provider/model invalidates existing vectors** (different models =
different vector spaces). After changing `EMBED_PROVIDER`/`*_EMBED_MODEL`, run
`bun run src/cli.ts reembed` (wipes and re-embeds every chunk; wrong-dimension responses are
rejected loudly, never stored). After a chunker or span-schema change, `bun run src/cli.ts rechunk`
rebuilds children from each parent row (and re-embeds). Live rechunk stays owner-scheduled.

Privacy contract: cloud providers receive content up to `CLOUD_MAX_TIER` (default 1; tier-0
financial/health content **never** leaves the box on any path). Every cloud call first commits an
audited intent row (`egress:embed` / `egress:classify` / `egress:describe`), then appends a fixed
success/failure outcome; both contain counts and routing metadata, never contents, and the intent
survives a later handler rollback. Image describe is local-only (Ollama `VLM_MODEL`); a cloud
`VLM_ROUTE_*` is rejected at startup. Default image routing is tier-2-like. They are visible via `bun run src/cli.ts audit`. Mixed setups work (e.g.
classify via Anthropic, embed via local Ollama). Embeddings are pinned to 768 dims by the schema,
hence the embed column above.

**Per-tier routing (W3):** `PROVIDER_ROUTE_TIER1` / `PROVIDER_ROUTE_TIER2` override
`CLASSIFY_PROVIDER` for content of that tier (embeddings are NOT tier-routable — one vector
space per index). Routes may only be stricter than `CLOUD_MAX_TIER`; violations fail at
startup when an explicit per-tier route violates the ceiling. An implicit cloud fallback
above the ceiling may remain configured so the local daemon can run in degraded/manual-review
mode; every effective classification job rejects before provider construction, audit, or
network fetch. Classify egress from the tier-routed pipeline call sites carries the resolved
`route_tier` (embed and script-driven classify egress carry none). Raw inbox captures (tier
unknown until classified) route as tier 2.

## Register the MCP server

The server is stdio: `bun run <ABS_REPO_PATH>/src/cli.ts serve`. The command keeps owner-only
maintenance in a supervisor and starts the inbox watcher plus MCP transport in a scrubbed
app-role child; the MCP-reachable process does not receive the owner DB or backup credential.
The child starts without repository dotenv loading and receives only an explicit runtime-setting
allowlist plus credentials for providers selected by its active routes; ambient tokens, proxy
variables, debug flags, and unused provider credentials are not forwarded. Provider names are
exact lowercase enum values; whitespace, case variants, and unknown values fail closed before the
child starts.
Use **absolute paths** outside the repo.
Backup-only B2/AWS credentials stay in the supervisor. Bedrock uses separate `BEDROCK_AWS_*`
variables and must be given a Bedrock-scoped IAM principal, never an S3-backup-capable key.

- **Claude Code, inside the repo**: `.mcp.json` is auto-discovered — just start Claude Code
  in this directory.
- **Claude Code, global**: `claude mcp add minime -- bun run <ABS_REPO_PATH>/src/cli.ts serve`
- **Any other MCP harness** (Hermes/OpenClaw/Cursor-style):
  ```json
  { "command": "bun", "args": ["run", "<ABS_REPO_PATH>/src/cli.ts", "serve"] }
  ```

The default archive is always the physical <ABS_REPO_PATH>/data, even when the MCP host
launches Minime through a repository symlink or
from another cwd. MINIME_DATA_DIR may be absolute or repository-relative. Persistent
pg_dump/pre-image files are always staged in <ABS_REPO_PATH>/db-dump; restore extraction
uses private temporary workspaces; cleanup is installed and attempted on every normal,
failure, and signal exit and succeeds normally. If a persistent OS/trusted-rm refusal
prevents deletion, the command fails with fixed content-free `cleanup_failed` and may leave
only the validated private mode-0700 workspace/mode-0600 artifact for owner recovery.
Service files are not guaranteed removed under that refusal; no path, URL, child output, or
secret is printed. pg_dump credentials use short-lived mode-0600 libpq service files, never
database URLs on argv or in PGDATABASE. Before replacement, backup retains a verified private
`.previous` dump+manifest pair; the new dump and manifest are each fsynced and atomically renamed.
Recovery commands parse `.env` as inert data in a TypeScript wrapper and pass only an allowlisted
environment to the maintained shell scripts; caller values take precedence and `.env` is never
sourced as shell. `make restore-drill` requires a real restic snapshot and labels its source.
Restore verifies the exact pair, rejects any non-local or wrongly named target before database
commands, checks the snapshot ledger/counts, migrates only the scratch database to the checked-out
ledger, and verifies the current safety posture. `make verify-restore-e2e` proves that path in an
isolated fictional-data PostgreSQL cluster and local restic repository. Output uses fixed
content-free failures and never prints live or restore connection URLs.
Promotion is a separate owner action: it requires idle live/restore databases with no prepared
transactions, writes a private live safety dump, blocks connections, and performs a guarded
two-step rename. A failed second rename is compensated back to `minime`; a successful cutover
retains the prior database as connection-blocked `minime_replaced`. A `compensation_failed`
result requires owner inspection before retry.
Changing MINIME_DATA_DIR does not move existing data.

22 tools: `minime_search`, `minime_get_context`, `minime_state`, `minime_list_metrics`,
`minime_query_metric`, `minime_capture`, `minime_journal`, `minime_log_decision`,
`minime_review_decision`, `minime_upsert_task`, `minime_agenda`, `minime_log_interaction`,
`minime_review_queue`, `minime_refile`, `minime_correct`, `minime_unlock`,
`minime_upsert_person`, `minime_set_person_date`, `minime_timeline`, `minime_upsert_goal`,
`minime_upsert_commitment`, `minime_log_expense`. `minime_list_metrics` lists every queryable
metric (name, unit, description, rollup) with no SQL exposed — call it before
`minime_query_metric` when unsure of a metric name; `UNKNOWN_METRIC` errors point here too.
Numbers come only from `minime_query_metric`. `minime_timeline` is the exhaustive date-range
read; `minime_search`'s optional `from`/`to` only filters already-ranked candidates.
`minime_refile` files a pending capture as a typed row (task, journal, note, interaction,
decision, org, or person) and always needs an approved tier-2 unlock. `minime_correct` amends, retracts, or retiers a journal/interaction/decision/note.
`minime_upsert_person` / `minime_set_person_date` / `minime_upsert_goal` /
`minime_upsert_commitment` write those objects; identity merges stay owner-run
(`scripts/repair.ts merge-person`). `minime_log_expense` is insert-only into tier 0 and never
echoes the row back. Tier-2 reads (journal, interactions, email metadata, private decisions)
need an owner-approved unlock. After the agent asks and the owner agrees, `minime_unlock`
creates a pending request and returns its ID and local approval command. The owner runs
`bun run src/cli.ts unlock:approve <request-id>` in their own terminal within 10 minutes
(`unlock:status` / `unlock:revoke` list or end approvals). Approval is time-boxed, loudly
audited, bound to the current unguessable MCP connection session, and a reconnect is locked
again. Tier-0 transactions and health data are never readable through MCP — aggregates only;
the owner terminal may print them with `tx list` / `health list`.

Before using Minime MCP tools, agent harnesses should read
`agents/skills/RESOLVER.md`, then read the specific skill file it routes to. The resolver is
the map for what to use: query, graph-query, person-brief, capture, review-triage,
morning-brief, evening-review, decision-brief, and decision-interview. For decision work,
use `agents/skills/decision-brief.md` to retrieve past context before choosing, and
`agents/skills/decision-interview.md` to log the six-question raw transcript plus structured
decision fields. All tools accept optional `time_zone` (IANA name, e.g.
`America/Los_Angeles`) when the harness knows the owner's current timezone; Minime stores
canonical timestamps but interprets "today" and date-only inputs in that timezone and renders
timestamp outputs with that timezone's offset.
Calendar import additionally preserves UTC/`TZID`, treats floating and all-day values in the
configured owner timezone, and rejects invalid calendar values rather than normalizing them.
Metric day buckets use the MCP call timezone; only the owner-side dream job persists rollups in
the configured timezone. That cache records its timezone identity, rebuilds atomically when the
identity changes, and reconciles mutable source windows without overwriting manual values. Dream
and backup cron expressions are also evaluated in that configured timezone, independent of the
process timezone.

## Engineering access (W4)

Engineering sessions — an agent poking at the database directly, not through the MCP tools —
never connect as the full-rights owner role. Ad-hoc reads use the SELECT-only login role
`minime_engineer_ro` via the committed `.env.engineering` DSN: `make psql-ro`. The role is
permanently capped at tier 1: it cannot request, inspect, inherit, or replay a tier-2 unlock.
Tier-2 engineering reads go only through the normal MCP owner-approved session path. Tier-0
tables — `transactions`, `health_samples` — are revoked outright (I3), and the role holds no
INSERT/UPDATE/DELETE/TRUNCATE grant anywhere.
Readable tables are an explicit migration-reviewed allowlist; raw event payloads, review queues,
edge-validation explanations, unlock rows, and future tables are denied by default.

Three sanctioned write paths during engineering, nothing else:

1. **MCP tools** — the normal one-door path (I2).
2. **`make migrate`** — schema changes only.
3. **`bun run scripts/repair.ts <committed-script>`** — ad-hoc data fixes. The runner refuses
   to run unless the script is committed to `HEAD` (`git cat-file -e`, not merely staged),
   takes a mandatory pre-image `pg_dump` before touching anything (no backup ⇒ no repair),
   and logs `repair:*` events carrying counts and ids only, never row contents. Repair
   scripts live in `scripts/repairs/` (`retype-org-to-person`, `merge-person`,
   `recategorize-transactions`, `sweep-extract-person-orgs`).

## After install

```
bun run src/cli.ts serve            # resident: MCP + watcher + 3am dream job
make verify-offline                 # fast offline development gate (mocked M0 + full tests/lint/typecheck)
make verify                         # release/search gate: offline gate + retrieval regression
bun run src/cli.ts audit --since 7d # what left the box, to which client
bun run src/cli.ts import:calendar export.ics       # and the other importers
```

Agent workflow prompts live in `agents/skills/*.md`; start with `agents/skills/RESOLVER.md`
and let it route to the right skill. For agents *working on the code*, product/safety guardrails
are in `CLAUDE.md` and the active single-owner workflow is in `docs/DEVELOPMENT.md`;
`minime-build-plan.md` is the historical v1 foundation. After installing, point the owner at
`docs/GUIDE.md` (the human-facing usage guide) and offer two interactive first-run steps —
both run in *their* terminal, not yours: `make onboard` (the seeding interview: values,
goals, people, projects) and `make setup` (cloud model providers / off-site backups).
Alternatively, you can conduct the onboarding interview conversationally yourself and
write the answers through the MCP tools (`minime_capture` with clear phrasing,
`minime_upsert_task`, `minime_log_interaction`, `minime_journal`).

## Update (in place, data and settings preserved)

```
make update        # = bash scripts/update.sh [--skip-verify]
```

Runs a clean tracked-tree preflight, takes a restic `db-snap` with the checked-out code
first (when configured), then fast-forwards to origin, syncs deps, applies pending
migrations (forward-only, idempotent), runs the offline suite, and warns
if a resident `serve` still runs old code. **Never touches `.env*`, `data/`, or backups**
— they are gitignored, so `git pull` cannot write them. Same output contract as the
installer: `[N/7] OK|SKIP|WARN|FAIL` lines, `ERROR:`/`FIX:` on failure, machine-parsable
`==== MINIME UPDATE SUMMARY ====` block (parse `status:` / `version:`). Exit codes:
`0` ok, `1` pre-update backup, `2` bad flag, `10` Bun pin/install, `11` deps,
`30` git (dirty tree / diverged / no network),
`50` migrate, `70` verify.

Refuses to run over local modifications to tracked files (FIX: stash). Existing installs that
predate the restricted resident role run `make migrate && make provision-runtime-role` once before
restarting `serve`. Rollback: `git checkout <old-commit>`, and if a migration misbehaved, use
`make restore-pitr` to select the logical snapshot at or before the requested time (the command
name is compatibility wording, not a WAL/PITR claim). Promotion stays a deliberate owner step.

## Uninstall / reset

- Stop: `make down` uses the persisted Docker/native backend and refuses to infer another service.
- **Destructive**: `docker compose down -v` deletes the database volume. Your captured
  files stay in `data/` either way — that directory is the archive; treat it like one.

## Cursor Cloud specific instructions

The Cloud Agent VM snapshot already has Bun (pinned `1.3.13`, symlinked to `/usr/local/bin/bun`),
a native PostgreSQL 16 + pgvector cluster, `node_modules`, a generated `.env`, and Ollama with both
models (`nomic-embed-text` + `llama3.1:8b`) for full non-degraded mode. The startup update script
only refreshes dependencies (`bun install --frozen-lockfile`); it does **not** start any service.
Notes below are the non-obvious bits — standard commands are in `## After install` and `CLAUDE.md`.

- **Start services first, every session.** Neither the update script nor `make up` starts services,
  and this container has no running `systemd`, so nothing auto-starts on boot. Before `bun test`,
  `make verify-offline`, or `serve`:
  - Postgres: `make up` (creates scratch DBs via `scripts/with-test-database.ts`; a stopped cluster
    fails most of the suite).
  - Ollama (only for full-mode semantic search / inbox auto-classification): start it detached, e.g.
    `OLLAMA_HOST=127.0.0.1:11434 ollama serve &` (or in a tmux session). Everything except those two
    features works without it, and the whole test suite mocks Ollama regardless.
- **Postgres runs on port `55432`, not the default 5432 — this is deliberate and must stay that
  way.** `.env` pins this (mirrors the CI convention in `.github/workflows/install.yml`). The
  installer-fixture tests in `test/h2.ollama-shell.test.ts` spawn `scripts/install.sh` on the
  default port 5432 and **fail if any Postgres occupies 5432**. Keeping Minime's own cluster on
  55432 leaves 5432 free so the full offline suite stays green. Do not re-point `.env` to 5432 or
  start a second cluster there.
- **git must be ≥ 2.47.** `scripts/check-tracked-privacy.ts` (and its tests) rely on
  `git rev-list --objects -z` emitting NUL-delimited output, which Ubuntu 24.04's stock git 2.43
  does not do. The snapshot ships an upgraded git (2.55 via the `git-core` PPA); the 3 privacy
  scanner tests fail on older git.
- **Full mode is available (Ollama installed), but only when `ollama serve` is running.** With it
  up, semantic search uses real embeddings and inbox captures auto-classify+file via `llama3.1:8b`;
  with it down the app degrades gracefully (search → full-text, captures → manual review queue).
  Tests are unaffected either way (they mock Ollama via `MINIME_MOCK_OLLAMA=1`), as are non-LLM MCP
  tools (tasks, agenda, state, people, decisions, expenses). Installing Ollama on Ubuntu 24.04 also
  required `zstd` (`apt-get install zstd`) for the release tarball — already in the snapshot.
- **Running the app / MCP door.** `serve` is a stdio MCP server: `bun run src/cli.ts serve`. Drive
  it end-to-end with any `@modelcontextprotocol/sdk` `StdioClientTransport` client (it inherits
  `.env`), e.g. create a task with `minime_upsert_task` and read it back with `minime_agenda` /
  `minime_search` / `minime_state` — none of which need Ollama.
- **Lint / typecheck / test / build** are the repo standards: `bun run lint`, `bun run typecheck`
  (+ `bun run typecheck:ops`), `bun test`, and the aggregate gate `make verify-offline`. There is
  no separate build step (Bun runs TypeScript directly).
