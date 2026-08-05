# W2 — Subsystem inventory & complexity budget Implementation Plan

> **Historical implementation record.** W2 shipped. Its mandatory skills, wave/PR rules, review
> gates, and branch choreography are inactive; the lightweight inventory rule now lives in
> `docs/DEVELOPMENT.md` and `docs/SUBSYSTEMS.md`.

**Goal:** One committed document answers: what subsystems exist, which eval justifies each, what
deleting one costs, and where its maintenance history lives — enforced by a deterministic CI
check and a CLAUDE.md complexity-budget rule, so "should we delete X?" becomes a table lookup.

**Architecture:** `docs/SUBSYSTEMS.md` (five fields per row) + `scripts/check-subsystems.ts`
(offline, deterministic: doc ↔ `src/` structural coverage in both directions — no git-diff
dependency, so it runs identically locally and in CI) + guardrail text in CLAUDE.md. Also fixes
the verify-target hygiene gap found in reconnaissance: `make verify` stops at m9 while m10–m12
suites exist.

## Global constraints

- The checker is pure filesystem + markdown parsing: no network, no DB, no git (CI parity).
- Every row's cited `src/` paths must exist (stale rows fail CI too — the doc cannot rot).
- No new dependencies.

## Files

- Create: `docs/SUBSYSTEMS.md`, `scripts/check-subsystems.ts`, `test/subsystems.test.ts`
- Modify: `Makefile` (check-subsystems, verify-m10/11/12, verify chain), `CLAUDE.md`,
  `.github/workflows/eval.yml` (one step)
- Append: `DECISIONS.md`

**Interfaces produced:**

```ts
// scripts/check-subsystems.ts
export function checkSubsystems(repoRoot: string): { ok: boolean; problems: string[] };
```

---

### Task 1: Seed `docs/SUBSYSTEMS.md`

- [ ] **Step 1.1: Create the document** with this exact structure (rows seeded from the 2026-07-18
reconnaissance; the executor fills each row's *Maintenance* cell with real DECISIONS.md heading
anchors by grepping DECISIONS.md for the subsystem's files, and corrects any delta figures against
docs/benchmarks/ scorecards — figures below marked "≈" are from the improvement proposal and must
be verified against the committed scorecards before commit):

