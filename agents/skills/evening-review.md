# Evening review

You are running the owner's evening review against Minime. Use Minime directly;
never invent facts. This has two parts: (A) deliver a concise review with a few
reflection prompts, then (B) when the owner replies, capture what they say.

## A. Gather and deliver

1. `minime_state` — tasks due, **tasks moved (closed) today** (`moved_today`:
   tasks marked done/dropped on the owner's local day), **captures filed today**
   (`filed_today`: each capture's classifier type/confidence plus its destination title/tier),
   open commitments, decision reviews due, review-queue count, metric anomalies. Usually the
   main call.
2. `minime_get_context(person_name=<owner>)` — owner context (goals, active
   projects, routines). Use the owner name from the database, not a hardcoded one.
3. `minime_search` — surface active threads from the day not captured by state.
   Run a few neutral queries and set `include_derived=true`, e.g.:
   - `"today review open decisions current focus"`
   - `"active projects routines health"`
   - `"open questions blocked next steps follow up"`
4. If tier-2 gaps block relevant interaction/journal-derived context, tell the owner what is
   locked and ask whether they want a short audited unlock. Call `minime_unlock` only after an
   explicit yes. Give the owner the returned request ID and local approval command, wait for
   them to approve it in their terminal, then re-read. Approval is time-boxed and bound to this
   MCP connection; a reconnect is locked again. Tier 0 is never readable.

Then deliver a short review, in this order. Omit any empty section:

1. **Quick check-in** — one or two lines framing the day.
2. **What moved today** — tasks closed today (from `moved_today` — done *and*
   dropped, with their close times converted to local), commitments made/closed,
   anything captured. This is the credit-where-due section: surface every
   completion, never leave a real day's work invisible.
3. **Captures filed today** — from `filed_today`, a one-line classifier audit, e.g. "3
   captures filed today: 2 tasks, 1 journal (tier 2), 1 note (tier 1, conf 0.72) — anything
   misfiled?" `kind`/`confidence` are always visible; a `[above current tier]` title just means
   that destination is tier 2 — nothing to unlock for the summary itself. If the owner flags
   one: wrong tier → `minime_correct` action `retier` (notes only, 1→2); wrong details but the
   right type → `minime_correct` action `amend` (journal/interaction/decision/note) or edit the
   task directly with `minime_upsert_task`. Filed as the wrong type entirely has no single fix
   yet — retract or drop the wrong row and capture it fresh as the right type.
4. **Still open** — tasks due/overdue, open commitments, decisions awaiting a choice.
5. **Tomorrow setup** — what's on the calendar and the 1–3 things worth teeing up.
6. **Reflection prompt** — 2–4 short questions (not an essay), grounded in the
   above and stored context. If the day has no explicit new information, say so
   and still offer a useful prompt from stored context.

## B. Capture the reply (when the owner responds)

Run as a short conversation, not a form — write as you go:

1. **How the day went** → `minime_journal` (`entry_md` in the owner's words
   lightly cleaned; ask for `mood`/`energy` 1–5 only if natural).
2. **Any decision made, or stuck pending one** → `minime_log_decision`
   (capture options even for open decisions; default review_in_days 90).
3. **Any promise made** → `minime_log_interaction` for the person (or org) it was made to,
   with `promise: {what, due?}` on that same call — one write logs the contact and opens a
   commitment attributed to them (`to_whom` resolves to their canonical name automatically).
   No interaction to hang it on (a promise to yourself, or naming no one in particular)? Use
   `minime_upsert_commitment` directly instead. Already fulfilled one mentioned in this
   conversation? Close it — `minime_upsert_commitment` with `status: kept` (or
   `renegotiated`/`broken`).
4. **Inbox triage** → if `review_queue_open > 0`, list via `minime_review_queue`
   (kind `inbox_unfiled`) — each item's classifier `type`/`confidence` guess is always visible;
   the capture text itself needs either a short owner-approved `minime_unlock` or the owner
   running `bun run src/cli.ts review` locally (no unlock). Once you both know what it is, file
   it with `minime_refile` — one call that files the row, stamps provenance back to the
   capture, and resolves the item — or, if the owner read it via the CLI and would rather skip
   the unlock, dictate it back and file with the type's own write tool instead (see
   `review-triage.md` for the full mechanics and the note-shaped exception — here, just the
   unfiled captures).

## Answer rules

- Pass the owner's current IANA `time_zone` on every read when it is known. Minime then renders
  timestamps with that timezone's offset, so use the returned clock time directly and do not
  convert it again. When the timezone is unknown and a timestamp is returned in UTC, label it as
  UTC rather than guessing a local time-of-day.
- Confirm each write with the returned ID, one line each.
- Never invent content the owner did not say; quote their words in `entry_md`.
- Writes are allowed without unlock (tier-2 writes are fine); do not request an
  unlock to write — except `minime_refile` in step B.4, which always needs one regardless of
  destination type, since it's filing content that was gated pending its destination.
- Keep it short: if the owner goes deep on one question, drop the rest and say
  what was skipped.
- Do not expose secret values or internal implementation details.
- If the review queue includes an `entity_promotion` item, do not try to identify or name the
  entity yourself — it reads `[above current tier]` at tier 1 and you cannot act on it even
  unlocked. Mention it briefly and point the owner at
  `bun run src/cli.ts entity:restore-tier --list` in their own terminal (full mechanics:
  `review-triage.md`); this is not worth working through in a quick evening review.
