# S0 final binding review (Sol, independent)

## Binding disposition

- Exact candidate: `a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`
- Exact tree: `06b83db85844da3267d32ce69639716734e282f6`
- Full S0 implementation lineage:
  `1867bf38196a9e411acf93927586552c554c0c4c..a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`
- Task 7 lineage:
  `5b52239ed60c58e02dc296724159fc2f221f20f5..a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`
- Initial Task 7 implementation:
  `5b52239ed60c58e02dc296724159fc2f221f20f5..07ae9d60e6e04040b73b174b0f02b3d6bee42caa`
- Review fix:
  `07ae9d60e6e04040b73b174b0f02b3d6bee42caa..a59919ab3f529bfdfc3896de2cd10a6dbf8c3672`
- Evidence correction:
  `a59919ab3f529bfdfc3896de2cd10a6dbf8c3672..a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`

**Binding verdict: FAIL / NOT READY TO FINISH.**

The product/privacy invariants, implementation scope, dependency pin, wrapper contracts, and
post-run cleanup are sound. However, the required fresh natural-exit `make verify` failed on the
exact candidate. The failure is a nondeterministic false positive in an existing MCP redaction
assertion: an unrelated generated UUID contained `4111`. Task 7 makes this test part of the
authoritative merge gate, so the candidate does not yet meet the explicit acceptance requirement
that the complete gate pass.

Severity counts: **Critical 0, Important 1, Minor 0**.

## Review provenance and independence

I reread the exact S0 and Task 7 lineages, the approved S0 plan, the Task 7 brief/report, the prior
Task 5/6/6.5/6.75/R2 joint binding closure, the Task 7 Luna review and re-review, the SDD progress
ledger, and the final invariant review. The advisory inputs were:

- Task 7 Luna re-review at the exact candidate: advisory PASS, C0/I0/M0.
- Full S0 invariant review over the exact lineage: I1-I8 PASS, C0/I0/M0.

Those advisory results were considered but not substituted for fresh binding evidence. This review
ran its own frozen install, static/dry-run contract checks, natural-exit gate, focused diagnostic,
and immediate residue checks. No candidate code, configuration, dependency, schema, data, or commit
was changed by this review.

## Fresh binding evidence

### Identity and dependencies

`git rev-parse HEAD` and `git rev-parse HEAD^{tree}` returned the exact SHA/tree above.

```text
bun install --frozen-lockfile
Checked 290 installs across 202 packages (no changes) [33.00ms]

bun run tsc --version
Version 5.9.3
```

`package.json` has the required non-mutating `lint`, mutating `format`, strict `typecheck`, and
unscoped `test` scripts. The only dependency delta in Task 7 is exact
`typescript: "5.9.3"` plus its matching lock entry.

### Static and dry-run contracts

The complete final-acceptance inventories and dry runs were repeated at the exact candidate:

```text
rg -n 'validateEdges\(' src scripts test
rg -n 'migrate\(|resetDb\(|resetAndSeed\(|seedCorpus\(' src scripts test Makefile
rg -n 'createdb|create extension|minime_eval' \
  Makefile scripts/with-test-database.ts scripts/eval-pmb.sh .github/workflows/eval.yml
rg -n 'minime_test' \
  test/support/test-database.ts scripts/with-test-database.ts \
  Makefile .github/workflows/eval.yml
make -n eval-skills ROUND=r1
make -n optimize-skill SUITE=query ROUND=r1
make -n verify-m0
make -n verify-m0-offline
make -n verify-offline
make -n verify
```

Results:

- Only the provider-routing regression injects `validateEdges`.
- Migration/reset/seed callers are covered by their sanctioned context or parent wrapper.
- `eval-skills` and `optimize-skill` are wrapper-owned.
- Standalone `verify-m0` remains direct and live-capable.
- Offline M0 is mocked and places `scripts/with-test-database.ts` before
  `src/verify/m0.ts`.
- `verify-offline` contains exactly one unscoped `bun test`, then non-mutating Biome,
  TypeScript, and subsystem checks.
- `verify` adds wrapper-owned mocked `scripts/eval-search.ts`, with the wrapper before the
  child.
- Shared `minime_test` matches are limited to the module-private source constant/refusal
  contracts and the reviewed CI bootstrap.

The broad create/eval inventory also reports the preserved owner-run LongMemEval recipe at
`Makefile:155-161` (`createdb` and `minime_eval_lme1`). Earlier binding plan text explicitly
preserves LongMemEval and the executable destructive-caller exclusion accepts it; the final
acceptance prose is globally worded and therefore ambiguous. Consistent with the prior advisory
and invariant reviews, I adjudicate this as the already-reviewed LongMemEval exemption, not a new
Task 7 violation. The wording should be clarified in a future plan-only edit; it does not authorize
inventing new implementation scope here.

### Required authoritative gate

Fresh command at the exact candidate:

```text
/usr/bin/time -p make verify
```

Natural exit:

```text
1085 pass
1 skip
1 fail
9819 expect() calls
Ran 1087 tests across 52 files. [203.30s]
make: *** [test] Error 1
real 203.77
user 21.84
sys 20.72
```

Because the unscoped test prerequisite failed, Make correctly stopped before lint, typecheck,
subsystem, and MinimeBench prerequisites could complete in this run. Their prior green evidence
does not convert this exact failed execution into acceptance.

### Immediate residue checks after the failed gate

Post-run checks returned:

```text
native_role=false|true|true
source_template_owner=minime
generated_databases=0
generated_activity=0
source_template_activity=0
```

