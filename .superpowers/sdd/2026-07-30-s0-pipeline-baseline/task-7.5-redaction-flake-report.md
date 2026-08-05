# Task 7.5 execution report — exact card redaction assertion

Plan SHA: `58d203d8a15dcc5bf713c6fff7a800d586a474c0`
Base: `a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`
Worktree: `<ABS_REPO_PATH>/.claude/worktrees/stabilize-pipeline-baseline`

## Saved RED preserved before editing

The exact saved a79 Sol binding failure was preserved as evidence before implementation:

```text
Candidate: a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf
Command: /usr/bin/time -p make verify
1085 pass
1 skip
1 fail
9819 expect() calls
Ran 1087 tests across 52 files. [203.30s]
```

The failure was `test/m2.tools.test.ts:232`, where `expect(raw).not.toContain("4111")` matched
the unrelated legal UUID `40f475e9-7ebe-450c-a22b-fdb294111fcd`. The planted card, IBAN, and
account values were correctly absent and their redaction markers were present.

## Implementation ledger

The only product-adjacent change is the one approved semantic assertion substitution in
`test/m2.tools.test.ts`: the four-digit fragment check now checks the complete planted PAN
`4111 1111 1111 1111`. The full IBAN/account negatives and card/IBAN positive markers remain
unchanged. No other test, fixture, harness, product, package, Make, workflow, or configuration
path was changed.

## Pre-commit results

- `bun install --frozen-lockfile`: `Checked 290 installs across 202 packages (no changes)`.
- Exact named redaction loop: `20/20` independent processes passed; every process reported
  `1 pass`, `11 filtered out`, `0 fail`, and `5 expect() calls`.
- `MINIME_MOCK_OLLAMA=1 bun test test/m2.tools.test.ts`: `12 pass`, `0 fail`, `67 expect()
  calls`, one file, 1022ms.
- Natural `/usr/bin/time -p make verify`: `1086 pass`, `1 skip`, `0 fail`, `9823 expect()
  calls`, 1087 tests across 52 files, test time 202.94s, total `real 208.04`; Biome,
  TypeScript, `SUBSYSTEMS: ok`, and MinimeBench all passed.
- The generated MinimeBench scorecard was removed because it is outside the authorized paths.

## Immutable candidate results

The single implementation commit is:

```text
SHA: d74768b4b7b366406ab9f140029cd987fd3fb3e6
tree: 1df0f98c861b520b4b9b7e61a0ce77c8906ed95f
```

At that immutable HEAD, the separate natural `/usr/bin/time -p make verify` passed with
`1086 pass`, `1 skip`, `0 fail`, `9823 expect() calls`, `Ran 1087 tests across 52 files.
[202.00s]`, and total `real 207.09` seconds. Biome had no fixes, TypeScript 5.9.3 passed,
`SUBSYSTEMS: ok`, and MinimeBench reported `OK: all bars held, no regression`.

Post-gate evidence: no Bun test/wrapper/restore/fixture processes remained; generated
`minime_test_*` databases and connections were both zero; no source-template activity remained;
no established provider connection was present (the pre-existing loopback Ollama listener was
only LISTEN); roles were `minime | f | t | t` and `minime_engineer_ro | f | f | f`; the
dependency diff was empty; the committed tree contained exactly the four authorized paths; and
the unrelated `.superpowers/s0-template-*` files remained preserved.
