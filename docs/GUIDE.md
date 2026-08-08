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

**Recurring tasks**: ask your agent to make a task repeat — "make watering the plants a weekly
task" → `minime_upsert_task` with `recur_freq` (daily/weekly/monthly/yearly, optionally every N
of those with `recur_interval`) and `recur_anchor` defaulted from its due date. There's no inbox
phrasing for this (yet) — it's set in chat, not typed into a capture. Marking a recurring task
done immediately creates its next open instance with the same title, goal, and cadence, phase-locked
to the original due date (a monthly-on-the-31st task lands on the 28th in February, then recovers
the 31st once the month allows it again) — closing it via a "done" capture in the inbox works the
same way. Ask "how's my streak?" (→ `minime_query_metric habit_streak`) for your current run of
consecutive completed days, labeled per task title.

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

Recurring events (`RRULE`, plus `RDATE`/`EXDATE`) expand into one row per occurrence, identified
by `(uid, occurrence_start)` rather than `uid` alone — a weekly standup shows up every week, not
once. Supported: `FREQ=DAILY/WEEKLY/MONTHLY/YEARLY`, `INTERVAL`, `COUNT`, `UNTIL`, and
`WEEKLY`-only plain-code `BYDAY` (`MO`..`SU`, no ordinals like `1MO`). Each import expands a
rolling 12-month window from import time, capped around 500 occurrences per event, so re-running
an import later naturally picks up the next slice of the future — and prunes occurrence rows the
current export no longer produces, but only ones dated on or after that import's own "now," so
past occurrences are never touched. A rule outside that supported subset (`BYMONTHDAY`,
`BYSETPOS`, ordinal `BYDAY`, a non-Monday `WKST`, …) degrades safely: the event still imports its
first instance, and a content-free audit event flags it for review rather than guessing at
partial recurrence semantics.

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
- **Time periods**: "what happened in June" / "summarize last week" → `minime_timeline` walks
  calendar, closed tasks, and decisions across the range, plus journal/interactions once
  unlocked. A locked range still says how many tier-2 entries exist there, never their content.
- **Numbers**: always via metrics ("how did I sleep this month?" →
  `minime_query_metric sleep_minutes`; unsure of the exact name → `minime_list_metrics` lists
  everything queryable). Agents are forbidden from doing arithmetic over
  your prose — numbers come from SQL or not at all. Include `time_zone` when the answer should
  follow a travel/local calendar; live results use that zone without overwriting the nightly
  configured-timezone cache. The nightly cache is rebuilt atomically if the configured timezone
  changes, and a normal refresh removes derived buckets whose source data moved or disappeared
  while preserving manual values.
- **The evening review habit**: once a day, ask for the review queue — unfiled captures to
  file, flagged contradictions ("you wrote X in March but Y today") to settle, stale pages,
  decisions due. Five minutes; every flag has a real resolution now — file it, correct it, or
  dismiss it (see **Fixing mistakes** below) — not just a mark-as-read, so it keeps the
  database honest.

### Fixing mistakes

Corrections are audited writes, not silent edits — nothing you fix disappears; it's superseded
and both versions stay on the record.

- **Wrong content, wrong privacy tier, or just plain wrong**: "actually, log that decision's
  reasoning as X" or "that note should be tier 2, not 1" → your agent calls `minime_correct`
  (journal, interaction, decision, or note only — a task is edited or dropped directly, just
  ask). `amend` inserts a corrected successor row and points the original at it — the original
  stays stored and searchable, just down-weighted and labeled as superseded, so nothing already
  cited from it silently changes underneath you. `retract` withdraws a row with no successor: it
  stops matching search but stays readable by its id. `retier` promotes a note from tier 1 to
  tier 2 (one direction only) and needs an approved tier-2 unlock — the same gate a tier-2
  read uses.
- **Wrong name, or a person/org that should go by something else now**: "everyone calls her Sam"
  or "rename Acme Corp to Acme Ltd" → `minime_upsert_person`, in chat: add an alias, set a
  relation or free-text context, or rename (the old name is kept as an alias automatically, so
  anything that already pointed at it keeps resolving).
- **Two rows for the same person**: repeated capture typos ("Sarha"/"Sarah") eventually mint two
  person rows for one human. This is the one fix that isn't chat-driven — run it yourself in
  your terminal: `bun run scripts/repair.ts merge-person --from=<duplicate-id>
  --into=<real-id>`. Reversible: the duplicate row is kept, only superseded, never deleted.
