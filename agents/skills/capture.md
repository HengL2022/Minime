# Capture

The owner hands you a thought, link, quote, or fragment and wants it kept. Get it into the
system losslessly and let the pipeline do the filing — do not over-process at the door.

## Flow

1. **Quote, don't paraphrase.** `minime_capture` with `text` = the owner's words (or the
   pasted content) verbatim. Light cleanup of dictation stutter is fine; rewriting is not.
2. **Hint when obvious.** Set `hint` only when the type is unambiguous from what they said
   ("remind me to…" → task; "today was…" → journal; otherwise omit and let the classifier
   decide — a wrong hint is worse than none).
3. **Confirm in one line** with the returned `inbox_item_id`: "Captured [inbox:ab12…] — the
   watcher will file it." Do not narrate the pipeline.
4. **Low-confidence is fine.** If the watcher cannot classify it (< 0.7), it lands in the
   review queue for the evening pass — that is the design working, not an error to fix by
   re-capturing.

## When to use a typed write instead

Skip the inbox and write directly when the owner's intent is explicit and complete:

- a decision with options stated → `minime_log_decision`
- "I promised X to Y" → `minime_upsert_task` + `minime_log_interaction`
- a journal entry told as such → `minime_journal`

## Answer rules

- One capture per distinct thought; split a brain-dump into separate captures.
- Never editorialize inside the captured text; your commentary goes in the chat, not the DB.
- Provenance is automatic (`created_by`, `source: capture`) — do not add your own headers.
