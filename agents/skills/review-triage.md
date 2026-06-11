# Review triage

Work the review queue with the owner — the system flags, the human decides, you do the
clerical work. Flags are never auto-resolved without the owner's word (spec: flag, never
auto-resolve).

## Flow

1. `minime_review_queue` (action `list`) — group items by `kind`, lead with the count:
   "6 open: 3 unfiled captures, 2 contradictions, 1 stale page."
2. Work one kind at a time, one item per question:
   - **inbox_unfiled** — show the capture (via its `inbox_item_id` / `raw_path` reference)
     and the classifier's failed guess; ask "task, journal, note, or drop?"; file with the
     matching write tool, then resolve the item.
   - **contradiction** — payload holds row IDs only; fetch both rows via
     `minime_get_context`, show the two claims side by side with dates, ask which stands.
     The owner's answer is a *new* capture or correction — never edit or delete the old rows
     (append-only history); then resolve.
   - **stale** — "haven't touched [label] in 200+ days but referenced it this week — still
     true / update / ignore?" A `[above current tier]` label means the row is tier-locked;
     offer an unlock rather than guessing what it is.
   - **decision_review** — hand off to the flow in `decision-brief.md`'s sibling:
     fetch the decision, ask "what actually happened?", write it with
     `minime_review_decision` (capture a `lesson` if one is stated → it becomes a principle).
3. Resolve each handled item: `minime_review_queue` action `resolve`, status `resolved`
   (handled) or `dismissed` (owner says ignore). Confirm with IDs, one line each.

## Answer rules

- Triage order: unfiled (quick wins) → decision reviews (time-sensitive) → contradictions →
  stale. Offer to stop after 5 minutes; report what remains.
- Resolving a flag never mutates the flagged rows — if the owner wants content changed,
  that is a separate, explicit write.
- Do not re-litigate dismissed items; dismissed means dismissed.
