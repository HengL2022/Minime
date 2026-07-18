# Improvement program 2026-07 — orchestration plan

Source: `~/Downloads/minime-improvement-plan.md` (owner-reviewed proposal, 2026-07-18), grounded
against main @ `2c49cb2` by four read-only reconnaissance passes (provider layer, dream/extract/
review-queue, DB/infra/conventions, search/ingest/eval). This document is the shared contract for
executing workstreams W1–W9; per-workstream task cards live in sibling `improve-w*.md` plans.

> **For agentic workers:** the orchestrator dispatches one fresh executor subagent per task card
> using superpowers:subagent-driven-development; executors follow superpowers:test-driven-development.
> Steps in the per-workstream plans use checkbox (`- [ ]`) syntax for tracking.

## Roles and models (owner directive 2026-07-18)

| Role | Who | Model | Duties |
|---|---|---|---|
| Orchestrator | main session | **Fable 5** | authors/updates plans and task cards, dispatches executors, integrates branches, runs gates, writes/merges DECISIONS.md entries, final merge call |
| Executor | fresh subagent per task card | **Sonnet 5** | implements one task card TDD-first inside the workstream worktree; returns diff summary + test evidence |
| First-pass reviewer | fresh subagent per completed workstream (or per task batch) | **Sonnet 5** | two-stage review: (1) spec compliance vs the task card, (2) code quality vs house conventions (SQL containment, tier predicate, ≤60-line functions, parameterized SQL, comments explain *why*) |
| Critical reviewer | `invariant-reviewer` agent (already `model: fable`) + orchestrator reading the full diff | **Fable 5** | adversarial pass against spec §1/§12/§14 on the combined branch diff before merge; PASS/BLOCK verdict |

Escalation: reviewer findings go back to the same executor (continue its context) or a fresh fix
card. **Two-strike rule** (house discipline, DECISIONS.md 2026-06-12): two consecutive failed
review/gate cycles on the same area → stop, report to owner with the failure evidence; never
iterate blind.

## Workstreams, numbers, and plan documents

Milestone/test numbers m10–m12 are taken by shipped fixes; the improvement doc's "m13" labels
collided (it used m13 for three workstreams) and are reassigned here. **Migration numbers are
provisional — the true number is "next free at merge time"** (precedent: 85590ae renumbered 015);
plans reference the provisional number and the executor renumbers at merge if needed.

| WS | Title | Tests / migration (provisional) | Plan doc | Phase |
|---|---|---|---|---|
| W3 | Per-tier provider routing | `test/m13.provider-routing.test.ts` / none | `improve-w3-provider-routing.md` | 1 |
| W1 | Extractor re-validation dream step | `test/m14.extract-validate.test.ts` / `017_edge_validation.sql` | `improve-w1-extract-validate.md` | 1 |
| W4 | Postgres role separation + repair runner | `test/m15.roles.test.ts` / `018_engineer_role.sql` | `improve-w4-roles.md` | 1 |
| W2 | Subsystem inventory + complexity budget | CI script test / none | `improve-w2-subsystems.md` | 1 + continuous |
| W5 | Ingest parsing layer (docreader-lite) | `test/m16.parse.test.ts` / TBD | authored at phase-2 start | 2 |
| W6 | Image capture pipeline (VLM caption + OCR) | `test/m17.images.test.ts` / TBD | authored at phase-2 start | 2 |
| W8 | Parent-child chunking | `test/m19.parent-child.test.ts` / TBD | authored at phase-3 start | 3 |
| W7 | Compiled knowledge generalization | `test/m18.notes-general.test.ts` / TBD | authored at phase-4 start | 4 |
| W9 | Five-minute demo path + screencast | `install.test.ts` extension | authored at phase-2 end | last |

Each new `mN` suite ships its own `verify-mN` Makefile target and is chained into `verify`
(W2 also backfills the missing `verify-m10/11/12` targets — today `verify` stops at m9).

## Waves, parallelism, exclusive file ownership

Worktree isolation per workstream (one branch per workstream, house rule). Ownership is exclusive
while the wave runs; the orchestrator is the only writer of shared files (Makefile `verify` line,
CLAUDE.md) at integration time if two branches collide.

