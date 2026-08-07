---
name: log-decision
description: Record a durable Minime contract decision in DECISIONS.md when it changes an invariant, privacy/egress rule, schema meaning, public interface, dependency, or recovery contract.
---

Append an entry to `DECISIONS.md` at the repo root. Never rewrite or delete existing entries —
the file is append-only history.

Entry format (newest at the bottom):

```markdown
## YYYY-MM-DD — <short title>

- **Context:** what durable contract or behavior this touches
- **Decision:** what was decided or how the ambiguity was resolved
- **Why:** reasoning, alternatives considered
- **Approved by:** owner request / agent within the requested implementation scope
```

Rules:
- Use today's real date.
- Do not log routine bug fixes, test details, branch mechanics, reviewer findings, implementation
  choices, or plan adjustments. Put those in the commit or task handoff.
- If the decision changes the pinned stack, privacy/egress, live-data semantics, or recovery
  contract, say so explicitly in **Context** and follow the owner boundary in
  `docs/DEVELOPMENT.md`.
- Do not create a pending entry as a substitute for progress. Ask only when the decision itself
  crosses a high-impact boundary; otherwise choose a conservative reversible default and finish.
