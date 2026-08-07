# Minime owner's guide

How to get your life into the database, and answers back out. (Install: see the
[README](../README.md); agent setup: [AGENTS.md](../AGENTS.md). This guide is for *you*,
the owner, day to day.)

The mental model, in one line: **files are the archive, rows are the state, Postgres is
the index** — and everything you drop in becomes searchable for you and your agents.

## Day one: the onboarding interview

```
make onboard
```

Five minutes of questions that seed the foundation agents reason against: who you are
(a profile page), your **values** in priority order, **goals** (life + this year),
**principles** you live by, the **key people** around you, current **projects**, and an
opening journal snapshot. Every question is skippable with Enter; re-running adds
entries rather than overwriting; everything is editable later. The point is that your
very first "give me a morning brief" already knows what matters to you.

## Putting things in

### 1. The inbox — for anything, anytime (lowest friction)

Drop a text or markdown file into `data/inbox/`. That's it. The watcher picks it up,
classifies it with the local model, and files it as a task, journal entry, interaction,
decision note, or reference note. Anything it isn't ≥70% sure about waits in the review
queue instead of being filed wrong.

Ways to feed the inbox:

- **From your phone**: DIY today, not a shipped feature. Syncthing has no first-party iOS
  app, so pair `data/inbox/` using a third-party Syncthing-compatible client, then build your
  own iOS Shortcut ("share → save text to folder") into that synced folder — a bundled
  Shortcut is future work. Real-time filing also needs your Mac awake with `serve` running to
  notice the new file; otherwise it waits and files at the next startup scan.
- **From any agent chat**: "remember this: …" → the agent calls `minime_capture`.
- **From the terminal**: `echo "todo: renew passport by 2026-08-01" > data/inbox/note.md`

Phrasing nudges the classifier (all optional):

