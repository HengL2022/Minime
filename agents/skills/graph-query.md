# Graph query

Answer relational questions from the typed knowledge graph — "who works at X?", "where does
my GP work?", "who is my physiotherapist?", "how do I know Y?". The graph holds facts as
edges (`works_at`, `mentions`) and owner-relations (`people.relation`), extracted
deterministically on every write, each with a confidence and provenance.

## Phases

1. **Resolve the entity.** `minime_get_context` with `person_name` set to the person *or org*
   name (aliases match; "Fjordsonics" finds "Fjordsonics AS").
2. **Read the edges.** The `related` list carries typed edges with both endpoints titled:
   - org dossier → `works_at` edges pointing in = the people who work there
   - person dossier → `works_at` pointing out = employer; `relation` field = how they relate
     to the owner (manager, sister, GP, …); `mentions` edges = every note naming them
3. **Chain one hop when the question implies it.** "Where does my physiotherapist work?" =
   relation lookup (who is the physiotherapist) → that person's `works_at` edge. Two
   `minime_get_context` calls, not a text search.
4. **Fall back to `query.md`** when the graph comes up empty — the fact may be in prose but
   phrased without a cue the extractor recognizes ("Lessons with Lars Brodin" carries no
   role word). Say which layer answered: graph or prose.

## Answer rules

- Quote edge confidence when it is load-bearing: 0.85 = stated in one sentence, 0.7 = same
  paragraph, 0.6 = inferred from the page's dominant org — phrase 0.6 edges as "likely".
- Edges are extracted by rules (`extracted_by: system:extract`), so a wrong edge is possible:
  if the owner contradicts one, trust the owner and offer to note the correction.
- Cite the source row the edge was extracted from (`source_table`/`source_id` in `related`),
  not just the edge itself.
- People/org rows created by extraction (`created_by: system:extract`) may be thin — say so
  rather than padding them with guesses.