- **The evening filing audit**: the evening review now includes a one-line digest of everything
  the classifier filed that day (type, confidence, destination), so a bad guess gets caught the
  same day instead of a month later. Say what's wrong and your agent fixes it with
  `minime_correct` (`retier`/`amend`) or the task tools above.

None of this touches the append-only `events` audit log (I8) — every correction is itself
recorded there, on top of the log, never instead of it.

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
  notes, flags contradictions and staleness, rolls up metrics, backs up. `minime_state`'s
  `ops_health` block always shows when it last ran and which steps (if any) failed on that run
  — content-free identifiers, same for every actor. Three consecutive nightly runs that each
  failed at least one step raise a single `ops_failure` review-queue item (it stays open until
  you resolve it, even once a run succeeds again); `bun run src/cli.ts doctor` gives the fuller
  local checklist.
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
- **Backup robustness**: every dump attempt first checks the db-dump/ filesystem has headroom —
  free space at least double the current `minime.sql` (or 256MB when there is no dump yet) — and
  fails closed with no partial file when it doesn't. Independently, a weekly
  `restic check --read-data-subset=5%` (`RESTIC_CHECK_CRON`, default Sunday 4am, runs only once
  `RESTIC_REPOSITORY`/`RESTIC_PASSWORD_FILE` are set) verifies the destination itself is still
  readable; it does not create a new snapshot. Each attempt logs one content-free
  `backup:restic-check` event (`minime audit` shows it), and `minime doctor` reports how long ago
  it last ran.
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
  never include child output or connection fragments in audit events or console/CLI output. A
  separate local, owner-only sanitized log at `data/logs/ops.log` (mode 0600 in a mode-0700
  directory, rotated to `ops.log.1` at ~1MB) records one line per backup command, dream-step, or
  cron failure: a fixed step identifier, an exit code when there is one, and a classification
  drawn from a fixed allowlist (for example `repo_locked`, `disk_full`, `pg_unreachable`,
  `repo_auth`, or `unclassified` for anything that does not match) — never raw child stderr, a
  path, or an exception message. Restore drills bind every connection to
  the fixed local source/admin/scratch database names, then install and attempt cleanup on
  every normal, failure, and signal exit and succeed normally; a persistent OS/trusted-rm
  refusal returns fixed content-free `cleanup_failed` and may leave only a validated private
  mode-0700 workspace/mode-0600 artifact for owner recovery. Service files are not guaranteed
  removed under that refusal; no path, URL, child output, or secret is printed.
- **Updating the software**: `make update` pulls the new version, snapshots the DB
  first, and applies migrations. Your `.env`, `data/`, and backups are never touched —
  they live outside git. Restart `serve` afterward.

### Keeping Minime running

For real-time inbox filing and nightly maintenance without an open agent session, install
`serve` as a per-user background service:

    make install-service                # macOS: launchd LaunchAgent · Linux: systemd --user unit
    make install-service DRY_RUN=1      # preview the rendered file; installs nothing

It renders `ops/service/*.tmpl` for your OS and checkout, then (re)starts it — safe to re-run
after a repo move or a Bun upgrade. Check it with `launchctl list | grep minime` (macOS) or
`systemctl --user status minime` (Linux). Logs land in `data/logs/serve.log` on macOS;
`journalctl --user -u minime -f` on Linux. `make uninstall-service` stops and removes it.

Every `serve` — this resident one, or an interactive one your agent starts per session — runs
its own inbox watcher and MCP endpoint; only whichever one holds the maintenance lock also
runs dream/backup. A resident install makes sure something always holds it, and takes over
within 5 minutes of the previous owner exiting.

Run `bun run src/cli.ts doctor` any time for a content-free health checklist: Postgres and
Ollama reachability, when dream last ran and whether it's current, backup dump freshness, how
long ago the weekly restic integrity check last ran, whether some process currently owns nightly
maintenance, and disk headroom for `data/` and `db-dump/`. Each line prints `PASS`, `WARN`, or
`FAIL`; the command exits nonzero only when
something is actually broken (Postgres unreachable, dream never run or stale past 48h, or
critically low disk) — a down Ollama or a missing/stale backup dump prints `WARN` but is not
itself fatal. No secrets, URLs, or paths appear in its output.

## Three habits that make it work

1. **Capture without ceremony.** If it takes more than ten seconds, you'll stop. Drop it
   in the inbox; let the classifier do the filing.
2. **Do the evening review.** The queue is short if you visit daily, hopeless if you
   visit monthly.
3. **Log decisions, not just tasks.** Tasks get done and forgotten; reviewed decisions
   are the only entries that make you smarter next year.
