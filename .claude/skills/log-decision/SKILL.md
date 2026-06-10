---
name: log-decision
description: Record a spec deviation, ambiguity resolution, or technical decision in DECISIONS.md (required by spec §0.3 for every deviation from minime-build-plan.md).
---

Append an entry to `DECISIONS.md` at the repo root. Never rewrite or delete existing entries —
the file is append-only history.

Entry format (newest at the bottom):

```markdown
## YYYY-MM-DD — <short title>

- **Context:** what part of the spec / which milestone this touches (cite the § if applicable)
- **Decision:** what was decided or how the ambiguity was resolved
- **Why:** reasoning, alternatives considered
- **Approved by:** human / agent-proposed (pending human review)
```

Rules:
- Use today's real date.
- If the decision deviates from the pinned tech stack (spec §4) or changes search weights
  (spec §9), say so explicitly in **Context**.
- If the human hasn't confirmed the decision yet, mark it "agent-proposed (pending human review)"
  and tell the user it needs their sign-off.
