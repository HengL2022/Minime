# H5 Tier-Floor and Recognizer-Parity Amendment

**Status:** Owner-approved normative amendment
**Approved implementation baseline:** `6a7877325845ac1d19e3c5bd6924866c90cb5320`
**Approved branch:** `codex/hardening-contradiction-scan`
**Date:** 2026-07-27

## Purpose

H5 now pairs production-shaped contradiction evidence by the canonical typed source parent,
but binding review found that the approved query omitted the privacy floors on four evidence
surfaces:

1. the accepted mention edge;
2. the target person;
3. the source chunk;
4. the canonical source-parent row.

Without those floors, tier-0 evidence can enter a pair. `contradictionScan()` derives its route
from the returned chunk tiers and collapses any maximum below tier 2 to tier 1, so a pair made
from tier-0 evidence can reach a classifier. This violates I1 and I3 even when the provider is
local, because tier-0 prose must never enter any model path.

The same review found two mismatches between H5's SQL compiled-note exclusion and H1's
canonical TypeScript recognizer: SQL accepts only lowercase UUID bullets, and its marker-line
test does not state H1's exact line-equality contract. This amendment closes
`H5-T2-LUNA-C1-TIER0-PAIR-EGRESS` and both recognizer-parity Important findings without
changing H5's public interface or dream-job control flow.

## Historical status and supersession

The historical pre-W5 hardening design, original H5 implementation plan, tranche index,
prior decisions, and subsystem inventory remain append-only and unchanged.

This amendment supersedes only these H5 claims:

- joining `edges.src_type/src_id` directly to `chunks.parent_type/parent_id` is sufficient
  evidence authorization;
- `a_tier` and `b_tier` alone prevent tier-0 evidence from reaching the scan;
- H5's lowercase UUID-bullet SQL is equivalent to H1's case-insensitive parser;
- substring/newline marker matching is the canonical statement of H1 marker recognition.

All other approved H5 behavior remains in force: production parent anchoring, distinct
composite parents, literal canonical-name/alias matching, active-page checks, compiled-source
and path exclusions, legacy source-metadata tolerance, canonical chunk ordering,
deduplication before limiting, IDs-only review payloads, and flag-only operation.

## Normative correction

### Canonical parent authorization

`chunkPairsSharingPerson()` must define a static
`canonical_parent_tiers(parent_type, parent_id, parent_tier)` CTE with exactly the current
`ParentType` domain:

| `parent_type` | canonical table |
|---|---|
| `page` | `pages` |
| `journal` | `journal_entries` |
| `interaction` | `interactions` |
| `decision` | `decisions` |
| `decision_branch` | `decision_branches` |
| `task` | `tasks` |
| `goal` | `goals` |
| `value` | `values_items` |
| `principle` | `principles` |
| `person` | `people` |
| `org` | `orgs` |
| `commitment` | `commitments` |

The CTE is a static `UNION ALL` projection of literal type, row ID, and row tier. It is not a
dynamic table-name lookup and does not call `edge_source_tier()`.

Each candidate mention edge must inner-join that CTE by:

```sql
cp.parent_type = e.src_type and cp.parent_id = e.src_id
```

This join is authoritative. An unknown parent type, a known type with no canonical row, or
an orphan parent ID has no CTE row and is excluded.

`source_table` and `source_id` remain tolerated historical metadata but are never trusted to
authorize, resolve, or tier contradiction evidence. `edge_source_tier()` is also not an
authorization source: its unknown/missing fallback is tier 1 and therefore cannot enforce
this floor.

### Four evidence floors

A mention candidate is eligible only when all four predicates are true:

```sql
e.tier >= 1
and p.tier >= 1
and c.tier >= 1
and cp.parent_tier >= 1
```

Tier zero is absorbing: if any one predicate fails, the candidate is absent before pairing,
model selection, model invocation, egress auditing, or review-queue insertion. The
correction does not promote, rewrite, repair, log, or aggregate the excluded row.

The returned pair fields remain the source-compatible chunk fields:

```ts
export interface ContradictionChunkPair {
  person_id: string;
  a_id: string;
  a_text: string;
  a_tier: number;
  b_id: string;
  b_text: string;
  b_tier: number;
}

export async function chunkPairsSharingPerson(
  limit: number,
): Promise<ContradictionChunkPair[]>;
```

No new tier field is added. Eligible tier-1/tier-2 routing continues through the unchanged
`contradictionScan()` maximum-chunk-tier calculation.

### H1 recognizer parity

H5's SQL must continue normalizing CRLF and CR to LF and must preserve the final exact
`## Sources` suffix rule.

Within that final suffix, the canonical UUID bullet predicate is case-insensitive:

