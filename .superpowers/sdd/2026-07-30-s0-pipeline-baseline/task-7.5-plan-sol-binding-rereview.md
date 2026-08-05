# S0 Task 7.5 corrected-plan binding rereview (Sol, independent)

## Binding identity and verdict

- Plan path: `docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md`
- Amendment: Task 7.5, “Stabilize the redaction assertion exposed by the binding gate”
- Exact corrected `PLAN_SHA`: `58d203d8a15dcc5bf713c6fff7a800d586a474c0`
- Exact corrected tree: `556cd6fc5cc0a71634e6a83a371c4ab496942e06`
- Rejected prior plan SHA:
  `9685fa2e177c95921d2e6a627972e095b537a462`
- Corrective range:
  `9685fa2e177c95921d2e6a627972e095b537a462..58d203d8a15dcc5bf713c6fff7a800d586a474c0`
- Parent implementation candidate:
  `a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`

**Binding verdict: PASS.**

- Spec: **PASS**
- Quality: **PASS**
- Findings: **Critical 0 / Important 0 / Minor 0**
- Prior Sol Important: **CLOSED**
- Luna executor may implement: **YES, only from exact corrected PLAN_SHA
  `58d203d8a15dcc5bf713c6fff7a800d586a474c0`**

No implementation or acceptance command was run for this plan rereview.

## Independent review basis

I independently reviewed:

- the exact corrected SHA/tree and `9685fa2..58d203d` delta;
- the complete Task 7.5 amendment in its governing S0 plan;
- both Task 7.5 `DECISIONS.md` entries;
- the complete Task 7/7.5 progress chronology;
- the exact-a79 binding failure artifact;
- the rejected first Sol plan review;
- the advisory first-pass plan review;
- the current M2 integration assertion and focused redaction/UUID unit coverage.

The advisory review was treated as input, not authority. This binding disposition follows the
corrected plan text, current contracts, and exact diff.

The corrective commit is plan/evidence only:

```text
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/progress.md
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7.5-plan-luna-review.md
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7.5-plan-sol-binding.md
DECISIONS.md
docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md
```

`git diff --check` is clean. There is no product, test, fixture, harness, dependency, Make,
TypeScript, workflow, migration, data, settings, or backup change in the plan correction.

## Root cause and minimum authorization

The plan continues to bind the observed failure correctly:

```text
expect(raw).not.toContain("4111")
```

failed because a separate legal UUID,
`40f475e9-7ebe-450c-a22b-fdb294111fcd`, contained the substring `4111`. The planted PAN, IBAN,
and account were all correctly replaced in the raw MCP response. UUID preservation is intentional
one-door behavior, so product redaction and UUID handling must not change.

The authorized implementation is the minimum safe change:

```text
test/m2.tools.test.ts
```

changes exactly one assertion from the four-digit fragment to the complete planted PAN:

```text
expect(raw).not.toContain("4111 1111 1111 1111");
```

The three authorized evidence paths are:

```text
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7-report.md
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7.5-redaction-flake-brief.md
.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-7.5-redaction-flake-report.md
```

No second test or semantic change is permitted. The existing assertions remain mandatory:

```text
expect(raw).not.toContain("DE89370400440532013000");
expect(raw).not.toContain("123456789012");
expect(raw).toContain("[REDACTED:card]");
expect(raw).toContain("[REDACTED:iban]");
```

Thus the complete card, complete IBAN, and complete account value remain forbidden in the raw
response, while both baseline positive markers remain required. The assertion count remains
unchanged.

## Supersession safety

The corrected plan and decision entry explicitly supersede only the failure artifact's optional
fixed-UUID and “all three marker” suggestion. That supersession is technically safe:

- `test/redact.test.ts` already proves canonical UUIDs survive byte-identically in plain and
  nested-envelope forms, including card/account-like UUID runs.
- The saved natural-exit a79 failure contains the exact legal UUID with `4111`; no invented fixture
  is needed to prove that string collision.
- A full-PAN negative check cannot collide with a canonical UUID's four-character substring.
- `test/redact.test.ts` already positively checks `[REDACTED:account]`.
- The M2 integration baseline has only two positive markers—card and IBAN—and both remain.
- The M2 account boundary is its full account-value absence check, which also remains.

