# Review triage

Work the review queue with the owner — the system flags, the human decides, you do the
clerical work. Flags are never auto-resolved without the owner's word (spec: flag, never
auto-resolve).

## Flow

1. `minime_review_queue` (action `list`) — group items by `kind`, lead with the count:
   "6 open: 3 unfiled captures, 2 contradictions, 1 stale page."
2. Work one kind at a time, one item per question:
   - **inbox_unfiled** — the queue item always carries the classifier's `type`/`confidence`
     guess under `payload.capture` (e.g. "note, 0.62"); its `reason` and a ~500-char text
     excerpt read `[above current tier]` until this session has an approved tier-2 unlock.
     Offer the owner a choice: a short unlock (`minime_unlock`, hand them the returned local
     approval command, wait for them to approve it before re-reading — a reconnect locks it
     again), or running `bun run src/cli.ts review` in their own terminal, which lists every
     open `inbox_unfiled`/`duplicate` item with the full unmasked text and needs no unlock at
     all. Either way, once you both know what it is, ask "task, journal, note, interaction,
     decision, or drop?" and file it with `minime_refile` — one call that reads the archived
     capture itself, files the row, stamps `derived_from` back to the capture, and resolves
     this queue item (no separate `resolve` call needed). `minime_refile` always requires its
     own approved tier-2 unlock, regardless of how the owner read the text — filing tier-2-gated
     content is itself the disclosure the gate protects. If the owner used the no-unlock CLI
     route and would rather not unlock just to file, dictate it back instead and use the type's
     own write tool (`minime_upsert_task`, `minime_journal`, `minime_log_interaction`,
     `minime_log_decision`), then resolve the item yourself. A note-shaped capture has no such
     fallback tool — an approved unlock is the only agent-mediated way to file one.
   - **duplicate** — a captured task looked like an existing open one. Same text boundary as
     inbox_unfiled (`capture.type`/`confidence` always visible; `capture.reason`/`text` gated
     the same way). `existing_title` (the open task it matched), `candidate_due`, and a match
     `score` are always visible; `candidate_title` reads `[above current tier]` no matter what —
     not a tier lock, that field is simply never unmasked over MCP (the CLI route above shows
     it). Read the owner `existing_title` and ask what they actually captured: the same thing →
     dismiss, nothing to file. Genuinely different → simplest is `minime_upsert_task` (bypasses
     the match entirely), then resolve this item yourself. `minime_refile` also works but still
     refuses a title that re-matches the same open task ("file it as a different type, or
     resolve the match first") — only reach for it if you resolve or close the matching task
     first.
   - **contradiction** — payload holds row IDs only; fetch both rows via `minime_get_context`,
     show the two claims side by side with dates, ask which stands. With the owner's explicit
     approval, fix the losing row through `minime_correct`: `amend` for a corrected version,
     `retract` for simply wrong — covers journal/interaction/decision/note rows (a losing task
     is edited or dropped with `minime_upsert_task` instead; `minime_correct` doesn't cover
     tasks). Neither action ever rewrites or deletes the row itself: amend inserts a successor
     and stamps a backward pointer on the original, which stays stored and searchable — just
     down-weighted and labeled `superseded: true` with a pointer to what replaced it; retract
     stamps the same pointer with no successor and drops the row from search, but it stays
     readable by id. The `events` audit log (I8) stays append-only regardless of which one runs.
     Then resolve the item.
   - **stale** — "haven't touched [label] in 180+ days but referenced it this week — still
     true / update / ignore?" A `[above current tier]` label means the row is tier-locked;
     offer an unlock rather than guessing what it is. After the owner agrees, request it with
     `minime_unlock`, give them the returned local approval command, and wait for approval before
     re-reading. A reconnect is locked again; tier 0 is never readable.
   - **decision_review** — hand off to the flow in `decision-brief.md`'s sibling:
     fetch the decision, ask "what actually happened?", write it with
     `minime_review_decision` (capture a `lesson` if one is stated → it becomes a principle).
   - **phantom_person** — the nightly watchdog flagged a `people` row that looks like it should
     really be an org (payload: `person_id`, a `canonical_name` — masked like any other title if
     locked — and a fixed `suggestion`: "retype to org, or dismiss if this really is a person").
     Ask the owner which applies. Genuinely a person → dismiss. It's really the org, already on
     file as its own row → they run the existing repair, `bun run scripts/repair.ts
     retype-org-to-person --org-id=<id>` (retires the org, folds it into this person row). A
     duplicate of a person already on file → they run `bun run scripts/repair.ts merge-person
     --from=<this-person-id> --into=<the-real-person-id>` (this also auto-resolves the queue
     item — no separate `resolve` call needed). Both repairs are owner-run only: surface the
     command, never execute it yourself.
3. Resolve each handled item: `minime_review_queue` action `resolve`, status `resolved`
   (handled) or `dismissed` (owner says ignore) — skip this when `minime_refile` or a person
   merge already resolved it for you. Confirm with IDs, one line each.

## Answer rules

- Triage order: unfiled (quick wins) → decision reviews (time-sensitive) → contradictions →
  stale. Offer to stop after 5 minutes; report what remains.
- Resolving a flag (`minime_review_queue` action `resolve`) never by itself touches the flagged
  rows. Changing content is always a separate, explicit, owner-approved write —
  `minime_correct`, a type's own write tool, or an owner-run repair script. The `events` audit
  log (I8) stays append-only either way; a correction's superseded original stays stored,
  labeled, and down-weighted, never deleted.
- Do not re-litigate dismissed items; dismissed means dismissed.
