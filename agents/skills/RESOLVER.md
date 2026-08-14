# Minime skill resolver

This is the dispatcher. Skills are the implementation — **read the skill file before acting.**
If two skills could match, read both; they are designed to chain (e.g. `query` answers a
question, then `capture` files the follow-up thought).

Universal rules, regardless of skill: numbers only via `minime_query_metric` (I6); cite source
IDs for every claim; surface the envelope's `gaps`/`staleness` verbatim; never present
inference as memory. If you know the owner's current IANA timezone, pass it as `time_zone`
on MCP calls so "today", date-only inputs, and timestamp outputs follow the owner rather
than the server process.

## Routing

| Trigger | Skill |
|---|---|
| "what do I know about…", "tell me about…", "search for…", "when did I…", "what did I write about…", any lookup question | `query.md` |
| "who works at…", "where does X work", "who is my physiotherapist/GP/vet/landlord…", "how do I know X", "what connects X and Y" | `graph-query.md` |
| "I'm meeting X", "brief me on X", "who is X again?", before a call/coffee/1:1 | `person-brief.md` |
| "remember this", "capture this", "save this thought", a pasted link/quote/idea with no other ask | `capture.md` |
| "let's triage", "what needs review", "any contradictions?", inbox cleanup | `review-triage.md` |
| morning, "what's today look like" | `morning-brief.md` |
| evening, "let's do the review", end-of-day reflection | `evening-review.md` |
| "should I…", "help me decide", "what do I know that bears on this choice" | `decision-brief.md` |
| "log this decision", "record this decision", "backfill decisions", "decision interview" | `decision-interview.md` |

## Tool cheat-sheet (full schemas come from the MCP server)

Reads:

- `minime_search` — hybrid search; `query`, `types?`, `limit?`, `include_derived?`, optional
  `from`/`to` (best-effort window on already-ranked hits, not an exhaustive date read). A
  locked session's `gaps` may include a bare tier-2 match count.
- `minime_get_context` — entity dossier; `type`+`id`, or `person_name` (matches people **and orgs**)
- `minime_state` — now-snapshot: calendar, due tasks, commitments, goals, decision reviews,
  upcoming dates, anomalies, filed-today, ops health
- `minime_list_metrics` — metric catalog (name, unit, description, rollup); no SQL. Call
  before `minime_query_metric` when the name is unsure.
- `minime_query_metric` — the only door to numbers; `name`, `from`, `to`, `granularity?`
- `minime_agenda` — forward-looking tasks over a caller-zone window, including undated open work
- `minime_timeline` — exhaustive date-range read across calendar, closed tasks, decisions, and
  — once unlocked — journal/interactions. Use this for "what happened in June."
- `minime_review_queue` — list/resolve flagged items (contradiction, stale, inbox_unfiled,
  goal_review, entity_promotion, ops_failure, …)
- `minime_unlock` — after the owner explicitly agrees, create a pending, time-boxed tier-2
  read request; give the returned request ID and local approval command to the owner and wait
  for approval (`unlock:approve`; they can also `unlock:status` / `unlock:revoke`)

Writes:

- `minime_capture`, `minime_journal`, `minime_log_decision`, `minime_review_decision`,
  `minime_upsert_task`, `minime_log_interaction`
- `minime_refile` — file a pending inbox capture as a typed row (task, journal, note,
  interaction, decision, org, or person); always needs an approved tier-2 unlock; never
  echoes the capture text
- `minime_correct` — amend / retract / retier a journal, interaction, decision, or note
- `minime_upsert_person` — alias, relation/context, or rename; merges are owner-run repairs
- `minime_set_person_date` — birthday, anniversary, or custom recurring person date
- `minime_upsert_goal` — create/update a life, year, or quarter goal
- `minime_upsert_commitment` — create/update a promise to a person or org
- `minime_log_expense` — insert-only unbanked spend into tier 0; never reads the row back
