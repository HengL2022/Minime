# DECISIONS

Append-only log of deviations from `minime-build-plan.md`, ambiguity resolutions, and technical
decisions (spec §0.3). Newest entries at the bottom. Use `/log-decision` to add entries.

## 2026-06-10 — Claude Code environment setup

- **Context:** Pre-M0 tooling; not part of the spec's milestones.
- **Decision:** Added `.claude/` config (CLAUDE.md guardrails, secrets-protection + biome-format
  hooks, invariant-reviewer subagent, /log-decision and /verify-milestone skills) and initialized
  the git repo on `main`.
- **Why:** The spec mandates a branch-per-milestone workflow, DECISIONS.md discipline, and
  invariant checks on every PR; encoding them in the agent environment makes them enforced rather
  than aspirational.
- **Approved by:** human (requested setup).

## 2026-06-10 — Single-pass build, no milestone gating

- **Context:** Spec §0.1–0.2 mandates one milestone per branch/PR, M0→M6 in order.
- **Decision:** Build the whole system in one pass on `main`; all `make verify-mN` targets still
  ship and must be green, they just gate the finished system rather than sequential PRs.
- **Why:** Owner's explicit directive: "Just follow the plan and keep coding until everything is
  usable. No need to gate by M0."
- **Approved by:** human.

## 2026-06-10 — Homebrew PostgreSQL 17 instead of Docker PostgreSQL 16

- **Context:** Spec §4 pins "PostgreSQL 16 + pgvector via Docker Compose" — this is a pinned-stack
  substitution.
- **Decision:** On this box Postgres runs via `brew install postgresql@17 pgvector`
  (`scripts/up.sh` auto-detects: Docker when available, Homebrew fallback otherwise).
  `docker-compose.yml` (pgvector/pgvector:pg16) ships unchanged for Docker-equipped boxes.
- **Why:** No Docker runtime is installed and installing one needs GUI/license steps; Homebrew's
  pgvector bottle only builds against postgresql@17/18, so 17 is the closest conforming version.
  Nothing in the schema uses 17-only features; everything stays on localhost (I1 intact).
- **Approved by:** agent-proposed (pending human review).

## 2026-06-10 — agg_sql convention: ($1,$2) params, 3-column result, security definer door

- **Context:** Spec §7/§8 leave the `metric_defs.agg_sql` calling convention unspecified.
- **Decision:** Every `agg_sql` takes `$1`=from-date, `$2`=to-date and returns exactly
  `(period_start date, value numeric, label text)` at day granularity (label null for
  dimensionless metrics; `spend_by_category` uses it). All execution goes through one
  `security definer` function `metric_agg(name, from, to)` (007_rls.sql); week/month series are
  summed from daily values. Labeled metrics are live-only (not persisted to `metric_values`,
  whose PK has no dimension column).
- **Why:** One parameterized door keeps I3/I6 enforceable and gives RLS-hardened roles the same
  path as the owner role; summing days is correct for all seeded additive metrics.
- **Approved by:** agent-proposed (pending human review).

## 2026-06-10 — Tests use a test-only SQL helper; error messages never echo input

- **Context:** Spec §14 confines SQL to repo.ts/migrations/agg_sql; spec §8 tool errors.
- **Decision:** `test/helpers.ts` may run raw SQL (schema reset, direct assertions like proving
  `events` UPDATE fails). Application code remains repo.ts-only. Separately, tool error/gap
  messages never echo user input (e.g. NOT_FOUND omits the searched name) so audit/leak checks
  can distinguish DB leaks from parameter echoes.
- **Why:** The M1/M6 acceptance criteria are unprovable without direct SQL probes; echo-free
  errors shrink the leak surface and made the fuzz suite's sentinel assertions sound.
- **Approved by:** agent-proposed (pending human review).

## 2026-06-10 — Dream-job simplifications (v1)

- **Context:** Spec §10 dream steps 3, 4, 7; §13 M6 restore drill.
- **Decision:** (a) Contradiction scan compares chunk pairs linked to the same person; with
  Ollama it asks the local model, in offline tests a deterministic antonym heuristic stands in.
  (b) Staleness flags pages/people untouched >180 days without the "referenced this week"
  precondition (reference tracking deferred). (c) `make restore-drill` restores the latest
  restic snapshot when restic is configured, else drills the same restore path from a fresh
  `pg_dump`; it validates schema, data presence and the append-only trigger in the scratch DB
  rather than re-running the (destructive) m1 reset suite against it.
