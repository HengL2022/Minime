# Decision brief

Given a decision question from the owner, assemble what past-them knows before they choose.

## Tools to call (in this order)

1. `minime_search` — the question's key terms, plus `types: ["decision"]` for similar past
   decisions. For every relevant past decision, fetch it with `minime_get_context` and read
   `actual_outcome` — outcomes matter more than intentions.
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

- Cite source IDs for every claim. Prefer primary captures over derived rows (`derived: true`).
- Never present inference as memory: "you wrote X on DATE" only when a source backs it.
- Do not recommend an option unless asked; the brief informs, the owner decides.
