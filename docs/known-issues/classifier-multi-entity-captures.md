# Known issue: classifier collapses multi-entity captures into a single row

**Filed:** 2026-06-16 · **Area:** `src/pipeline/classify.ts`, `src/pipeline/watcher.ts`, `src/pipeline/segment.ts`
**Severity:** medium (silent data-shape loss — no error, no review-queue flag)
**Status:** mitigated 2026-08-14 — deterministic companion split for confident
legal-suffix / enumerated-company captures; first-class org/person capture types;
LLM entity-plan fallback for suffix-less multi-name captures. A 1..N
classify-and-file split of mixed intents remains out of scope.

## Symptom

A single `minime_capture` whose text describes **several distinct entities** is filed
as **one** typed row, not one row per entity. The other entities survive only as
free text inside that single row's body/summary — searchable, but not resolvable as
first-class records via `minime_get_context`.

### Reproduction (observed)

The example below is fictionalized; it preserves the shape of the original incident without
publishing owner or contact data.

Capture text:

> I emailed three fictional suppliers about calibration gel for Project SILDRE:
> Northstar Reagents AS (Bergen), Bluefin Labs AS (Oslo), and Aster Bio AS (Trondheim).
> Nadia Rossi, the sales lead at Corvid Biotech, was asked to help.

Result (before the 2026-08-14 split): filed as **one `interaction`** (`kind=email`,
`person_name="Nadia Rossi"`, confidence 0.78). The three vendor companies were **not**
created as entities — they existed only as text in `interactions.summary`, which is
**tier-2** and therefore hidden from `minime_search` unless the caller holds an unlock.
Net effect: "what are my calibration-gel suppliers?" returned nothing findable until
the vendors were re-captured one-per-call.

## Root cause

`src/pipeline/classify.ts` is single-label by construction:

```ts
export interface Classification {
  type: "task" | "journal" | "interaction" | "note" | "decision_note" | "unknown";
  confidence: number;
  fields: Record<string, any>;
}
```

`classify()` returns exactly one `{type, confidence, fields}`. The watcher
(`src/pipeline/watcher.ts`) files exactly one primary row from it. There is no notion of
"this capture contains N fileable items," so the model is forced to pick the single
best-fit type and everything else is narrative residue.

As of 2026-08-14 the closed set also includes `org` and `person` for dedicated
identity captures. The single-label primary-row constraint remains.

### Secondary finding: there was no `org` type

Until 2026-08-14 the classifier's type set had **no `org`/`company`/`person`
creation path**. Captures describing a company were best-filed as `note` (pages).
In the repro above, three explicit single-vendor captures *with*
`hint: "org / company record"` were each filed as `note` (fixture pages A / B / C)
— searchable, but pages, not org entities, so `minime_get_context(type='org', …)`
could not resolve them and no `works_at`-style edges could attach. Dedicated
identity captures now file `orgs`/`people` (see Shipped below).

## Mitigation (2026-08-14)

A gated, deterministic pre-pass (`src/pipeline/segment.ts` `planCaptureEntities`) runs
on the capture bytes. It does **not** add an LLM call:

- **Cue:** two or more legal-suffix orgs (`AS`, `Inc`, `Ltd`, `Biotech`, …) **or** an
  enumeration (`three suppliers`, `2 companies`). Ordinary "met Alice and Bob" stays
  on the single-classify path.
- **Confident (2–8 named entities):** file the existing single-label primary row, then
  mint leftover orgs/people at **tier 1** with `derived_from = inbox_item.id`, name-only
  search chunks (never the capture body — that would leak a tier-2 interaction onto a
  tier-1 org), and an `inbox:split-entities` audit event (ids and counts, no names).
  The interaction subject is not minted twice. Same inbox finalization transaction as
  the other conservative splits.
- **Uncertain** (cue fired but names unparseable, or more than eight names): lower
  classifier confidence to ≤0.4 and keep the existing `inbox_unfiled` review path.
  No new review-queue kind; `capture.reason` explains the parse failure.

Tests: `test/segment.test.ts`, `test/multi-entity-capture.test.ts`.

## Still open

1. **1..N classify-and-file split.** A mixed dump that is a task *and* an
   interaction *and* a note still files one primary type. The entity-plan
   fallback only mints leftover orgs/people. Splitting into several primary
   rows would change inbox cardinality and stays deferred.

## Shipped after the companion split

1. **LLM entity-plan fallback (2026-08-14).** When the deterministic cue is
   silent, a weaker multi-name cue (`First Last at Org` pairs, two First Last
   names after a meet/coffee verb, or two multi-word names after emailed/called)
   may ask the classify provider (assumed tier 2) for named orgs/people. Mock
   mode uses the same cue heuristically. Companions reuse the existing mint
   (tier 1, name-only chunks). Failure, junk, one name, or "met Alice and Bob"
   stays on the single-classify path and does not unfile. Tests:
   `test/segment.test.ts`, `test/multi-entity-capture.test.ts`.
2. **First-class `org` / `person` capture types (2026-08-14).** Dedicated identity
   captures (`hint: org / company record` / `person record`, or a first line
   `org: Name` / `person: Name`) file `orgs`/`people` via `ensureOrg`/`ensurePerson`
   (name+alias dedup). Search chunks are the name only — never the capture body.
   `minime_refile` accepts `org` and `person`. A meeting/email/call is still
   `interaction`.
3. **`minime_search` withheld-hit signal.** Already shipped as
   `suppressedTier2Count` / a gaps line on locked sessions (`hybridSearchDetailed`,
   migration 039). Not required for the companion split.

## Workaround (still useful)

Capture **one entity per call** with an unambiguous first line when neither the
legal-suffix cue nor the weaker multi-name cue will fire. Mixed-intent dumps
(task + interaction + note) still need a split at the door.
