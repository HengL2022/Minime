// Inbox classifier: local Ollama with a strict-JSON prompt (I1 — never a cloud call).
// In tests/CI (MINIME_MOCK_OLLAMA=1) a deterministic heuristic stands in.

import { todayStr } from "../util/clock";
import { config } from "../util/config";

export interface Classification {
  type: "task" | "journal" | "interaction" | "note" | "decision_note" | "unknown";
  confidence: number;
  fields: Record<string, any>;
  // One-line justification for the type/confidence call. Persisted in the
  // inbox_unfiled review payload (via the stored classifier object) so a human
  // reviewing a low-confidence capture sees WHY the model hesitated instead of
  // having to reverse-engineer it. Best-effort: empty string when the model
  // omits it or on the error path.
  reason?: string;
}

// The classify prompt is built per-call so the model always knows the current date —
// without an anchor it resolves relative phrases ("tomorrow", "next Friday") against its
// training prior and emits a wrong (usually past) year. See buildPrompt + the watcher's
// past-date guardrail, which together stop a bad year from silently entering the DB.
export function buildPrompt(today: string): string {
  return `You classify a short personal capture into exactly one type.
Today's date is ${today} (YYYY-MM-DD). Resolve every relative date — "today", "tomorrow",
"this/next Friday", "in two weeks" — against ${today}. Never output a due date in the past.
Types: task (something to do), journal (reflection/diary), interaction (met/called/messaged a person),
note (reference information), decision_note (a decision made or being weighed), unknown.
Reply with ONLY a JSON object: {"type": "...", "confidence": 0.0-1.0, "reason": "...", "fields": {...}}.
"reason" is one short sentence (<=140 chars) justifying the type and confidence; when confidence is low,
say what made it ambiguous (e.g. "could be task or interaction", "two intents in one capture", "unknown person").
fields by type: task -> {"title": string, "due": "YYYY-MM-DD" | null};
interaction -> {"person_name": string, "kind": "meeting"|"call"|"message"|"email"|"note", "subject_type": "person"|"org"};
For interaction, set "subject_type" to "org" when the counterparty is a COMPANY / vendor / lab /
institution / supplier (e.g. "emailed BioTree, a metabolomics company", "called Vazyme about the order")
and "person" when it is an individual human ("met Daniel about sorting"). When unsure, use "person".
journal -> {"mood": 1-5 | null}; decision_note -> {"question": string, "choice": string | null};
note -> {"title": string}; unknown -> {}.

Text:
`;
}

// Completion-signal detection for the "split mixed captures" fix. A single capture often
// bundles a FINISHED action with a forward-looking decision ("FACS analysis done... but
// need to decide whether to use knockout lines"). The classifier files it as exactly one
// type (usually decision_note), so the accomplishment never becomes a done-task and is
// invisible to the evening review's "what moved today" (which sources done tasks +
// closed commitments, not decision reasoning). When a capture carries a completion signal
// we ALSO emit a done-task for the achievement — see watcher.fileRow. Word-boundary
// matched so "workshop"/"undone" don't false-trigger.
const COMPLETION_RE =
  /\b(done|finished|completed?|confirmed|works|worked|working|succeeded|success(?:ful)?|achieved|shipped|resolved|fixed)\b/i;

export function completionSignal(text: string): boolean {
  return COMPLETION_RE.test(text);
}

// Org/company cue detection for interaction subject-typing. When a capture logs contact
// with a COUNTERPARTY, we must decide whether it attaches to a person or an org — attaching
// a vendor/company to a person mints a phantom person (the phantom-org bug this fixes).
// The real LLM classifier decides via the prompt; this regex is the mock/heuristic fallback
// AND the signal the phantom-person watchdog reuses to spot a company wrongly filed as a
// person. Matches an appositive company descriptor ("BioTree, a metabolomics company") or a
// trailing corporate suffix ("Vazyme Biotech", "Acme Inc", "… Ltd/GmbH/Pte").
const ORG_CUE_RE =
  /\b(company|companies|vendor|supplier|corp(?:oration)?|inc\.?|ltd\.?|llc|gmbh|s\.?a\.?|pte\.?|co\.?|biotech|bioscience|laborator(?:y|ies)|institute|university|clinic|hospital|foundation|agency|firm|startup|manufacturer|distributor|contractor|consultancy|consulting)\b/i;

export function orgCue(text: string): boolean {
  return ORG_CUE_RE.test(text);
}

// Build a concise done-task title from a mixed capture's text: take the leading clause up
// to the first sentence/clause boundary (before the forward-looking "but/however/need to"
// part), strip a leading "decision:"/"decided" prefix, and cap at 120 chars.
export function completionTitle(text: string): string {
  const firstLine = text
    .split("\n")[0]!
    .replace(/^<!--.*?-->\s*/s, "")
    .trim();
  // cut at the pivot into forward-looking territory, or the first sentence end
  const clause = firstLine.split(/\s*(?:[.;]|\bbut\b|\bhowever\b|\bneed to\b|\bnote:)/i)[0]!.trim();
  const base = (clause || firstLine).replace(/^(decision|decided)\b[:\s-]*/i, "").trim();
  return base.slice(0, 120);
}

