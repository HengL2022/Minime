# Task 7.5 brief — exact card redaction assertion

Plan SHA: `58d203d8a15dcc5bf713c6fff7a800d586a474c0`
Base: `a79be392b11f26d7a4f54de7a5961e4a1aa4eaaf`
Worktree: `<ABS_REPO_PATH>/.claude/worktrees/stabilize-pipeline-baseline`

## Saved RED evidence

The exact a79 binding gate failed at `test/m2.tools.test.ts:232`:

```text
1085 pass
1 skip
1 fail
9819 expect() calls
Ran 1087 tests across 52 files. [203.30s]
```

The failing assertion was:

```text
expect(raw).not.toContain("4111");
```

The raw response correctly redacted the planted PAN, IBAN, and account. A separate legal page
UUID, `40f475e9-7ebe-450c-a22b-fdb294111fcd`, contained the unrelated four-digit substring
`4111` and caused the false positive.

## Authorized implementation

Make exactly one semantic substitution in `test/m2.tools.test.ts`:

```text
expect(raw).not.toContain("4111 1111 1111 1111");
```

Retain the full IBAN and account-number negatives and the existing positive
`[REDACTED:card]` and `[REDACTED:iban]` assertions. Update only the Task 7 report and create the
Task 7.5 report alongside this brief. No product, fixture, harness, dependency, Make, workflow,
or other test changes are authorized.

## Required evidence

- Frozen install.
- Twenty independent `MINIME_MOCK_OLLAMA=1` named redaction processes, fail-fast, each 1/0.
- Complete M2: 12 pass, 0 fail, 67 expectations.
- Natural pre-commit `make verify`.
- Single commit: `test: make card redaction assertion exact`.
- Separate exact-new-HEAD natural `make verify`, then residue, scope, dependency, role, and
  provider checks.