```markdown
# Subsystem inventory (W2 — complexity budget)

One row per subsystem. **A new subsystem may land only with (a) a row here, (b) a justifying
eval with a committed floor, and (c) an explicit statement of what it replaces or why net
surface must grow** (CLAUDE.md rule; CI checks structural coverage via
`scripts/check-subsystems.ts`).

Fields: **What/where** (paths are checked by CI) · **Justifying eval + delta** · **Deletion
cost** · **Dependencies** · **Maintenance** (DECISIONS.md entries touching it).

| Subsystem | What / where | Justifying eval + delta | Deletion cost | Dependencies | Maintenance |
|---|---|---|---|---|---|
| MCP door | `src/mcp/` (server, 13 tools, envelope, redact, audit) | m2 tools suite; m6 leak suite (200 fuzzed calls, zero tier leaks) | the product stops existing (I2) | @modelcontextprotocol/sdk | (fill) |
| Tier/RLS enforcement | `src/db/repo.ts` predicate; `db/migrations/007,013` | m6 leak suite; privacy-hardening suite | agents read everything — never | Postgres RLS | (fill) |
| Hybrid search core | `src/search/hybrid.ts` (RRF+blend+multipliers) | MinimeBench all areas; ≈ retrieval-en hit@1 92% | no search product | pgvector, FTS | (fill) |
| Intent nudges | `src/search/intent.ts` | MinimeBench time/entity areas (zero-LLM) | revert to flat weights; small area losses | none | (fill) |
| Title-phrase boost | `src/search/title-match.ts` | MinimeBench identity area | identity recall drops | none | (fill) |
| Reranker | `src/search/rerank.ts` (bge-reranker-v2-m3 via llama-server) | ≈ LongMemEval recall@1 74.8→88.6; PMB precision 6.5→52.3 | fail-open exists; revert to RRF order; floors drop to no-rerank baselines | llama.cpp daemon, GGUF file | (fill) |
| Autocut | `src/search/autocut.ts` | PMB precision experiment (fails open on flat curves — documented negative result) | keep fixed top-k | reranker scores | (fill) |
| Chunker + CJK | `src/search/chunker.ts`, `src/util/cjk.ts`, migrations 009/010 | m8 CJK suite; retrieval-zh area (hit@3 ≥ 95%) | zh retrieval collapses | none | (fill) |
| Provider layer + egress audit | `src/llm/` | providers suite (request shapes, egress rows, tier gate) | local-only Ollama fallback | per-provider creds | (fill) |
| Embedding pipeline | `src/search/embed.ts`, `index-parent.ts` | m3 retrieval eval; MinimeBench | FTS-only search | Ollama/OpenRouter | (fill) |
| Edge extractor (zero-LLM) | `src/pipeline/extract-edges.ts` | m7 graph suite; MinimeBench graph area (15/15) | graph boost + works_at answers gone | none | (fill) |
| Extractor re-validation | `src/pipeline/validate-edges.ts` (W1) | m14 planted-corpus bar (3/3 flagged, 0 false) | phantom-entity class reopens | classify provider | (fill) |
| Compiled notes | `src/pipeline/notes.ts` | MinimeBench notes-boost lift (largest documented single lift, ×1.5 boost) | biggest retrieval regression of any single deletion | dream job | (fill) |
| Decision engine + interview + digests | `src/mcp/tools/decisions.ts`, `src/pipeline/decision-digest.ts`, migration 014 | m5 suite; decision-digest area (hit@3 = 1.0 provisional) | decisions become flat rows | none | (fill) |
| Watcher + classifier | `src/pipeline/watcher.ts`, `classify.ts`, `dedup.ts` | m4 e2e; m10 guardrails; m12 phantom-org | capture becomes manual filing | chokidar | (fill) |
| Importers | `src/importers/` | m4 golden-file suites (idempotency) | no calendar/tx/health/email mirrors | none | (fill) |
| Dream job | `src/pipeline/dream.ts` (10 steps) | per-step suites (m9 notes, m12 watchdog, m14 validation) | no nightly maintenance; backlog grows | croner | (fill) |
| Backup/PITR | `src/pipeline/backup.ts`, `scripts/restore-*.sh`, `pick-snapshot.ts` | backup suite; restore-drill target | one bad write is unrecoverable | restic, pg_dump | (fill) |
| MinimeBench harness | `src/search/eval.ts`, `scripts/eval-search.ts`, `fixtures/qrels/` | is itself the gate (sealed gold, committed floors) | flying blind on retrieval changes | none | (fill) |
| Public benchmarks | `scripts/eval-longmemeval.ts`, `eval-precisionmembench.ts`, `pmb-server.ts` | external reference points (LongMemEval-s recall@5 ≈97.2%; PMB precision 52.3%) | lose outside calibration | HF datasets, PMB_DIR clone | (fill) |
| SkillEval + SkillOpt | `scripts/eval-skills.ts`, `skill-eval-lib.ts`, `optimize-skill.ts` | SkillEval behavioral contracts; optimizer validated on suite `query` | skills evolve unmeasured | live model creds | (fill) |
| Access-frequency boost | migration `011_access_index.sql`, boost in `hybrid.ts` (±0.05 band) | **eval-calibration pending** — none committed yet | delete = remove one multiplier; zero floor impact today | events table | (fill) |
| Session capture hook | `scripts/install-session-hook.sh`, `agents/hooks/` | session-capture suite | no episodic memory of coding sessions | Claude Code hooks | (fill) |

## First-pass complexity-budget verdicts (2026-07)

- **Access-frequency boost** — still `eval-calibration pending` with a ±0.05 band. Verdict:
  justifying eval **scheduled** — piggyback a calibration arm on W8's live battery (same runs,
  boost on/off). If it cannot show a stable lift there, park it behind a flag and zero the band.
- **SkillOpt (optimizer loop)** — validated but bottlenecked on train-set coverage. Verdict:
  **parked** (owner-triggered `make optimize-skill` only); revisit after the improvement
  program; next step remains the gbrain-style self-rewriting loop over SkillEval task splits.
```