- **Why:** Keeps every spec behavior present and testable offline without overbuilding v1;
  full reference-tracking and restic-only drills can land later without schema changes.
- **Approved by:** agent-proposed (pending human review).

## 2026-06-11 — One-command installer (scripts/install.sh) and agent contract (AGENTS.md)

- **Context:** Ops tooling on top of the spec (no §13 milestone covers installation UX).
  Touches the §4 pin indirectly: native Linux installs use PostgreSQL 16 via PGDG (matches
  the spec pin and the Docker image); native macOS stays PostgreSQL 17 (pgvector brew bottle
  constraint, already recorded 2026-06-10).
- **Decision:** `bash scripts/install.sh` is the single non-interactive setup path
  (bun → deps → postgres → .env → ollama → migrate → seed? → verify → MCP hints), idempotent
  by detect-before-act, machine-parsable output (`status:` summary block, fixed `ERROR:`/`FIX:`
  failure tail, per-step exit codes). Ollama problems *degrade* (status: degraded, exit 0) —
  the runtime already supports FTS-only search and review-queue classification — everything
  else fails loudly. AGENTS.md documents the contract for coding agents; shared bash lives in
  `scripts/lib.sh`; `scripts/pg-probe.ts` detects a provisioned DB without a psql client.
  A GitHub Actions matrix (ubuntu-22.04/24.04 + macos-14) covers the install paths this
  development machine cannot test (fresh apt/PGDG, systemd, fresh brew); it activates when
  the repo is pushed to GitHub.
- **Why:** The 15-step README install was the main adoption blocker; the owner wants
  "give an agent the GitHub link, get a verified install". Degraded-but-verified beats
  all-or-nothing because the 4.7GB model pull is the most failure-prone step and the system
  is genuinely useful without it.
- **Approved by:** human (plan approved 2026-06-11).

## 2026-06-11 — Cloud LLM providers (amends invariant I1) + two new SDK dependencies

- **Context:** Spec §1 I1 ("no cloud calls from Minime itself") and §4 pinned stack (new
  dependencies `@anthropic-ai/sdk`, `@anthropic-ai/bedrock-sdk`). This is the largest spec
  deviation to date and is owner-requested.
