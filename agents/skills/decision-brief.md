# Decision brief

Given a decision question from the owner, assemble what past-them knows before they choose.

## Tools to call (in this order)

1. `minime_search` — the question's key terms, with `types: ["page","decision"]`,
   `include_derived: true`, and `limit: 8`. Decision digest pages
   (`source='dream:decision-digest'`) are retrieval pointers, not reasoning material: extract
   the cited `decision:<id>` from the digest, then fetch the raw decision with
   `minime_get_context`.
2. `minime_search` with `types: ["principle"]` — principles the owner has already paid for.
3. `minime_get_context` with `person_name` for each person involved.
4. `minime_state` — current load (due tasks, open commitments): can the owner afford this now?
5. `minime_query_metric` — for ANY number the brief needs (spend, sleep, deep work). Never
   estimate numbers from prose.

## Output

1. **The question**, restated in one line.
2. **Options × criteria** table (criteria from the owner's values/goals where found, cited).
3. **What past-you learned** — similar decisions with their actual outcomes and any principles,
   each cited `[decision:abc12345]`.
4. **Current load** — one line from state.
5. **What's unknown** — every `gap`/`staleness` disclosure, plus anything the database simply
   doesn't know. Say "no past data on this" when true.

End by offering: "Want me to log this with `minime_log_decision` (with a review date)?"

## Answer rules

- Cite source IDs for every claim. Use derived decision digests only to find relevant raw
  decisions; reason from the raw decision row, transcript, branches, and actual outcome.
- Never present inference as memory: "you wrote X on DATE" only when a source backs it.
- Do not recommend an option unless asked; the brief informs, the owner decides.
