# Minime skill resolver

This is the dispatcher. Skills are the implementation — **read the skill file before acting.**
If two skills could match, read both; they are designed to chain (e.g. `query` answers a
question, then `capture` files the follow-up thought).

Universal rules, regardless of skill: numbers only via `minime_query_metric` (I6); cite source
IDs for every claim; surface the envelope's `gaps`/`staleness` verbatim; never present
inference as memory.

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

- `minime_search` — hybrid search; `query`, `types?`, `limit?`, `include_derived?`
- `minime_get_context` — entity dossier; `type`+`id`, or `person_name` (matches people **and orgs**)
- `minime_state` — now-snapshot: calendar, due tasks, commitments, decision reviews, anomalies
- `minime_query_metric` — the only door to numbers; `name`, `from`, `to`, `granularity?`
- `minime_review_queue` — list/resolve flagged items (contradiction, stale, inbox_unfiled, …)
- writes: `minime_capture`, `minime_journal`, `minime_log_decision`, `minime_review_decision`,
  `minime_upsert_task`, `minime_log_interaction`
- `minime_unlock` — time-boxed tier-2 read access; ask the owner before requesting it