- **Decision:** The three internal model jobs (embeddings, inbox classification,
  contradiction scan) route through a provider layer (`src/llm/`): ollama (default,
  unchanged), anthropic (default model claude-opus-4-8, owner's choice), openai, openrouter,
  bedrock (IAM env credentials; `BEDROCK_MODEL` required — ids aren't guessable).
  Guardrails shipped with it: (a) every cloud call writes an `events` row
  (`egress:embed`/`egress:classify`, counts never contents) so `minime audit` shows cloud
  egress; (b) `CLOUD_MAX_TIER` (default 2, owner's choice) caps which tiers a cloud provider
  may see — tier-0 never leaves under any configuration (it is never chunked/classified);
  (c) embeddings remain pinned to 768 dims → embed providers are ollama/openai only;
  Bedrock Titan (1024) plus a `reembed` dimension-migration tool deferred.
- **Why:** Owner wants provider flexibility beyond local Ollama. Defaults keep I1 intact
  (env-less installs are byte-for-byte local-only); the amendment is opt-in per job, audited,
  and tier-capped, which preserves the spirit of "minimize and audit the egress surface".
- **Approved by:** human (plan approved 2026-06-11; tier/model/scope choices made by owner).

## 2026-06-11 — Correction: OpenRouter DOES serve embeddings; enabled at 768 dims

- **Context:** The entry above claimed OpenRouter has no embeddings API. Verified live
  against the owner's account: `POST /api/v1/embeddings` works and honors `dimensions: 768`
  for `qwen/qwen3-embedding-8b` (Matryoshka model; returns unit-normalized 768-dim vectors).
- **Decision:** `EMBED_PROVIDER=openrouter` enabled (`OPENROUTER_EMBED_MODEL`, default
  qwen/qwen3-embedding-8b). Guardrails: responses with any dimension ≠ 768 are rejected
  loudly and never stored; new `minime reembed` command wipes and re-embeds the corpus when
  switching embedding provider/model (vectors from different models must never be compared —
  this also covers the previously deferred model-switch case at constant dimension).
- **Why:** Owner supplied an OpenRouter key specifically for Qwen3-Embedding-8B; live probe
  beat stale knowledge.
- **Approved by:** human (requested).


## 2026-06-11 — ftsCandidates: OR-rewritten websearch_to_tsquery instead of plainto_tsquery

- **Context:** Hybrid search scoring (spec §9 — this tunes the fts leg of the pinned
  0.55/0.30/0.10/0.05 fusion; weights themselves unchanged). `ftsCandidates` in
  `src/db/repo.ts`.
- **Decision:** Rewrite the user query as individual words joined with `OR` and parse it with
  `websearch_to_tsquery('english', …)` instead of `plainto_tsquery`, which ANDs every term.
  `ts_rank_cd` still ranks chunks matching more terms higher, so precise keyword queries keep
  their edge while partial matches now contribute signal instead of vanishing.
- **Why:** On a 100-question synthetic retrieval eval (fictional persona, 16 brain docs, real
  qwen3-embedding-8b embeddings), AND semantics produced **zero** fts candidates for 70/100
  natural-language questions — any one contentful query word missing from a chunk silenced the
  whole 0.30 fts weight, leaving ranking to cosine+recency alone. After the change: 1/100
  zero-candidate queries; hit@3 96%→99%, hit@5 98%→100%, MRR@5 0.943→0.952, answer-in-top-3
  96%→99%; hit@1 unchanged at 92%. Full `bun test` (56 tests, incl. m6 tier-0 sentinel leak
  test) stays green. Alternative considered: AND-first-then-OR fallback — rejected as two code
  paths for marginal benefit, since ts_rank_cd already favors all-terms matches.
- **Approved by:** human (requested the fix after reviewing the eval).

## 2026-06-11 — Backups may target cloud object storage (encrypted restic repos)

- **Context:** Amends invariant I1 (spec §1 "local-first", §12 at-rest) for the backup path
  only. The nightly `dream` step 7 (`restic backup data/ db-dump/`) previously assumed a
  local/external-disk `RESTIC_REPOSITORY`.
- **Decision:** `RESTIC_REPOSITORY` may point at a well-recognized cloud object store
  (e.g. Backblaze B2, S3, Cloudflare R2). Restic encrypts client-side (AES-256); the
  repository password and keys never leave the box (`RESTIC_PASSWORD_FILE`, perms 0600).
  Tier rules are unchanged — the provider stores opaque ciphertext, which is a different
  threat profile from a live cloud DB (Supabase et al. remain ruled out). Live runtime
  network surface is unchanged; only the backup job talks to the storage endpoint.
- **Why:** Owner judged an external disk unrealistic to maintain; an off-site encrypted
  copy also covers theft/fire, which a single local disk does not. 3-2-1 with ciphertext
  beats 1 copy in plaintext.
- **Approved by:** human (owner, 2026-06-11 conversation).

## 2026-06-11 — M7 (post-v1 feature): typed knowledge-graph extraction, zero-LLM

- **Context:** Extends the entity graph beyond spec v1 (§7 edges, §10 dream step 2, §15
  deferred the consolidated-entity layer). New migration `008_orgs.sql` (orgs + org_aliases,
  RLS/grants mirroring people), new pipeline `src/pipeline/extract-edges.ts`, extraction
  hooked into `indexParent` (per-write) with the dream pass as backlog sweep. `minime_search`
  graph boost and `minime_get_context` now resolve orgs as well as people. New `verify-m7`
  gate (`test/m7.graph.test.ts`).
- **Decision:** A deterministic rule/pattern layer (no model calls) extracts on every write:
  `mentions` edges for known people/orgs; `works_at` edges (person → org) at confidence 0.85
  (same sentence) / 0.7 (same paragraph + work cue) / 0.6 (page-dominant org, only when that
  org recurs ≥2× on the page); owner-relations ("my physiotherapist X") onto
  `people.relation`, never overwriting a human-set value; discovery of new people/orgs only
  when anchored to high-precision cues (role words, employment verbs, org suffixes,
  "partner is X"). Name variants merge instead of forking ("Tomasz" ↔ "Tomasz Wójcik",
  "Fjordsonics" ↔ "Fjordsonics AS"). All rows/edges stamped `system:extract` (I5), so a bad
  rule's output is identifiable and deletable in bulk.
- **Why:** Vector+FTS search cannot answer relational questions ("who works at X?",
  "where does my GP work?"). On the 16-doc fictional-persona eval corpus the rule layer
  built 13 orgs, 10 people (all 10 with correct owner-relations), 8 works_at edges — all
  correct, zero false edges — answering 15/15 graph-only relational questions; the
  100-question retrieval eval is unchanged (hit@3 99%, hit@5 100%), so the boost path did
  not regress. Zero-LLM keeps it I1-clean (no egress), deterministic, and auditable;
  known gap: relations phrased without a role cue ("Lessons with Lars Brodin") are not
  extracted — acceptable precision-over-recall trade for graph data.
- **Approved by:** human (requested the build after the GBrain comparison).

## 2026-06-11 — Skills layer expansion + minime_review_queue tool

- **Context:** Spec §11 ships three agent skills (morning-brief, evening-review,
  decision-brief). Reviewing GBrain showed its "synthesis layer" is in fact a folder of
  agent playbooks plus a trigger-phrase dispatcher — the same externalized-synthesis
  architecture as Minime, just with far more coverage. Also amends §8 (MCP tool list).
- **Decision:** (1) Five new skills in `agents/skills/` — `query.md` (cited synthesis with
  mandatory gap/staleness disclosure), `graph-query.md` (relational questions via the M7
  typed-edge graph, with confidence phrasing rules), `person-brief.md`, `capture.md`,
  `review-triage.md` — plus `RESOLVER.md`, a GBrain-style trigger→skill dispatch table.
  (2) One new MCP tool `minime_review_queue` (list/resolve): the queue had no agent-facing
  read path (evening-review step 4 referenced data `minime_state` never returned — fixed).
  Stale-item labels are re-resolved through tier-filtered `parentMeta`, so a tier-2 title
  baked into a payload at flag time is masked as "[above current tier]" at tier 1.
  Resolving a flag never mutates the flagged rows.
- **Why:** Synthesis quality lives in the playbooks, not the server; richer skills close
  most of the practical gap with GBrain at zero runtime/invariant cost. The new tool is
  the smallest change that makes review-queue triage actually executable by an agent;
  audit + redaction come free via the shared `invokeTool` wrapper (I8).
- **Approved by:** human (requested after the GBrain comparison).

## 2026-06-11 — M8: CJK-aware FTS (bigram fold) and chunk sizing

- **Context:** Bilingual eval (100 questions over an 18-doc zh/en/mixed fictional corpus)
  showed `to_tsvector('english', …)` cannot tokenize Han text: 39/40 Chinese queries had
  zero fts candidates (vector-only ranking), and the whitespace word-counting chunker never
  split Chinese documents (18 docs → 18 chunks). Amends spec §9 (chunking/query path) and
  the 004 search schema. New migration `009_cjk_fts.sql`, `src/util/cjk.ts`, `verify-m8`.
- **Decision:** (1) `cjk_fold()` rewrites Han runs into overlapping bigrams
  ("招商银行" → "招商 商银 银行") inside the regenerated `chunks.tsv` column (table rewrite
  backfills); a TS twin folds the query side in `ftsCandidates`, parity-tested against the
  SQL function. Non-CJK text is untouched — English indexing is byte-identical.
  (2) Query-side CJK stop-token filter: tokens composed only of Han function characters
  (我的, 什么, 时候…) are dropped — the 'english' stopword list doesn't know Chinese, and
  without this the zh→en bucket fell 80%→7% hit@1 from function-word noise.
  (3) Chunker sizes by tokens (each Han char = 1 token), splits oversized paragraphs at
  sentence boundaries (incl. 。！？；) with char-window fallback, and budgets the overlap
  tail in tokens.
- **Why:** Eval before/after — zh→zh: hit@1 90%→95%, hit@3 97.5%→100%, fts-dead queries
  39/40→1/40; mixed: hit@3 100%; English 100-question eval unchanged (92/99/100). Known
  trade-off: zh→en cross-lingual hit@1 80%→47% (content-word bigrams genuinely match
  same-language docs); the documented mitigation is dual-language querying in
  `agents/skills/query.md`, measured at hit@1 80% / hit@5 100% with rank fusion. Full
  suite 82 pass / 0 fail.
- **Approved by:** human (requested "engine fix" after the bilingual eval).
