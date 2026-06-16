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

Owner is **Heng**. The graph contained two phantom orgs:

| Phantom org | id | edges attached |
|---|---|---|
| `Heng`   | `dab80e95…` | **206** |
| `Heng's` | `6203dc97…` | (subset of the above set; same cleanup) |

`Heng` alone had **206 edges**: dozens of `person —works_at→ Heng` (i.e. the model read
"X, who works with Heng" / "Heng's colleague" as employment at an org named *Heng*),
plus `mentions` edges from interactions, pages, tasks, and decisions. `Heng's` is the
same failure on a possessive ("Heng's lab", "Heng's boss" → org `Heng's`).

This is the same class as the earlier observed bad edge **Chen Mengwei —works_at→ "Heng"**
and **Hai Yan —works_at→ "Heng" / "Heng's"**. It co-occurs with a near-duplicate org
problem (`Gentron Health` vs the correct `Genetron Health` — a misspelling that became a
second node), which compounds the pollution.

## Root cause (hypothesis)

The entity/relation extractor that emits `system:extract` edges has no **owner-aware
blocklist** and no **possessive normalization**. Two concrete gaps:

1. **Owner name is a valid org candidate.** The owner's own name (and aliases) should
   never be resolved to an `org`. The extractor lacks the owner identity as context, so
   "works with Heng" → `works_at(Heng)`.
2. **Possessives become proper nouns.** `"Heng's"`, `"<Person>'s"` are treated as
   standalone named entities instead of a genitive of an existing person.

Both produce `org` rows through the **extraction side-path**, which (per the
multi-entity issue doc) is the *only* way orgs get created today — there is no
capture-door org creation with dedup, so extractor output quality is uncontrolled.

## Cleanup already performed (2026-06-16)

Manual DB cleanup (backup: `/home/ubuntu/minime-backups/cleanup-20260616-073926.sql`):

- Deleted all 206 + 5 edges referencing `Heng`, `Heng's`, and `Gentron Health`.
- Deleted the 3 phantom/duplicate org rows + their aliases.
- Re-pointed Hai Yan to the correct nodes: `works_at` **A*STAR Singapore** = CURRENT;
  **Genetron Health**, **Duke**, **Duke Brain Tumor Center** = former (`valid_to`
  2024-06-01); de-duped a doubled Duke edge.

This is data-only repair. **The extractor will regenerate phantom orgs on the next
capture** until the code is fixed.

## Suggested fix (smallest first)

1. **Owner blocklist (recommended, cheap).** Load the owner's canonical name + aliases
   (already known to the system) and refuse to emit any `org` whose name case-folds to
   one of them. Drop the edge, don't guess an alternative.
2. **Possessive normalization.** Strip/normalize trailing `'s`/`'` and re-resolve against
   existing **people** before considering a new `org`. `"Heng's"` → person `Heng`, then
   the relation is about a person, not an employer.
3. **Org dedup on write.** Case-insensitive + fuzzy match new org names against existing
   `orgs.canonical_name` and `org_aliases` (the unique index `lower(canonical_name)`
   already exists). `Gentron`≈`Genetron` should merge-or-flag, not create a twin.
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
  or their bare first token (`"Heng Liu"` → `heng`) — is rejected. This catches the
  owner *and* every other person (Max, Liz) without a separate owner list.
- **Possessive stripped** (`Max's` → `Max`) before the guard, so possessives collapse to
  the person and never become an org.
- **`NON_ORG_TERMS` stoplist** (item 3's cousin): cities, generic nouns, and lab/therapy
  concepts (Wuhan, School, CAR-T, CRISPR, FACS…). Exact case-folded match only, so real
  multi-word orgs that *contain* a generic word (`Goddard School`) still extract.

TDD: 6 new tests in `test/m7.graph.test.ts` (RED→GREEN). Full suite 163 pass / 0 fail;
`tsc` clean. Verified end-to-end against the live DB lexicon (31 people / 15 orgs): the
poisoned sentence that previously minted 5 phantom orgs now yields **zero** orgs and edges.

**Still open (not in Fix A):** org dedup-on-write fuzzy match (item 3, `Gentron`≈`Genetron`)
and the low-confidence→review-queue path (item 4) — candidates for Fix B (dream-step safety
net). Weekly Hermes watchdog (`minime_phantom_org_audit.sh`, job `e7ca6d9e6a5e`) remains as
the third belt-and-suspenders layer.