- [ ] **Step 1.2: Fill the Maintenance cells** — grep DECISIONS.md headings per subsystem
(`grep -n "^## " DECISIONS.md`) and reference entries as `DECISIONS.md § <date> — <title>`;
verify the ≈ deltas against `docs/benchmarks/` scorecards, replacing with exact committed numbers
(e.g. the 2026-06-12 live-final scorecard for rerank/notes figures). Remove every "(fill)".

- [ ] **Step 1.3: Commit** — `git add docs/SUBSYSTEMS.md && git commit -m "docs: subsystem inventory with complexity-budget verdicts (W2)"`

---

### Task 2: Structural CI check

- [ ] **Step 2.1: Failing test** — create `test/subsystems.test.ts`:

```ts
// W2: the inventory cannot rot — every src/ top-level module needs a row, every cited path
// must exist. Pure filesystem; runs identically locally and in CI.
import { describe, expect, test } from "bun:test";
import { checkSubsystems } from "../scripts/check-subsystems";

describe("subsystem inventory coverage", () => {
  test("the committed doc covers the committed tree", () => {
    const res = checkSubsystems(process.cwd());
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test("a module missing from the doc is reported", async () => {
    const tmp = `${process.cwd()}/node_modules/.subsys-fixture`;
    const { mkdirSync, rmSync, writeFileSync, cpSync } = await import("node:fs");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(`${tmp}/src/rocketry`, { recursive: true });
    mkdirSync(`${tmp}/docs`, { recursive: true });
    cpSync(`${process.cwd()}/docs/SUBSYSTEMS.md`, `${tmp}/docs/SUBSYSTEMS.md`);
    cpSync(`${process.cwd()}/src`, `${tmp}/src`, { recursive: true });
    writeFileSync(`${tmp}/src/rocketry/launch.ts`, "export {};\n");
    const res = checkSubsystems(tmp);
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("src/rocketry");
    rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2.2: Run** — `bun test test/subsystems.test.ts` → FAIL (script missing).

- [ ] **Step 2.3: Create `scripts/check-subsystems.ts`**

```ts
// W2 complexity-budget gate: docs/SUBSYSTEMS.md ↔ src/ structural coverage, both directions.
// Rule v1 (deliberately simple + deterministic): every top-level entry under src/ must be
// mentioned in some row's "What / where" cell, and every `src/...` path cited anywhere in the
// doc must exist. No git, no network — identical result locally and in CI.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function checkSubsystems(repoRoot: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const docPath = join(repoRoot, "docs/SUBSYSTEMS.md");
  if (!existsSync(docPath)) return { ok: false, problems: ["docs/SUBSYSTEMS.md is missing"] };
  const doc = readFileSync(docPath, "utf-8");

  // direction 1: every cited src/ path exists (rows cannot rot)
  const cited = [...doc.matchAll(/`(src\/[^`]+?)`/g)].map((m) => m[1]!);
  for (const p of new Set(cited)) {
    if (!existsSync(join(repoRoot, p))) problems.push(`cited path does not exist: ${p}`);
  }

  // direction 2: every top-level src/ entry is covered by some row
  for (const entry of readdirSync(join(repoRoot, "src"))) {
    const rel = `src/${entry}`;
    const isDir = statSync(join(repoRoot, rel)).isDirectory();
    const needle = isDir ? `src/${entry}/` : rel;
    if (!doc.includes(needle) && !doc.includes(rel))
      problems.push(`no SUBSYSTEMS.md row mentions ${rel} — add a row (complexity budget) or fold it into an existing one`);
    void isDir;
  }
  return { ok: problems.length === 0, problems };
}

if (import.meta.main) {
  const res = checkSubsystems(process.cwd());
  for (const p of res.problems) console.error(`SUBSYSTEMS: ${p}`);
  console.log(res.ok ? "SUBSYSTEMS: ok" : `SUBSYSTEMS: ${res.problems.length} problem(s)`);
  process.exit(res.ok ? 0 : 1);
}
```

