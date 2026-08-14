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
   - quantitative angle: "how much / how often / trend" → `minime_query_metric`; unsure of
     the exact metric name → `minime_list_metrics` first
   - period angle: "summarize my June" / "what happened last week" → `minime_timeline` (a
     date-range read across calendar, closed tasks, decisions, and — once unlocked —
     journal/interactions; a locked range still discloses a bare count of what's hidden)
2. **Read before writing.** Open the top 3–5 hits with `minime_get_context` when the snippet
   is not obviously sufficient. Prefer primary rows over `derived: true` rows.
3. **Synthesize.** Short prose, claims cited inline, structured only if the question is
   structured. Lead with the answer, not the methodology.
4. **Disclose.** End with what the database does *not* know, one line: combine the envelope
   `gaps` with missing periods you notice yourself. Ground every tier-lock mention in a signal a
   tool actually returned. Two of those signals now carry a real, tool-computed COUNT — relay it
   as given rather than rounding it away: `minime_search`'s gap when a locked query matches
   tier-2 content ("N matching results are tier-2 locked — an owner-approved unlock (minime_unlock)
   would include them") and `minime_timeline`'s per-kind locked count over a date range ("N
   tier-2 entries in range are locked (…)"). Every OTHER locked signal stays existence-only —
   never invent a count for these: a zero-hit `minime_search` with no locked match either
   ("no indexed content matches the query at the current access tier"), `minime_get_context`'s
   locked-interaction gap ("interactions are tier 2 — locked …"), and a tier-aware `NOT_FOUND`
   on a person/org lookup ("no person or org matching that name at the current access tier — a
   match may exist at tier 2"). When any of these fires, offer the owner an unlock in your own
   words — repeat the real number when a tool gave you one, otherwise just "there's more here I
   can't see yet," never a guessed count. After an explicit yes, call `minime_unlock`, give the
   owner its returned request ID and local approval command, wait for them to approve it in their
   terminal, then re-read. Approval is time-boxed, loudly audited, and bound to the current MCP
   connection; a reconnect is locked again. Tier 0 is never readable.

## Anti-patterns

- Dumping snippets and calling it an answer.
- Re-running the same query verbatim hoping for different hits.
- Requesting `minime_unlock` without asking the owner first, or treating a pending request as
  approval.
- Estimating a number because the metric query felt like overkill.
