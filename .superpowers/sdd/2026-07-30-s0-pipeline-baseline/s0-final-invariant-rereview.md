# S0 final invariant carry-forward rereview (Luna)

Advisory invariant rereview only; this is not a binding Sol verdict.

## Identity, scope, and method

- Exact candidate: `4ebf596b390c0d7818982e4d51161610669c15ab`.
- Exact tree: `617272d1d9e8fdb3aaf4c02be1fc5e36ba215382`.
- Prior invariant review: `s0-final-invariant-review.md:7-15`, exact `a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`.
- The `a79be39..d747` delta was Task 7.5 plan/evidence plus one test assertion; the `d747..4ebf`
  delta is exactly two report paths.  No application source, migration, fixture, harness,
  package/lockfile, Make, TypeScript, workflow, data, settings, backup, or runtime configuration
  path changed.
- Existing unrelated `.superpowers/s0-template-*` files were preserved.  No candidate file or
  commit was changed by this rereview.

## Independent carry-forward evidence

### Runtime and privacy

The independent natural-exit d747 gate from the preceding implementation review passed:

```text
1086 pass
1 skip
0 fail
9823 expect() calls
Ran 1087 tests across 52 files. [204.22s]
Biome: no fixes; TypeScript: pass; SUBSYSTEMS: ok;
MinimeBench: OK: all bars held, no regression; real 209.12
```

That runtime evidence carries unchanged to 4ebf because the new delta is report-only.  The
focused 4ebf redaction check independently passed `1 pass / 11 filtered out / 0 fail / 5 expect()`.
The only implementation assertion remains:

```text
expect(raw).not.toContain("4111 1111 1111 1111")
```

Full IBAN/account negatives and positive `[REDACTED:card]` / `[REDACTED:iban]` markers remain
unchanged (`test/m2.tools.test.ts:226-237`); UUID-preservation and account-marker unit coverage
remain unchanged (`test/redact.test.ts:10-16,19-47`).

### Isolation and residue

Immediately after the focused check at exact 4ebf, sanctioned engineering read-only checks
returned:

```text
generated minime_test_* databases: 0
active generated minime_test_* connections: 0
active minime source-template sessions: 0
established Ollama TCP connections: 0
minime role: rolsuper=f, rolcreaterole=t, rolcreatedb=t
minime_engineer_ro role: rolsuper=f, rolcreaterole=f, rolcreatedb=f
scorecard residue: 0
```

The four existing `minime_eval_*` databases remain documented evaluation fixtures, not generated
test residue.  No Bun test/wrapper/eval/restore child remained.  The executor's immutable d747
report records the same complete gate, residue, role, provider, dependency, and scope evidence
(`task-7.5-redaction-flake-report.md:45-64`; append-only Task 7 report `:181-189`).

## Invariant assessment

The prior invariant review's I1-I8 evidence remains valid because the only post-a79 changes are
the exact test literal and review/evidence records; no invariant-bearing runtime path changed.

| Invariant | Carry-forward assessment |
|---|---|
| **I1 Local-first** | **PASS.** No provider/config/runtime code changed. The full gate and focused test used mocked/local loopback behavior; no established Ollama connection remained. Prior I1 evidence remains valid (`s0-final-invariant-review.md:77`). |
| **I2 One door** | **PASS.** No MCP facade, DB wrapper, role, or harness changed. The test literal only narrows the privacy check; prior one-door/child-ownership evidence remains valid (`:78`). |
| **I3 Tiered egress** | **PASS.** No tier routing, RLS, provider, or egress code changed. The full gate's leak, role, and provider suites passed; generated/source/provider residue is zero. Prior I3 evidence remains valid (`:79`). |
| **I4 Archive/index/state split** | **PASS.** No archive, index, state, data-root, backup, or restore code changed; protected-path diff is empty. Prior I4 evidence remains valid (`:80`). |
| **I5 Provenance** | **PASS.** No row-writing or schema path changed; only one test assertion and report records changed. Prior I5 evidence remains valid (`:81`). |
| **I6 Numbers via SQL only** | **PASS.** No metric/query arithmetic or SQL boundary changed; full gate remains green. Prior I6 evidence remains valid (`:82`). |
| **I7 Honest answers** | **PASS.** MCP envelope/source/timestamp contracts and production redaction are unchanged; the focused assertion now checks the complete planted secret. Prior I7 evidence remains valid (`:83`). |
| **I8 Append-only audit** | **PASS.** No audit schema/writer changed; full suite covers append-only events and decision transcripts. Prior I8 evidence remains valid (`:84`). |

## Boundary and security checks

- **Redaction boundary: PASS.** The complete planted PAN is forbidden while legal UUID text may
  remain; full IBAN/account values and existing positive markers remain covered. No production
  redactor or UUID behavior changed.
- **Generated DB/source-template isolation: PASS.** Zero generated test databases/connections and
  zero source-template sessions; role posture remains `minime f|t|t`, engineering access `f|f|f`.
- **Provider/egress boundary: PASS.** No established provider connection remained and no provider
  code/config changed.
- **Protected paths: PASS.** `d747..4ebf` contains exactly the two report files; the full
  implementation tree remains the four approved Task 7.5 paths.

## Findings

### Critical

None.  No Critical invariant finding is being closed, downgraded, or adjudicated here.

### Important

None.

### Minor

None.

## Advisory disposition

- Invariants I1-I8: **PASS**.
- Boundary/privacy/egress/scope carry-forward: **PASS**.
- Findings: Critical **0**, Important **0**, Minor **0**.
- Ready for independent binding review on invariant scope: **YES (advisory)**.

This remains non-binding; the Task 7.5 implementation rereview is also Spec PASS / Quality PASS /
Ready YES at exact 4ebf, pending the independent Sol binding final review and closure-only ledger
step.