No Bun test, wrapper, M0, eval, or restore child remained. No established TCP connection to the
loopback Ollama port remained. HEAD and tree were unchanged. The only visible untracked files were
the pre-existing unrelated `.superpowers/s0-template-*` artifacts. No generated scorecard existed
because Make stopped at the test prerequisite.

## Finding

### Important — authoritative gate can fail when an unrelated UUID contains the card prefix

Path: `test/m2.tools.test.ts:226-236`.

The redaction boundary test asserts:

```text
expect(raw).not.toContain("4111");
```

The fresh failing response correctly contained:

```text
"Call bank about card [REDACTED:card]and IBAN [REDACTED:iban] re account [REDACTED:account]"
```

It also contained an unrelated seeded page ID:

```text
40f475e9-7ebe-450c-a22b-fdb294111fcd
```

That UUID contains the substring `4111`, so the four-character negative assertion failed even
though the actual PAN, IBAN, and account value did not leave the server. The stack points exactly to
`test/m2.tools.test.ts:232`.

A wrapper-owned focused diagnostic rerun:

```text
MINIME_MOCK_OLLAMA=1 bun run scripts/with-test-database.ts \
  --label verify_m0 -- bun test test/m2.tools.test.ts
```

passed `12 pass, 0 fail, 67 expect()` in 1.382s with a different generated UUID. This confirms
random-identifier sensitivity; it does not clear the failed full gate.

Impact:

- The explicit Task 7 and final acceptance command did not pass at the exact candidate.
- A correct privacy result can nondeterministically fail CI.
- Task 7's stated goal is an authoritative, stable local/CI gate, so this is load-bearing rather
  than cosmetic evidence drift.

The defect predates Task 7, but Task 7 newly promotes the unscoped suite into the authoritative
gate. It must therefore be resolved or explicitly amended before a binding PASS.

## Required remediation plan

Do not edit production redaction behavior; the observed output proves it worked. Do not weaken the
privacy contract. The minimum safe remediation is test-only:

1. Add a plan-only/path-ledger amendment authorizing the narrow edit to
   `test/m2.tools.test.ts`. This file is outside Task 7's nine approved paths, and the current stop
   conditions prohibit silently expanding scope.
2. Replace the ambiguous four-digit absence check with an assertion against the full source PAN
   (`4111 1111 1111 1111`) and retain the exact marker assertions for
   `[REDACTED:card]` and `[REDACTED:iban]`. Continue asserting the full account number is absent.
   Prefer locating the inserted task in the parsed envelope and checking its title/snippet/source
   fields so unrelated identifiers cannot satisfy or defeat the privacy assertion.
3. Add deterministic coverage showing that a legal UUID containing `4111` may be present while the
   full PAN remains absent and all three redaction markers are present. The pre-fix expected RED is
   the same false-positive condition captured above; the corrected test must pass without changing
   `src/mcp/redact.ts`.
4. Have a Luna xhigh executor make only the approved test change and commit it. Require a fresh
   Luna xhigh code/behavior re-review and a new independent Sol xhigh binding review at the new exact
   SHA/tree.
5. Run, in order:

```text
bun install --frozen-lockfile
MINIME_MOCK_OLLAMA=1 bun run scripts/with-test-database.ts \
  --label verify_m0 -- bun test test/m2.tools.test.ts
bun test test/verify-contract.test.ts
make verify
git diff --check
git status --short
```

Acceptance evidence must include:

- focused MCP test: 0 failures;
- verification-contract test: 7 pass, 0 fail, 42 expectations unless an intentional,
  reviewed assertion changes the count;
- one fresh natural-exit `make verify`: exit 0, 1087 tests across 52 files, 0 fail, with exact
  pass/skip/expect counts and duration recorded;
- Biome no-fix pass, TypeScript 5.9.3 pass, `SUBSYSTEMS: ok`, and MinimeBench all bars held;
- zero generated `minime_test_*` databases/connections, zero source-template activity, no gate
  child process, and no established provider connection immediately afterward;
- unchanged protected paths and exact dependency delta.

Stop again if the remediation touches production redaction, relaxes full-secret/marker checks,
changes dependencies, expands outside the amended test/report/review paths, leaves residue, or if
either focused or full gate fails.

## Task and invariant labels

| Area | Binding result |
|---|---|
| Task 1 — offline validation seam | PASS |
| Task 2 — owned DB planner | PASS |
| Task 3 — ownership lifecycle | PASS |
| Task 4 — migration contexts | PASS |
| Task 5 — updater bridge | PASS |
| Task 6 — database isolation | PASS |
| Task 6.5 — H3 timeout amendment | PASS |
| Task 6.75 — typecheck readiness amendment | PASS |
| Task 6 R2 and joint closure | PASS |
| Task 7 — authoritative gate | **FAIL** |
| Final acceptance | **FAIL** |

Invariants I1-I8 remain **PASS** on the reviewed implementation. The failure is in the
authoritative test-gate reliability, not evidence of tiered-data egress or a runtime privacy
regression.

## Final assessment

- Spec: **FAIL** — required `make verify` exited nonzero.
- Quality: **FAIL** — the authoritative gate has a demonstrated random-UUID false positive.
- Invariants: **PASS (I1-I8)**.
- Findings: **C0 / I1 / M0**.
- Ready to finish branch: **NO**.

The exact candidate must remain unmodified until the path amendment and delegated remediation are
approved. No completion or branch-finish action is authorized by this review.
