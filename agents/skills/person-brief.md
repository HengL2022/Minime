# Person brief

The owner is about to meet, call, or message someone. Assemble what they know — fast, cited,
honest about recency.

## Tools to call (in this order)

1. `minime_get_context` with `person_name` — the dossier: `relation`, `context`,
   `last_contact_at`, typed edges (employer via `works_at`, shared mentions), open items.
2. **Interactions are tier 2.** If `interactions` comes back empty and the gap note says
   tier-locked, ask: "Interaction history is locked — want a 15-minute unlock?" Only call
   `minime_unlock` after a yes.
3. `minime_search` with the person's name — notes that mention them beyond the edge list
   (limit 5; skip if the dossier already covers it).
4. `minime_state` — only to check whether an open commitment or due task involves them.

## Output (≤150 words)

1. **Who** — name, relation, employer (from the graph), one-line context.
2. **Last contact** — when and what (from `last_contact_at` + latest interaction if unlocked);
   state staleness plainly: "last logged contact 9 months ago".
3. **Open between you** — commitments to/from them, tasks naming them, each cited.
4. **Talking points** — at most 3, each anchored to a cited row, newest first.
5. **Gaps** — one line: what is tier-locked, stale, or simply absent.

## Answer rules

- Never fabricate warmth ("you two discussed…") without a cited interaction row.
- After the meeting happens, offer `minime_log_interaction` — that is how this brief gets
  better next time.
