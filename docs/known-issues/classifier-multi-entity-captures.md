# Known issue: classifier collapses multi-entity captures into a single row

**Filed:** 2026-06-16 · **Area:** `src/pipeline/classify.ts`, `src/pipeline/watcher.ts`
**Severity:** medium (silent data-shape loss — no error, no review-queue flag)

## Symptom

A single `minime_capture` whose text describes **several distinct entities** is filed
as **one** typed row, not one row per entity. The other entities survive only as
free text inside that single row's body/summary — searchable, but not resolvable as
first-class records via `minime_get_context`.

### Reproduction (observed)

Capture text:

> On 2026-06-14 I emailed three Chinese companies about lysis buffer for SNPsnipe:
> 菲鹏生物 / Fapon Biotech (Guangdong); 珠海宝瑞生物 / Biori (Zhuhai); 宝创生物 / Biotron
> (Guangzhou). … Chen Mengwei, the Singapore sales lead for Vazyme, was asked to help.

Result: filed as **one `interaction`** (`kind=email`, `person_name="Chen Mengwei"`,
confidence 0.78). The three vendor companies were **not** created as entities — they
existed only as text in `interactions.summary`, which is **tier-2** and therefore
hidden from `minime_search` unless the caller holds an unlock. Net effect: "what are
my lysis buffer vendors?" returned nothing findable until the vendors were re-captured
one-per-call.

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
(`src/pipeline/watcher.ts`) files exactly one row from it. There is no notion of
"this capture contains N fileable items," so the model is forced to pick the single
best-fit type and everything else is narrative residue.

### Secondary finding: there is no `org` type

The classifier's type set has **no `org`/`company`/`person` creation path** at all.
Captures describing a company are best-filed as `note` (pages). In the repro above,
three explicit single-vendor captures *with* `hint: "org / company record"` were each
filed as `note` (pages 892c9ec6 / 38bda369 / 09089365) — correct and searchable, but
they are pages, not org entities, so `minime_get_context(type='org', …)` can't resolve
them and no `works_at`-style edges can attach. (Compare the pre-existing bad edge where
Chen Mengwei `works_at` an org literally named "Heng" — orgs today only appear via
extraction side-paths, not the capture door, so their quality is uncontrolled.)

## Suggested fix (design options, smallest first)

1. **Split step (recommended).** Add an optional pre-pass that asks the model to
   segment a capture into 1..N self-contained items *before* classifying each. Keep the
   single-label classifier unchanged; loop it over the segments. The watcher files N
   rows, all carrying the same `derived_from` inbox-item id for provenance. Gate behind
   a confidence/þcount sanity check so a normal one-thing capture still costs one call.

2. **Multi-label classify.** Change `classify()` to return `Classification[]` and have
   the watcher file each. Bigger blast radius (every caller + `filed_table`/`filed_id`
   single-row assumptions in the inbox schema).

3. **Add `org` (and revisit `person`) as first-class capture types** with dedup against
   existing `orgs`/`people` by name+alias, so company/person captures become resolvable
   entities with controlled edges instead of free-text pages. Pairs naturally with (1).

## Acceptance / guardrails

- A capture naming K distinct entities yields K filed rows (or K-1 + 1 linking
  interaction), each independently searchable and resolvable.
- Each derived row keeps `derived_from = <inbox_item.id>` for audit.
- No regression on single-item captures (still one call, one row).
- When the splitter is unsure, **queue for evening review** rather than guess — same
  "never guess" contract as the current `catch` path in `classify()`.
- `minime_search` should arguably also signal when a tier-2 row matched but was withheld
  for lack of unlock, so hidden hits aren't indistinguishable from "no data." (Separate
  but related to how this issue stayed invisible.)

## Workaround (today)

Capture **one entity per call** with an unambiguous first line. Multi-entity events can
still be logged as a single `interaction`/`note` for the narrative, but each entity that
needs to be independently retrievable must get its own capture.
