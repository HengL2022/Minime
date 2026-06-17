# Decision interview

Use this when the owner wants to log a decision or backfill a recent choice. The goal is to
capture the raw reasoning before outcome memory rewrites it.

## Interview

Ask these six questions and record the owner's answers verbatim:

1. "What were you actually choosing between — and what did you almost do instead?"
2. "What would have to be true for the option you rejected to be the right one?"
3. "Where's the tension — what's making this hard?"
4. "What do you predict happens, and how sure are you?"
5. "What are the stakes, and how reversible is it?"
6. "When should we check whether you were right?"

For new decisions, do not skip prediction, numeric confidence, or review date. Those are the
parts future-you cannot reconstruct after the result is known.

## Tool call

Call `minime_log_decision` with:

- `question`, `options`, `choice`, `reasoning`, `expected_outcome`, `review_at`
- `confidence` as a 0-100 integer
- `falsifier` from question 2
- `stakes` and `reversibility` from question 5
- `transcript` as the six verbatim turns, using `question_key` values:
  `fork`, `falsifier`, `tension`, `prediction`, `stakes`, `review`
- `branches` for the chosen, rejected, and considered options; put each rejected branch's
  "would be right if" condition in `would_be_right_if`

Use `decided_at` for backfills. Use tier 2 only when the owner says the decision is private
enough to require unlock.

## Answer rules

- Treat raw transcript as source of truth; structured fields are a projection.
- Do not invent tags, criteria, or outcomes while logging.
- If the owner only wants a brief before choosing, use `decision-brief.md` first.
