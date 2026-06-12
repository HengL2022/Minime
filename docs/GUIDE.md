# Minime owner's guide

How to get your life into the database, and answers back out. (Install: see the
[README](../README.md); agent setup: [AGENTS.md](../AGENTS.md). This guide is for *you*,
the owner, day to day.)

The mental model, in one line: **files are the archive, rows are the state, Postgres is
the index** — and everything you drop in becomes searchable for you and your agents.

## Putting things in

### 1. The inbox — for anything, anytime (lowest friction)

Drop a text or markdown file into `data/inbox/`. That's it. The watcher picks it up,
classifies it with the local model, and files it as a task, journal entry, interaction,
decision note, or reference note. Anything it isn't ≥70% sure about waits in the review
queue instead of being filed wrong.

Ways to feed the inbox:

- **From your phone**: an iOS Shortcut ("share → save text to folder") + Syncthing on the
  folder. Capture an idea on the train; it's searchable by the time you're home.
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

`data/brain/` is a folder of plain markdown, tracked in its own git repo. Write anything
there in any structure you like — project notes, reading notes, idea pages, reference
docs. Run `bun run src/cli.ts sync` (or let the resident server pick it up) and every
page is chunked, embedded, and searchable.

This is the right home for *living documents* you'll edit over time. The inbox is for
*moments*; the brain is for *pages*.

### 3. Journaling — private by default

Tell your agent "journal: …" (→ `minime_journal`, with optional mood/energy 1–5), or
just write journal-ish text into the inbox. Journal entries are **tier 2**: agents can
write them anytime but can only *read* them during a time-boxed unlock you grant
explicitly (`minime_unlock`, max 60 min, loudly audited).

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
  `minime_query_metric sleep_minutes`). Agents are forbidden from doing arithmetic over
  your prose — numbers come from SQL or not at all.
- **The evening review habit**: once a day, ask for the review queue — unfiled captures,
  flagged contradictions ("you wrote X in March but Y today"), stale pages, decisions
  due. Five minutes; it keeps the database honest.

## Trust, privacy, maintenance

- **Tiers**: 0 = money/health (never readable, aggregates only) · 1 = notes, tasks,
  people (agent-readable default) · 2 = journal, interactions, email metadata
  (unlock-gated reads). Set `CLOUD_MAX_TIER=1` in `.env` to keep tier 2 off cloud
  models too.
- **Audit**: `bun run src/cli.ts audit --since 7d` shows every read, write, and byte of
  egress — which agent, when, which rows. The log is append-only; nothing can be
  quietly erased.
- **Nightly dream job** (3am): embeds backlogs, links entities, compiles per-person
  notes, flags contradictions and staleness, rolls up metrics, backs up.
- **Backups**: configured in `make setup` (restic, client-side encrypted, local disk or
  B2/S3). Restore drill: `make restore-pitr TIME="…"` into a scratch DB, then
  `make promote-restore` — the live database is never touched in one step.
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