Adding a fixed UUID, fixture, helper, account-marker assertion, or second test would expand scope
without strengthening the exact integration regression being repaired. The corrected amendment
properly freezes all of them.

The saved failure artifact remains immutable historical evidence; the corrected, independently
reviewed plan is the prospective implementation authority. This resolves the prior artifact/plan
conflict rather than silently ignoring it.

## Closure of the prior Sol Important

The rejected plan described “20 fail-fast fresh processes” only in prose. The corrected Step 3 now
binds the exact executable contract:

```bash
bun install --frozen-lockfile
(
  set -e
  for run in {1..20}
  do
    MINIME_MOCK_OLLAMA=1 bun test test/m2.tools.test.ts \
      --test-name-pattern \
      'redaction: card numbers, IBANs, long account numbers never leave the server'
  done
)
MINIME_MOCK_OLLAMA=1 bun test test/m2.tools.test.ts
/usr/bin/time -p make verify
```

This closes every part of the finding:

- The isolated subshell uses `set -e`, so the first nonzero run stops the loop and cannot be
  hidden by run 20.
- Brace expansion fixes the count at exactly 20.
- Each `bun test` invocation is a distinct process.
- The normal `bunfig.toml` preload provisions a fresh guarded database for every process.
- The exact test-name pattern binds one redaction case per process.
- Required focused evidence is `20/20`, zero failure.
- The complete M2 evidence is exactly `12 pass / 0 fail / 67 expectations`.
- The first natural-exit full gate is explicit and must record exact counts and duration.

Corrected Step 5 separately binds:

```bash
git rev-parse HEAD
/usr/bin/time -p make verify
git diff --check
git status --short
```

The second `make verify` runs only after the one implementation commit, at its recorded immutable
SHA. It is explicitly a separate natural-exit gate, not a retry substitution, and must include
Biome, TypeScript 5.9.3, subsystem, MinimeBench, residue, role, dependency, and four-path scope
evidence.

The plan therefore requires two complete authoritative gates:

1. pre-commit after the one assertion edit; and
2. post-commit at the immutable candidate SHA.

## Frozen boundary and stop conditions

Task 7.5 forbids drift in:

- `src/mcp/redact.ts` or any other product code;
- UUID behavior, seeds, fixtures, helpers, and all other tests;
- `test/setup.ts`, `test/support/test-database.ts`, and database wrappers;
- `package.json`, `bun.lock`, `tsconfig.json`;
- `Makefile`, `.github/workflows/eval.yml`, and other documentation;
- migrations, environment/settings, data, backups, sibling worktrees, and unrelated files.

Implementation stops on:

- any mismatch from the one-test-plus-three-evidence-path ledger;
- appearance of the complete PAN, IBAN, or account value;
- removal/weakening of either existing positive marker;
- any fixed UUID, fixture, helper, second-test, product, package, Make, or workflow change;
- any focused, M2, or full-gate failure;
- any early loop failure or competing gate process;
- any database/source/provider/process residue or changed `minime` `f|t|t` posture;
- any request for a broader flake sweep;
- any Critical or Important implementation review finding.

Final closure requires fresh Luna xhigh implementation rereview and independent Sol xhigh binding
final review at the same exact candidate SHA/tree, with **Critical 0 / Important 0 / Minor 0**.

## DECISIONS.md status

The original exact-card decision and the corrective evidence-scope clarification satisfy spec
§0.3 by recording the deviation, reasoning, retained privacy contract, rejected alternatives, and
supersession. Their approval status remains honestly recorded as agent-proposed under the
owner-approved S0 execution scope and pending owner ratification. That status is not a separate
implementation blocker under §0.3, but downstream evidence must not call it human-ratified unless
the owner later ratifies it.

## Binding disposition

The corrected plan is exact, minimal, testable, fail-fast, privacy-preserving, and closed against
scope drift. The rejected SHA `9685fa2e177c95921d2e6a627972e095b537a462` remains
non-authoritative.

**Final result: Spec PASS / Quality PASS / C0-I0-M0 / LUNA EXECUTOR AUTHORIZED FROM EXACT
`58d203d8a15dcc5bf713c6fff7a800d586a474c0` ONLY.**
