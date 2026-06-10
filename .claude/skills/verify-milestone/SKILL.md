---
name: verify-milestone
description: Run the acceptance gate for a Minime milestone — executes make verify-mN for the given milestone AND all previous ones, since M(n+1) must never start while verify-m(n) is red (spec §0.2).
disable-model-invocation: true
---

The user invokes this as `/verify-milestone N` (e.g. `/verify-milestone 2`).

1. Parse N from the arguments. If missing, infer the current milestone from the branch name or
   the highest existing `verify-m*` target in the `Makefile`, and say which one you inferred.
2. Run `make verify-m0` through `make verify-mN` **in order**, stopping at the first failure.
3. Report a table of milestone → PASS/FAIL, then for any failure: the failing target's output,
   the likely cause, and which acceptance criterion from spec §13 it maps to.
4. If everything is green, restate the milestone's Definition of Done items from spec §13 that
   are *not* covered by the make target (e.g. manual Claude Code MCP connection check in M2,
   README steps) so the user can close them out before merging.

Never mark a milestone done on partial results, and never skip a lower milestone's gate.
