# Review triage

Work the review queue with the owner — the system flags, the human decides, you do the
clerical work. Flags are never auto-resolved without the owner's word (spec: flag, never
auto-resolve).

## Flow

1. `minime_review_queue` (action `list`) — group items by `kind`, lead with the count:
   "6 open: 3 unfiled captures, 2 contradictions, 1 stale page."
2. Work one kind at a time, one item per question:
   - **ops_failure** — the last 3 consecutive nightly `dream` runs each failed at least one
     step (payload: `failed_steps`, fixed step identifiers like `3_contradictions`, never
     prose; `since`, when the run of failures started) — a signal about the maintenance
     pipeline itself, not owner data, and always visible (no unlock needed). Tell the owner
     nightly maintenance has been failing and point them at `bun run src/cli.ts doctor`
     (local, owner-run) for the full checklist: Postgres/Ollama reachability, dump freshness,
     maintenance-owner presence, disk headroom. This never auto-resolves — a following clean
     `dream` run does not close it — so resolve it yourself only after the owner confirms the
     underlying problem is actually fixed.
   - **inbox_unfiled** — the queue item always carries the classifier's `type`/`confidence`
     guess under `payload.capture` (e.g. "note, 0.62"); its `reason` and a ~500-char text
     excerpt read `[above current tier]` until this session has an approved tier-2 unlock.
     `reason` may be a multi-entity parse failure (the capture named several companies or
     people but the names could not be extracted confidently — file one entity at a time,
     or refile the narrative and capture the missing names separately).
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
   - **goal_review** — the goal has gone 90+ days with no edit and no linked task touched
     either (payload: `goal_id`; the statement is resolved fresh, masked like any other title
     if locked). Read it back to the owner and ask "still true, or does this need updating?" —
     `minime_upsert_goal` handles a new statement/why, a status change (achieved/dropped), or
     nothing at all if it's just still true (touching the goal resets its own review clock).
     Then resolve the item.
   - **phantom_person** — the nightly watchdog flagged a `people` row that looks like it should
     really be an org (payload: `person_id`, a `canonical_name` — masked like any other title if
     locked — and a fixed `suggestion`: "retype to org, or dismiss if this really is a person").
     Ask the owner which applies. Genuinely a person → dismiss. A duplicate of a person already
     on file → they run `bun run scripts/repair.ts merge-person --from=<this-person-id>
     --into=<the-real-person-id>` (owner-run only, surface the command, never execute it
     yourself; this also auto-resolves the queue item — no separate `resolve` call needed). It's
     really the org, already on file as its own row → there is no sanctioned repair for that
     direction yet: `retype-org-to-person` looks like a fit but runs the opposite way, always
     retiring the *org* side and keeping or creating the *person* — pointed at this case it would
     retire the correct org and entrench the wrong person no matter whose id is passed. Tell the
     owner there's no safe automated fix today and leave the item open rather than guess.
   - **entity_promotion** — a person/org whose own identity card is still stuck at tier 2 even
     though it looks owner-known or is already independently tier-1-evidenced (payload:
     `entity_type`, `entity_id` only — no name, ever, in the payload itself; masked like any
     other title if locked, so at tier 1 you cannot read who this is, and even with an active
     tier-2 unlock you can only VIEW the now-visible name, never act on it). Demotion is
     owner-terminal-only — there is no tool call that can do it, and you must never claim
     otherwise. Tell the owner there's a name-restricted item and have them run
     `bun run src/cli.ts entity:restore-tier --list` locally to see who it is, then
     `bun run src/cli.ts entity:restore-tier <person|org> <id>` to restore that one identity
     card to tier 1 (aliases/edges genuinely derived from tier-2 content stay tier 2 — the CLI
     says so in its own output). The CLI resolves the queue item automatically on success, so you
     never call `resolve` for this kind yourself.
3. Resolve each handled item: `minime_review_queue` action `resolve`, status `resolved`
   (handled) or `dismissed` (owner says ignore) — skip this when `minime_refile` or a person
   merge already resolved it for you. Confirm with IDs, one line each.

## Answer rules

- Triage order: ops_failure (the pipeline producing every other flag may itself be broken) →
  unfiled (quick wins) → decision reviews (time-sensitive) → contradictions → stale →
  goal reviews → entity promotions (lowest urgency of all — no data is at risk either way, this
  is purely a visibility fix the owner runs in their own terminal). Offer to stop after 5
  minutes; report what remains.
- Resolving a flag (`minime_review_queue` action `resolve`) never by itself touches the flagged
  rows. Changing content is always a separate, explicit, owner-approved write —
  `minime_correct`, a type's own write tool, or an owner-run repair script. The `events` audit
  log (I8) stays append-only either way; a correction's superseded original stays stored,
  labeled, and down-weighted, never deleted.
- Do not re-litigate dismissed items; dismissed means dismissed.
