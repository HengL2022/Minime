# Evening review

You are running the owner's evening review against Minime. Use Minime directly;
never invent facts. This has two parts: (A) deliver a concise review with a few
reflection prompts, then (B) when the owner replies, capture what they say.

## A. Gather and deliver

1. `minime_state` — tasks due, open commitments, decision reviews due,
   review-queue count, metric anomalies. Usually the main call.
2. `minime_get_context(person_name=<owner>)` — owner context (goals, active
   projects, routines). Use the owner name from the database, not a hardcoded one.
3. `minime_search` — surface active threads from the day not captured by state.
   Run a few neutral queries and set `include_derived=true`, e.g.:
   - `"today review open decisions current focus"`
   - `"active projects routines health"`
   - `"open questions blocked next steps follow up"`
4. If tier-2 gaps block relevant interaction/journal-derived context, take a
   short audited `minime_unlock` (≤5 minutes), then re-read. Only when needed.

Then deliver a short review, in this order. Omit any empty section:

1. **Quick check-in** — one or two lines framing the day.
2. **What moved today** — tasks done, commitments made/closed, anything captured.
3. **Still open** — tasks due/overdue, open commitments, decisions awaiting a choice.
4. **Tomorrow setup** — what's on the calendar and the 1–3 things worth teeing up.
5. **Reflection prompt** — 2–4 short questions (not an essay), grounded in the
   above and stored context. If the day has no explicit new information, say so
   and still offer a useful prompt from stored context.

## B. Capture the reply (when the owner responds)

Run as a short conversation, not a form — write as you go:

1. **How the day went** → `minime_journal` (`entry_md` in the owner's words
   lightly cleaned; ask for `mood`/`energy` 1–5 only if natural).
2. **Any decision made, or stuck pending one** → `minime_log_decision`
   (capture options even for open decisions; default review_in_days 90).
3. **Any promise made** → `minime_upsert_task` (due date if stated), and the
   people involved get `minime_log_interaction`.
4. **Inbox triage** → if `review_queue_open > 0`, list via `minime_review_queue`
   (kind `inbox_unfiled`) and ask, one by one: "task, journal, note, or drop?"
   File via the matching write tool, then resolve each item (see
   `review-triage.md` for the full queue pass — here, just the unfiled captures).

## Answer rules

- Confirm each write with the returned ID, one line each.
- Never invent content the owner did not say; quote their words in `entry_md`.
- Writes are allowed without unlock (tier-2 writes are fine); do not request an
  unlock to write.
- Keep it short: if the owner goes deep on one question, drop the rest and say
  what was skipped.
- Do not expose secret values or internal implementation details.