// Split a compound "do X AND decide on/whether Y" task capture into its two halves: an
// ACTION (the task to do) and a DECISION (the open question to resolve). The FACS-and-Daniel
// bug: a single capture like "Do FACS analysis ... and decide on Daniel sorting" files as ONE
// umbrella task that no later single capture (the FACS-done report, or the Daniel decision)
// fully matches, so it never closes and double-reports in the morning brief. Peeling the
// decision clause into its own row at ingestion means each half closes independently.
//
// Conservative by design — only fires when ALL hold, so plain action tasks are untouched:
//   - the text is NOT a completion report (a "...— done" capture is handled by the done-task
//     path; splitting a finished item into an open decision would be wrong);
//   - there is a real leading ACTION clause before the pivot (not a bare "decide on X");
//   - the pivot is an explicit decision verb: "and decide on/whether/if/between ...".
export function splitActionDecision(text: string): { action: string; decision: string } | null {
  if (completionSignal(text)) return null;
  const firstLine = text
    .split("\n")[0]!
    .replace(/^<!--.*?-->\s*/s, "")
    .replace(/^(todo|task)[:\s]+/i, "")
    .trim();
  // pivot: "... and decide on/whether/if/between <rest>" (also "and decide to/about/...").
  const m = firstLine.match(
    /^(.*?\S)\s+and\s+(decide|determine)\s+(on|whether|if|between|about|to)\b\s*(.*)$/i,
  );
  if (!m) return null;
  const action = m[1]!.trim();
  const tail = m[4]!.trim();
  // require a substantive action clause and that it isn't itself a decision verb
  if (action.length < 3 || /^(decide|determine|decision)\b/i.test(action)) return null;
  const decision = `Decide ${m[3]!.toLowerCase()} ${tail}`.replace(/\s+/g, " ").trim();
  return { action, decision };
}

export function heuristicClassify(text: string): Classification {
  const t = text.trim();
  const lower = t.toLowerCase();
  const firstLine = t
    .split("\n")[0]!
    .replace(/^<!--.*?-->\s*/s, "")
    .trim();

  if (t.length < 3 || !/[a-z]/i.test(t))
    return { type: "unknown", confidence: 0.2, fields: {}, reason: "too short or no letters" };
  if (lower.startsWith("unclear:"))
    return { type: "unknown", confidence: 0.3, fields: {}, reason: "explicitly marked unclear" };

  if (/^(todo|task)[:\s]/i.test(firstLine) || /\bremind me\b/i.test(lower)) {
    const title = firstLine.replace(/^(todo|task)[:\s]+/i, "").trim() || firstLine;
    const due = lower.match(/\bby (\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null;
    return {
      type: "task",
      confidence: 0.9,
      fields: { title, due },
      reason: "explicit todo/task/remind-me prefix",
    };
  }
  if (/^(met|call(ed)? with|talked to|coffee with|lunch with)\b/i.test(firstLine)) {
    const m = firstLine.match(
      /^(?:met|call(?:ed)? with|talked to|coffee with|lunch with)\s+([A-Z][\w'-]+(?:\s[A-Z][\w'-]+)?)/i,
    );
    const kind = /call/i.test(firstLine) ? "call" : "meeting";
    return {
      type: "interaction",
      confidence: 0.85,
      fields: {
        person_name: m?.[1] ?? "Unknown",
        kind,
        subject_type: orgCue(firstLine) ? "org" : "person",
      },
      reason: "opens with a met/called/talked-to verb",
    };
  }
  if (/^(decided|decision[:\s])/i.test(firstLine)) {
    return {
      type: "decision_note",
      confidence: 0.8,
      fields: { question: firstLine, choice: null },
      reason: "opens with decided/decision",
    };
  }
  if (/\b(today|feeling|grateful|tired|mood)\b/i.test(lower) && /\b(i|my|me)\b/i.test(lower)) {
    return {
      type: "journal",
      confidence: 0.8,
      fields: { mood: null },
      reason: "first-person reflective language",
    };
  }
  if (t.length > 40)
    return {
      type: "note",
      confidence: 0.75,
      fields: { title: firstLine.slice(0, 80) },
      reason: "long-form text, no task/interaction/journal cue",
    };
  return { type: "unknown", confidence: 0.4, fields: {}, reason: "no matching heuristic cue" };
}

export async function classify(text: string): Promise<Classification> {
  if (config.mockOllama) return heuristicClassify(text);
  try {
    const { classifyProvider } = await import("../llm");
    const raw = await classifyProvider().completeJson(
      buildPrompt(todayStr()) + text.slice(0, 4000),
    );
    const parsed = JSON.parse(raw);
    const type = ["task", "journal", "interaction", "note", "decision_note", "unknown"].includes(
      parsed.type,
    )
      ? parsed.type
      : "unknown";
    const confidence =
      typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 140) : "";
    return { type, confidence, fields: parsed.fields ?? {}, reason };
  } catch {
    // provider down, key missing, or junk output: leave for the evening review, never guess
    return {
      type: "unknown",
      confidence: 0,
      fields: {},
      reason: "classifier error or unparseable output",
    };
  }
}