*(For direction 2 to pass, the seeded doc must mention `src/cli.ts`, `src/onboard.ts`,
`src/db/`, `src/util/`, `src/verify/` somewhere — add a final "Plumbing (not subsystems)" line
under the table: `CLI/onboard/config/clock/verify plumbing: src/cli.ts, src/onboard.ts,
src/db/, src/util/, src/verify/ — glue, no independent eval, deleted only with their owners.`
backtick-quoting each path so direction 1 checks them too.)*

- [ ] **Step 2.4: Run** — both tests PASS. `bunx tsc --noEmit` clean.
- [ ] **Step 2.5: Commit** — `git add scripts/check-subsystems.ts test/subsystems.test.ts docs/SUBSYSTEMS.md && git commit -m "feat(ci): subsystem-inventory structural check (W2)"`

---

### Task 3: Wiring — Makefile hygiene, CI, CLAUDE.md rule, DECISIONS

- [ ] **Step 3.1: Makefile** — add:

```makefile
check-subsystems:
	@$(BUN) run scripts/check-subsystems.ts

verify-m10:
	@$(BUN) test test/m10.*.test.ts

verify-m11:
	@$(BUN) test test/m11.*.test.ts

verify-m12:
	@$(BUN) test test/m12.*.test.ts
```

Extend the `verify` chain to `... verify-m9 verify-m10 verify-m11 verify-m12 check-subsystems
eval-search` (keep eval-search last; W3/W1/W4 append their own verify-m13/14/15 when they land).
Add all four new targets to `.PHONY`.

- [ ] **Step 3.2: CI** — in `.github/workflows/eval.yml`, after the `bun test` step add:

```yaml
      - name: Subsystem inventory gate
        run: bun run scripts/check-subsystems.ts
```

- [ ] **Step 3.3: CLAUDE.md** — add under "Workflow rules":

```markdown
- **Complexity budget (W2):** a new subsystem lands only with (a) a `docs/SUBSYSTEMS.md` row,
  (b) a justifying eval with a committed floor, and (c) an explicit statement of what existing
  subsystem it replaces or why net surface must grow. `make check-subsystems` (in `verify` and
  CI) enforces structural coverage.
```

- [ ] **Step 3.4: Full gates** — `bun test`, `make verify` (now including m10–m12 +
check-subsystems), `make eval-search`, `biome`, `tsc` all green.

- [ ] **Step 3.5: DECISIONS.md entry**

```markdown
## 2026-07-XX — W2: subsystem inventory + complexity budget

- **Context:** ~20 substantial subsystems, one owner, decade ambition; no document mapped
  subsystem → justifying eval → deletion cost. `make verify` had drifted (m10–m12 suites
  existed outside the gate).
- **Decision:** docs/SUBSYSTEMS.md (five fields/row) + scripts/check-subsystems.ts structural
  CI gate (doc↔src coverage both directions, no git dependency) + CLAUDE.md budget rule.
  First verdicts: access-frequency boost gets its calibration arm piggybacked on W8's live
  battery or is parked; SkillOpt parked owner-triggered pending train-set coverage. Also
  backfilled verify-m10/11/12 into `make verify`.
- **Why:** Cheapest structural defense against unowned complexity; converts deletion debates
  into table lookups.
- **Approved by:** human (owner, 2026-07-18 improvement plan §3).
```

- [ ] **Step 3.6: Commit + review** — `git add Makefile .github/workflows/eval.yml CLAUDE.md DECISIONS.md && git commit -m "chore(gates): verify hygiene m10-m12 + subsystems gate + budget rule (W2)"` — Sonnet first-pass, then invariant-reviewer.

## Acceptance gates (workstream-level)

1. Every existing subsystem has a completed row (no "(fill)" left); cited paths verified by CI.
2. `make verify` includes m10–m12 + check-subsystems and is green.
3. The two marginal candidates carry explicit verdicts with next actions.
4. invariant-reviewer PASS.
