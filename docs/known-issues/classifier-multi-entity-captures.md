# Known issue: classifier collapses multi-entity captures into a single row

**Filed:** 2026-06-16 · **Area:** `src/pipeline/classify.ts`, `src/pipeline/watcher.ts`, `src/pipeline/segment.ts`
**Severity:** medium (silent data-shape loss — no error, no review-queue flag)
**Status:** mitigated 2026-08-14 — deterministic companion split for confident
legal-suffix / enumerated-company captures. LLM segmentation and first-class
org/person capture types remain future work.

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

### Secondary finding: there is no `org` type

The classifier's type set has **no `org`/`company`/`person` creation path** at all.
Captures describing a company are best-filed as `note` (pages). In the repro above,
three explicit single-vendor captures *with* `hint: "org / company record"` were each
filed as `note` (fixture pages A / B / C) — correct and searchable, but
they are pages, not org entities, so `minime_get_context(type='org', …)` can't resolve
them and no `works_at`-style edges can attach.

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

1. **LLM segment pre-pass.** Ask the model to split a capture into 1..N self-contained
   items *before* classifying each. Needed for multi-entity captures that do not use
   legal suffixes or an explicit supplier/vendor count.
2. **First-class `org` / `person` capture types** with dedup against existing
   `orgs`/`people` by name+alias, so a dedicated company capture becomes a resolvable
   entity instead of a page.
3. **`minime_search` withheld-hit signal** when a tier-2 row matched but was hidden
   for lack of unlock — related to how this issue stayed invisible, not required for
   the companion split.

## Workaround (still useful)

Capture **one entity per call** with an unambiguous first line when the deterministic
cue will not fire. Multi-entity events can still be logged as a single
`interaction`/`note` for the narrative; names the splitter cannot parse still need
their own capture.