| Wave | Workstreams (parallel) | Exclusive ownership |
|---|---|---|
| 1 | **W3** ∥ **W4** ∥ **W2-initial** | W3: `src/llm/`, `src/util/config.ts`, `src/pipeline/{classify,notes,dream}.ts` (call-site edits only), `src/verify/m0.ts`, `scripts/setup-env.sh`, `.env.example`, `test/m13.*` — W4: `db/migrations/018*`, `scripts/repair.ts`, `scripts/repairs/`, `.env.engineering`, `.claude/hooks/protect-secrets.sh` (+ `.codex` mirror), `test/m15.*` — W2: `docs/SUBSYSTEMS.md`, `scripts/check-subsystems.ts`, `.github/workflows/`, Makefile verify-hygiene block |
| 2 | **W1** (needs W3's `classifyProviderForTier`) | `src/pipeline/validate-edges.ts`, `db/migrations/017*`, `src/pipeline/dream.ts` (step wiring), `src/mcp/tools/review-queue.ts`, `src/db/repo.ts` (new helpers only), `test/m14.*` |
| 3 | **W5 → W6** (W6 depends on W5's slot) | `src/pipeline/parse/`, `src/pipeline/watcher.ts` (seam at the `Bun.file(path).text()` call), `src/llm/*` (optional `describe` capability), `fixtures/` new parser fixtures |
| 4 | **W8** (solo — most eval-sensitive) | `src/search/chunker.ts`, `src/search/hybrid.ts`, `db/migrations/` span table, rechunk CLI |
| 5 | **W7** steps 1→3 (each eval-gated) | `src/pipeline/notes.ts`, `src/db/repo.ts` note queries, `src/pipeline/brain-sync.ts` (wikilink pass), qrels extensions |
| last | **W9** | `docker-compose.demo.yml`, README, screencast (owner records) |

W2 is continuous after wave 1: every later PR must carry its SUBSYSTEMS.md diff (CI-enforced).

## Global gates (every wave, before merge)

1. `bun test` full suite green; `bunx tsc --noEmit` clean; `bunx biome check --write .` clean.
2. `make verify` green **including the workstream's new `verify-mN`** target.
3. `make eval-search` — no MinimeBench floor regression beyond tolerance (0.03).
4. `invariant-reviewer` PASS on the combined branch diff.
5. DECISIONS.md entry in `/log-decision` format (drafted by executor, reviewed by orchestrator).
6. Workstream-specific gates from its plan doc (leak-suite extension for W3, planted-edge bars
   for W1, role probes for W4, live batteries for W8 per its stricter gate).

## Deferred-detail contracts (W5–W9)

Recorded now so later plan authoring starts from settled constraints; each opens with an
orchestrator task "author detailed task cards against current main".

- **W5 parse stage** — insertion seam is `src/pipeline/watcher.ts` `processInboxFile`, at the
  single `const text = await Bun.file(path).text()` call (currently ~line 326): sniff magic
  bytes + extension → `src/pipeline/parse/` registry `(filePath) → {markdown, meta, assets?}`
  → classify the markdown. v1 parsers: pdf, docx, xlsx/csv, eml. Everything downstream is
  already format-agnostic. `inbox_items.mime` exists and is never populated from content —
  parser sets it. Originals: **outside git** at `data/files/<yyyy>/<hash>.<ext>` + append-only
  `data/files/manifest.ndjson` (restic already covers `data/`); parsed page carries
  `source_file` frontmatter (extends the 3-key frontmatter parser in brain-sync.ts).
  Parser failure → `review_queue('inbox_unfiled')` with the parse error, never a silent drop.
  Golden tests: fixture-in / hand-written-expected-markdown-out (new pattern; the importer
  suites' count-assertion pattern covers idempotency). Gate: retrieval floors unchanged.
- **W6 images** — new **optional capability on `LlmProvider`**: `describe?(image, prompt)`
  (interface currently has only `embed?`/`completeJson`; no vision seam exists). Ollama impl
  via `/api/generate` `images:[base64]`, `VLM_MODEL` env; mock = fixture captions keyed by
  file hash (the `FetchFn` seam + `MINIME_MOCK_OLLAMA` split already support this shape).
  Images route as tier-2-like by default under W3 routing (`VLM_ROUTE_*` overrides audited as
  `egress:describe`). Tier rule per improvement doc §7 (photo→2; document/receipt/screenshot/
  whiteboard→1 unless personal/financial). Phase B (receipt→transaction candidates etc.) is
  flag-only through the review queue. **Owner bake-off task precedes committed floors** (Q3):
  10 fictional images through candidate local VLMs, scorecard to docs/benchmarks/. New eval
  area `retrieval-img` follows the MinimeBench area pattern (`AREAS` entry + sealed qrels +
  baseline lines; mock path = fixture captions). CLIP/SigLIP visual-similarity embeddings stay
  **deferred** (recorded): adoption trigger = caption-based image retrieval measurably failing
  the retrieval-img eval, not before.
- **W7 compiled knowledge** — generalize the three person-hardcoded sites in `src/db/repo.ts`
  (`NoteCandidate` literal type, `noteCandidates` SQL, `noteSourceChunks`); org notes reuse
  `org_aliases` exactly like the extractor's lexicon queries. `COMPILED_SOURCES` boost already
  keys on `source='dream:notes'` + `created_by='system:dream'`, so new kinds inherit the ×1.5
  boost with zero search changes. Topic notes v1 = page-clusters seeded from decisions+goals
  (Q4 default). Wikilinks: no `[[...]]` syntax exists anywhere yet; resolver reuses the note
  slug convention + `pagesByPaths()`; `pages` has no alias table — resolution is slug/path
  based, not title-based. Supersession statements in notes feed the PMB supersession-exclusion
  cases (new qrels before claiming the win). **Precondition: the compiled-note tier-frontmatter
  bug fix (chip task_46fe0b47) must be merged first.**
- **W8 parent-child chunking** — naming decision to avoid the live namespace collision:
  `chunks.parent_type/parent_id` already mean the parent *row*, so the new level is a **span**:
  new table `chunk_spans` (parent row ref, ord, text) + `chunks.span_id`. Children (~120–200
  tokens, sentence-bounded, CJK-aware) stay the embed/FTS/rerank unit; envelope returns the
  span text, deduped best-child-per-span-per-parent as today. `reembed` only wipes vectors —
  W8 ships a `rechunk` CLI (re-runs `indexParent` per parent). All constants tagged
  `eval-calibration pending`. **Strict gate:** full live battery (MinimeBench N=3,
  LongMemEval-s, PMB) before/after; ship only if PMB precision improves with recall within
  tolerance and floors hold; refuted → revert and publish (rejected-blend precedent).
  Live rebuild window needs owner scheduling (Q5) — dev/eval on scratch DBs is unblocked.
- **W9 demo** — `docker-compose.demo.yml` bundling Postgres + Ollama small models + seeded
  demo + MCP registration line; README restructure experience-first; screencast is owner-recorded.

## Owner decision points (defaults adopted; veto any before its wave starts)

| # | Question (improvement doc §13) | Default adopted |
|---|---|---|
| Q1 | Tier-2 classification local despite quality step-down? | **Yes** — `PROVIDER_ROUTE_TIER2=ollama` becomes the recommended standing config; review queue absorbs misclassifications. Raw inbox captures route as tier 2 (worst case) because tier is unknowable pre-classification. |
| Q2 | Binary originals storage | **Outside git + hash manifest**; restic covers them; brain git stays prose-only. |
| Q3 | Local VLM choice | **Bake-off before floors** — W6 starts with a 10-image owner-run comparison. |
| Q4 | W7 topic cluster seeds | **Decisions + goals** as v1 seeds. |
| Q5 | W8 reembed/rechunk window on live DB | **Owner schedules**; snapshot-backed procedure in the W8 plan; blocked-on-owner gate before live rollout only. |

## Pre-existing issues found during reconnaissance (outside program scope)

Spawned as independent fix chips / recorded for the owner:
1. **Compiled notes archived without tier frontmatter** → manual `sync` would downgrade tier-2
   notes to tier 1 (`notes.ts` writeArchive vs `decision-digest.ts`). Chip `task_46fe0b47`. W7 hard-depends on this fix.
2. **Contradiction scan joins on `source_table='chunks'` which nothing writes** → dream step 3
   likely processes zero pairs in production (`repo.ts` `chunkPairsSharingPerson`). Chip `task_ce246ce5`.
3. Stale docs corrected inside W3 (smallest owning diff): `classify.ts:1` header still claims
   "never a cloud call"; CLAUDE.md I1 wording predates the 2026-06-11 cloud-provider amendment.
4. Noted, no action: `docs/GUIDE.md` claims the resident server picks up brain edits (brainSync
   is manual-only); spec §6 config block predates the provider system; `.claude/agents/backup-*`
   reference a renamed home-dir plan file.

## Rejected adoptions (durable record — lift into DECISIONS.md with the program entry)

Per improvement doc §11, deliberately NOT adopted from WeKnora: multi-tenant RBAC; provider/
vector-DB/IM-channel matrices; web UI / graph browser; GraphRAG as a separate retrieval mode;
BLEU/ROUGE answer-level metrics. Rationale stands as written there; revisit triggers included.

## Program DECISIONS.md entry (drafted; log at wave-1 kickoff)

```markdown
## 2026-07-18 — Adopted the 2026-07 improvement program (W1–W9)

- **Context:** External repo review + WeKnora v0.6.0 comparative study produced
  ~/Downloads/minime-improvement-plan.md. Reconnaissance against main@2c49cb2 grounded it.
- **Decision:** Execute W3→W1→W4+W2 (phase 1), W5→W6 (2), W8 (3), W7 (4), W9 (last) per
  .claude/plans/improve-2026-07-program.md; orchestrator Fable 5, executors + first-pass
  review Sonnet 5, critical review invariant-reviewer (Fable). Rejected adoptions recorded:
  multi-tenant RBAC, provider/vector-DB/IM matrices, web UI, GraphRAG mode, BLEU/ROUGE.
- **Why:** Hardening before features (risk reduction first); W3 before W1 so validation calls
  are born correctly routed; eval-gated adoption for every retrieval-touching change.
- **Approved by:** human (owner) — plan reviewed 2026-07-18; §13 defaults Q1–Q5 adopted as
  listed in the program plan, owner may veto per-wave.
```