```sql
final_sources_suffix ~* uuid_bullet_pattern
```

The bullet remains exact: one `- ` prefix, one canonical UUID, and a line boundary on both
sides. Uppercase hexadecimal is recognized; malformed UUIDs, indentation, doubled spaces,
and alternate bullet glyphs are not.

The marker predicate is exact line equality:

```sql
marker = any(string_to_array(normalized_body, E'\n'))
```

This recognizes the exact marker line at body start, in the middle, and at EOF with or
without a final newline. Prefixes, suffixes, indentation, and inline occurrences do not
match.

Source and anchored UUID-path exclusions remain unchanged. H5 consumes H1's exported marker
and UUID-path regex from `src/util/compiled-note-archive.ts`; it does not modify that module
or introduce a second TypeScript recognizer.

## Production and file scope

The correction implementation may modify exactly:

- `src/db/repo.ts`
- `test/h5-contradiction-scan.test.ts`
- `test/m13.provider-routing.test.ts`

These paths are inspection-only:

- `src/pipeline/dream.ts`
- `src/util/compiled-note-archive.ts`
- `test/h1-note-archive.test.ts`

`DECISIONS.md` and `docs/SUBSYSTEMS.md` remain deferred to original H5 Task 4. The original
H5 design, plan, and tranche index are not edited.

The correction adds no migration, dependency, lockfile change, generated scorecard, new
subsystem, provider, public API, tool schema, queue shape, or model prompt. It does not change
`src/pipeline/dream.ts`.

## Acceptance evidence

The correction test contract contains five named behaviors with explicit baseline
expectations:

1. **Characterization PASS:** all four tier-1 evidence surfaces still yield the existing
   canonical pair and IDs-only queue behavior.
2. **Expected RED:** tier zero independently on the edge, target person, chunk, or canonical
   parent excludes that candidate; unknown/orphan canonical parents are also excluded.
3. **Expected RED:** a compiled-note system shape with an uppercase canonical UUID bullet is
   excluded exactly as H1 recognizes it.
4. **Characterization PASS:** an exact marker line at EOF is excluded before the marker
   predicate is rewritten.
5. **Expected RED with a fail-closed preflight:** seed one tier-1 positive and the four
   tier-0 variants, call `chunkPairsSharingPerson()`, compute only the four
   per-blocked-fixture pair counts, and assert that the count vector is `[0, 0, 0, 0]`
   before setting `mockOllama` or any provider configuration, calling `patchFetch()`, or
   invoking `contradictionScan()`. At the defective baseline this assertion fails with
   integer counts only; no tier-0 prose, sentinel, or identifier may enter a provider,
   event, review item, test failure, log, ledger, report, or review packet. Only after the
   preflight passes on corrected production may the test configure the non-mock local
   route and prove exactly one positive loopback classifier request, zero cloud calls,
   zero `egress:*` rows, one positive IDs-only review item, and no blocked sentinel in the
   provider body or queue.

The RED phase is valid only when exactly items 2, 3, and 5 fail for contract reasons while
items 1 and 4 pass. Item 5 must fail at its counts-only preflight, before provider setup or
scan invocation; observing a provider call, egress row, or review item for a blocked fixture
invalidates the RED procedure rather than strengthening its evidence. Setup, migration,
import, syntax, or fixture failures are not acceptable RED evidence.

After implementation, the focused correction suite, H1/notes/decision adjacent suite, full
test/type/lint/subsystem/verification gates, immutable scope proof, and dependency hash proof
must all pass.

## Review and stop conditions

1. A fresh Luna/xhigh first-pass review must explicitly cover all four evidence floors, the
   complete static parent map, unknown/orphan exclusion, source-metadata distrust, H1
   recognizer parity, the counts-only routing preflight ordering, the post-fix
   provider/egress/review-queue evidence, fixture-output privacy, and the three-file
   production scope.
2. A fresh independent Critical Sol/xhigh adjudication must close
   `H5-T2-LUNA-C1-TIER0-PAIR-EGRESS` against the corrected diff and evidence. The prior
   adjudication at `6a7877325845ac1d19e3c5bd6924866c90cb5320` cannot be reused.
3. A fresh binding Sol/xhigh final review must return explicit `PASS`.
4. Any unresolved Luna Critical or Important, an upheld Critical, a binding Sol `BLOCK`, a
   scope/hash mismatch, or a failed required gate stops the cycle.
5. After one correction and rerun, a second consecutive failed review/gate cycle stops for
   the owner. Findings are never self-waived.

Only after all correction gates and reviews pass may execution return to the original H5
Task 3. Original H5 Task 4 remains the sole owner of the decision and subsystem
documentation updates.