| You write… | It becomes… |
|---|---|
| `todo: book dentist by 2026-07-01` | a task with a due date |
| `met Alice for coffee, she's leaving Acme` | an interaction (updates Alice's last-contact) |
| `decided: staying with Postgres because…` | a decision note |
| `Today felt scattered. Energy low…` | a journal entry (tier 2, private) |
| anything else substantial | a reference note → a brain page |

### 2. Brain pages — for notes and ideas you curate

`data/brain/` is a gitignored folder of plain Markdown in Minime's local data archive. Minime
does not initialize or maintain a separate Git repository there. Write anything in any
structure you like — project notes, reading notes, idea pages, reference docs — then run
`bun run src/cli.ts sync` after direct edits so each page is chunked, embedded, and searchable.
The resident watcher monitors `data/inbox/`; it does not watch `data/brain/`.

This is the right home for *living documents* you'll edit over time. The inbox is for
*moments*; the brain is for *pages*.

### 3. Journaling — private by default

Tell your agent "journal: …" (→ `minime_journal`, with optional mood/energy 1–5), or
just write journal-ish text into the inbox. Journal entries are **tier 2**: agents can
write them anytime but can only *read* them during an unlock you approve explicitly. After
you agree, `minime_unlock` creates a pending request and gives the agent a request ID and local
command. Run `bun run src/cli.ts unlock:approve <request-id>` in your own terminal, or
`unlock:approve --latest` to approve the one pending request without copying an id — it refuses
and lists every pending request instead of guessing if more than one is waiting. Approval must
happen within the approval window (`TIER2_UNLOCK_APPROVAL_WINDOW_MINUTES`, default 10 minutes,
configurable 1–60), is time-boxed, loudly audited, bound to that MCP connection, and is lost
when it reconnects.

### 4. People and interactions

"Log that I called Dr. Tan about the knee" → `minime_log_interaction`. People get
canonical names with aliases (Bob = Robert = 鲍勃), a relation ("my physiotherapist"),
and a last-contact date. The nightly job also extracts people/org mentions from
everything you write, so "who is Alice again?" works even if you never logged her.

### 5. Decisions — the part that compounds

When you're weighing something: "log a decision: should I …" → question, options,
reasoning, expected outcome, and a review date (default 90 days). When the review comes
due it shows up in your morning brief; record what actually happened, and optionally a
lesson — which becomes a **principle** linked to the decision that taught it. Next time
a similar question comes up, your agent retrieves the old decision *and its outcome*.

### 6. Bulk imports — calendar, money, health, email

```
bun run src/cli.ts import:calendar export.ics
bun run src/cli.ts import:transactions june.csv --profile dbs
bun run src/cli.ts import:health export.xml          # Apple Health export
bun run src/cli.ts import:email-meta ~/Maildir       # headers only, never bodies
```

All idempotent — re-importing the same file changes nothing. Transactions and health are
**tier 0**: no agent ever sees a row; they exist only as aggregates ("spend by category,
last 3 months") through `minime_query_metric`.

Calendar imports preserve UTC and `TZID` timestamps. Floating times use Minime's configured
owner timezone, and all-day `VALUE=DATE` events span local midnights even across daylight-saving
changes. Invalid dates, zones, or end times are skipped and logged without copying event text into
the audit trail.

### 7. Agent work sessions — automatic, opt-in

`make install-hooks` adds a Claude Code hook that summarizes every coding session (what
you asked, what happened, files touched) into the inbox as a tier-2 page. Your agent
work becomes part of your searchable history with zero effort.

## Getting things out

- **Ask anything**: "what do I know about X?", "when did I last talk to Alice?" — the
  `query` / `person-brief` skills in `agents/skills/` route through hybrid search and
  always cite source rows with staleness ("newest entry is 142 days old").
- **Morning brief / evening review**: skills that pull today's calendar, due tasks, open
  commitments, decision reviews due, and the review queue (`minime_state`).
- **Numbers**: always via metrics ("how did I sleep this month?" →
  `minime_query_metric sleep_minutes`; unsure of the exact name → `minime_list_metrics` lists
  everything queryable). Agents are forbidden from doing arithmetic over
  your prose — numbers come from SQL or not at all. Include `time_zone` when the answer should
  follow a travel/local calendar; live results use that zone without overwriting the nightly
  configured-timezone cache. The nightly cache is rebuilt atomically if the configured timezone
  changes, and a normal refresh removes derived buckets whose source data moved or disappeared
  while preserving manual values.
- **The evening review habit**: once a day, ask for the review queue — unfiled captures,
  flagged contradictions ("you wrote X in March but Y today"), stale pages, decisions
  due. Five minutes; it keeps the database honest.

## Trust, privacy, maintenance

- **Tiers**: 0 = money/health (never readable, aggregates only) · 1 = notes, tasks,
  people (agent-readable default) · 2 = journal, interactions, email metadata
  (owner-approved, session-bound unlock-gated reads). Tier 0 is absorbing and never
  readable: prose carrying explicit tier-0 evidence is never promoted into an agent-readable
  tier. Set `CLOUD_MAX_TIER=1` in `.env` to keep tier 2 off cloud models too.
- **Audit**: `bun run src/cli.ts audit --since 7d` shows every read, write, and byte of
  egress — which agent, when, which verb, and how many rows a call returned (never the row
  IDs or their content). The log is append-only; nothing can be quietly erased.

### Reading MCP audit outcomes

Transport-originated MCP calls use three append-only audit facts:

- `tool:<name>:attempt` is the durable receipt of a schema-valid call at the transport
  boundary. It proves intent was recorded, not that validation or the handler began.
- `tool:<name>` is a durable result authorization written before Minime invokes the local
  transport's `send()`. It is not proof that the result reached a client.
- `tool:<name>:disposition` correlates to the result event and records `suppressed` when send
  was never invoked, `released` when the local `Transport.send()` promise fulfilled, or
  `send_uncertain` when send was invoked but threw, rejected, was interrupted, or may have
  partially written. A missing disposition means incomplete/unknown.

`released` is deliberately narrow: it does not prove peer receipt, parsing, handling, use, or
user observation, and no result/disposition pair is crash-atomic with a stream or client.
Direct non-transport `invokeTool()` calls retain attempt plus `delivery:"direct"` result and
have no transport disposition.

When a result cannot be released safely, Minime uses fixed acknowledgements. A
`completed_result_withheld` response means the handler completed but its result audit was
unavailable; do not retry it automatically. `AUDIT_UNAVAILABLE` means an error or refusal
result was withheld for the same reason; do not retry it automatically. An attempt-phase
`INTERNAL` response with `retry: true` means the handler did not begin because the receipt
could not be recorded. Cancellation and disconnect outcomes intentionally carry no returned
IDs. Access-frequency ranking counts only correlated `released` transport results; historical,
direct, suppressed, uncertain, and incomplete rows do not count. These records describe the
local audit boundary only; they do not promise crash recovery
or a distributed rollback across Postgres, files, model providers, or indexes.

- **Nightly dream job** (3am): embeds backlogs, links entities, compiles per-person
  notes, flags contradictions and staleness, rolls up metrics, backs up.
- **Compiled-note recovery**: compiled archives contain tier frontmatter. Dream repairs legacy
  mirrors without a model call when possible, and valid private recovery records under
  `data/tmp/compiled-notes/` resume automatically. Invalid files remain for inspection and are
  reported only by opaque hash. Owners should not delete an invalid record until they have backed
  it up and identified its matching page. Explicit tier-0 or unverifiable generated recovery
  records are removed before model or canonical-note work; if private-record removal fails, the
  record is retained and no target write is attempted.
- **Tier-0 note quarantine**: brain sync classifies raw frontmatter before importing a file.
  Generated database mirrors with tier-0 or unresolved compiled-note provenance are marked
  deleted at tier 0, their chunks and relevant edges become inert, and embeddings are cleared.
  The archive file itself is preserved byte-for-byte for owner recovery. Human-owned collisions
  are left unchanged and reported only with an opaque target hash for owner review.
- **Backups**: configured in `make setup` (restic, client-side encrypted, local disk or
  B2/S3). Fresh installs leave backups disabled until you choose a destination. Selecting
  “skip” later clears the active destination, cadence, and backup credentials from `.env`
  without deleting an existing restic password file. Each logical dump is paired with a private
  manifest binding its hash, applied migrations, and representative row counts.
  `make restore-drill` requires a real configured restic snapshot, reports that source, checks
  the historical manifest/counts, migrates the
  temporary database to the checked-out ledger, validates its safety posture, and removes it.
  `make verify-restore-e2e` runs the same proof with fictional data in an isolated temporary
  PostgreSQL cluster and local restic repository; it never connects to the configured cluster.
  `make restore-pitr TIME="…"` is a compatibility name: it restores the latest logical snapshot at
  or before that time into `minime_restore`, validates and migrates that scratch database, and
  leaves it for inspection. It is not WAL/PITR.
- **Restore promotion**: `make promote-restore` is a separate, deliberate owner action. It refuses
  active sessions, prepared transactions, a stale schema, or an existing `minime_replaced`; writes
  a private pre-promotion dump; blocks new connections; then performs the two database renames.
  A failed second rename is compensated back to the original `minime`. After success the prior
  database remains blocked as `minime_replaced` for recovery. If the command reports
  `compensation_failed`, stop and inspect the three database names/postures before retrying.
- Archive paths are repository-stable and physical: the default is the repository's data/
  directory even when an MCP host starts Minime elsewhere or through a symlink. Relative
  MINIME_DATA_DIR overrides are also
  repository-relative. Database dumps stage in repository db-dump/ with private permissions;
  database clients receive credentials through short-lived private libpq service files rather
  than argv. Before replacing `minime.sql`, backup retains and verifies a private `.previous`
  dump+manifest pair; each new file is fsynced and atomically renamed. Backup/repair diagnostics
  never include child output or connection fragments. Restore drills bind every connection to
  the fixed local source/admin/scratch database names, then install and attempt cleanup on
  every normal, failure, and signal exit and succeed normally; a persistent OS/trusted-rm
  refusal returns fixed content-free `cleanup_failed` and may leave only a validated private
  mode-0700 workspace/mode-0600 artifact for owner recovery. Service files are not guaranteed
  removed under that refusal; no path, URL, child output, or secret is printed.
- **Updating the software**: `make update` pulls the new version, snapshots the DB
  first, and applies migrations. Your `.env`, `data/`, and backups are never touched —
  they live outside git. Restart `serve` afterward.

## Three habits that make it work

1. **Capture without ceremony.** If it takes more than ten seconds, you'll stop. Drop it
   in the inbox; let the classifier do the filing.
2. **Do the evening review.** The queue is short if you visit daily, hopeless if you
   visit monthly.
3. **Log decisions, not just tasks.** Tasks get done and forgotten; reviewed decisions
   are the only entries that make you smarter next year.
