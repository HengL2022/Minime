# Query

Answer a question from the owner's database with cited synthesis — an actual answer, not a
list of search hits. This is the default skill for any lookup.

## Contract

- Every claim cites a source ID (`[page:ab12…]`, `[journal:cd34…]`).
- Gaps are stated explicitly, from the envelope's `gaps` plus your own judgment of what the
  question needed but the data lacks. Never paper over a hole.
- `staleness` is disclosed when present ("newest matching note is 142 days old").
- Numbers come from `minime_query_metric` only — never arithmetic over prose (I6).
- Conflicting sources are shown side by side with both citations, newest first; do not pick
  a winner silently.
- Never present inference as memory: "you wrote X on DATE" only when a source backs it;
  otherwise say "I'm inferring this from …".

## Phases

1. **Decompose.** Split the question into search angles:
   - lexical terms (names, dates, exact phrases) and semantic paraphrases → `minime_search`
     (run 1–3 variants; the engine fuses vector + FTS, so phrasing diversity beats repetition)
   - **bilingual brain:** the owner writes in both Chinese and English — always run the query
     in BOTH languages (translate it yourself) and merge results by rank, interleaving the
     two lists. Same-language hits outrank cross-language ones even when wrong, so never
     trust a single-language ranking for a bilingual corpus. FTS contributes nothing for
     Chinese text (English tokenizer); the vector leg carries it — eval 2026-06-11.
   - entity angle: if a person/org/place is named → `graph-query.md` applies; call
     `minime_get_context` with the name
   - quantitative angle: "how much / how often / trend" → `minime_query_metric`
2. **Read before writing.** Open the top 3–5 hits with `minime_get_context` when the snippet
   is not obviously sufficient. Prefer primary rows over `derived: true` rows.
3. **Synthesize.** Short prose, claims cited inline, structured only if the question is
   structured. Lead with the answer, not the methodology.
4. **Disclose.** End with what the database does *not* know, one line: combine the envelope
   `gaps`, tier locks you hit ("2 journal entries matched but are tier-2 locked — say the
   word and I'll request an unlock"), and missing periods.

## Anti-patterns

- Dumping snippets and calling it an answer.
- Re-running the same query verbatim hoping for different hits.
- Requesting `minime_unlock` without asking the owner first.
- Estimating a number because the metric query felt like overkill.
