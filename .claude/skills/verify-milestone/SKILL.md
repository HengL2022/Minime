---
name: verify-milestone
description: Run one focused legacy Minime area suite, or the complete offline development gate when no area is supplied.
disable-model-invocation: true
---

The user invokes this as `/verify-milestone N` (for example `/verify-milestone 2`). The name is
kept for compatibility; milestones no longer impose work order.

1. If N is supplied, validate that `verify-mN` exists and run only `make verify-mN`.
2. If N is missing, run `make verify-offline`, the complete offline development gate.
3. Report PASS/FAIL and the first useful failure. Do not map it to historical manual acceptance
   ceremony or run unrelated lower-numbered suites.
4. Use `make verify` instead only when the user asks for a release/search gate; it already
   includes `verify-offline`.

Follow the risk-based verification table in `docs/DEVELOPMENT.md` for normal coding work.
