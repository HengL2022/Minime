# Known issue: relation extractor mints phantom orgs from the owner's name & possessives

**Filed:** 2026-06-16 · **Area:** relation/edge extractor (`extracted_by = 'system:extract'`)
**Severity:** high (graph pollution at scale — one bad node accreted 200+ edges silently)

## Symptom

The relation extractor invents `org` nodes from text that is not an organization —
most damagingly from **the owner's own name** and from **possessive constructions** —
then attaches `works_at` / `mentions` edges to them. These nodes are never
human-confirmed (`created_by = 'system:extract'`, `source = 'extract'`) yet they
accumulate edges from across the whole corpus.

### Reproduction (observed 2026-06-16)

The example below is fictionalized; counts, names, identifiers, and paths are illustrative.
The fictional owner is **Priya**. The graph contained two phantom orgs:

| Phantom org | id | edges attached |
|---|---|---|
| `Priya`   | `<fixture-id-a>` | **42** |
| `Priya's` | `<fixture-id-b>` | (subset of the above set; same cleanup) |

`Priya` alone had **42 edges**: dozens of `person —works_at→ Priya` (i.e. the model read
"X, who works with Priya" / "Priya's colleague" as employment at an org named *Priya*),
plus `mentions` edges from interactions, pages, tasks, and decisions. `Priya's` is the
same failure on a possessive ("Priya's lab", "Priya's manager" → org `Priya's`).

This is the same class as the earlier observed bad edge **Nadia Rossi —works_at→ "Priya"**
and **Sigrid Halvorsen —works_at→ "Priya" / "Priya's"**. It co-occurs with a near-duplicate org
problem (`Fjordsonic AS` vs the correct `Fjordsonics AS` — a misspelling that became a
second node), which compounds the pollution.

## Root cause (hypothesis)

The entity/relation extractor that emits `system:extract` edges has no **owner-aware
blocklist** and no **possessive normalization**. Two concrete gaps:

1. **Owner name is a valid org candidate.** The owner's own name (and aliases) should
   never be resolved to an `org`. The extractor lacks the owner identity as context, so
   "works with Priya" → `works_at(Priya)`.
2. **Possessives become proper nouns.** `"Priya's"`, `"<Person>'s"` are treated as
   standalone named entities instead of a genitive of an existing person.

Both produce `org` rows through the **extraction side-path**, which (per the
multi-entity issue doc) is the *only* way orgs get created today — there is no
capture-door org creation with dedup, so extractor output quality is uncontrolled.

## Cleanup already performed (2026-06-16)

Manual DB cleanup (backup: `<private-backup-dir>/cleanup-<timestamp>.sql`):

- Deleted all 42 + 3 edges referencing `Priya`, `Priya's`, and `Fjordsonic AS`.
- Deleted the 3 phantom/duplicate org rows + their aliases.
- Re-pointed Sigrid Halvorsen to the correct nodes: `works_at` **Fjordsonics AS** = CURRENT;
  **Cobalt Meadow** and **Marble Lantern School** = former (`valid_to` 2024-01-01); de-duped a
  doubled Cobalt Meadow edge.

This is data-only repair. **The extractor will regenerate phantom orgs on the next
capture** until the code is fixed.

## Suggested fix (smallest first)

1. **Owner blocklist (recommended, cheap).** Load the owner's canonical name + aliases
   (already known to the system) and refuse to emit any `org` whose name case-folds to
   one of them. Drop the edge, don't guess an alternative.
2. **Possessive normalization.** Strip/normalize trailing `'s`/`'` and re-resolve against
   existing **people** before considering a new `org`. `"Priya's"` → person `Priya`, then
   the relation is about a person, not an employer.
3. **Org dedup on write.** Case-insensitive + fuzzy match new org names against existing
   `orgs.canonical_name` and `org_aliases` (the unique index `lower(canonical_name)`
   already exists). `Fjordsonic AS`≈`Fjordsonics AS` should merge-or-flag, not create a twin.
4. **Confidence floor + review queue.** Low-confidence `system:extract` org/edge creation
   should land in the evening review queue instead of being written live — same
   "never guess" contract used elsewhere.

## Acceptance / guardrails

- No `org` node may equal the owner's name or any owner alias (case-folded).
- A possessive of a known person never creates an `org`.
- Creating an org whose name fuzzy-matches an existing org merges or flags rather than
  duplicating.
- Existing `system:extract` edges to a newly-blocklisted name are swept (a migration or
  maintenance pass), not left dangling.
- Periodic audit: flag any `org` with `created_by='system:extract'` that has an unusually
  high edge count and no human confirmation — that pattern is what hid this for so long.

## STATUS — Fix A shipped (2026-06-16, commit `6fa21f0`)

Ingestion-time prevention landed in `src/pipeline/extract-edges.ts` (`orgsIn`):

- **Person-name guard (covers blocklist items 1 & 2).** `orgsIn` now receives the full
  lexicon of known people. Any org candidate that case-folds to a known person's name —
  or their bare first token (`"Priya Raghunathan"` → `priya`) — is rejected. This catches
  the owner *and* every other person (Tomasz, Ingrid) without a separate owner list.
- **Possessive stripped** (`Tomasz's` → `Tomasz`) before the guard, so possessives collapse to
  the person and never become an org.
- **Two non-org stoplist layers** (item 3's cousin): built-in `NON_ORG_TERMS` handles generic
  nouns such as `School`; the local `nonOrgTerms` set supplies owner-specific places and domain
  concepts such as `Springfield` and `Calibration`. Both use exact case-folded matches, so
  multi-word orgs that *contain* a generic word (`Acme School`) still extract.

TDD: 6 new tests in `test/m7.graph.test.ts` (RED→GREEN). Full suite 163 pass / 0 fail;
`tsc` clean. Verified end-to-end against a fictional fixture lexicon: the poisoned sentence
that previously minted phantom orgs now yields **zero** orgs and edges.

**Still open (not in Fix A):** org dedup-on-write fuzzy match (item 3,
`Fjordsonic AS`≈`Fjordsonics AS`)
and the low-confidence→review-queue path (item 4) — candidates for Fix B (dream-step safety
net). A local watchdog remains as the third belt-and-suspenders layer.
