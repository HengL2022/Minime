// Inbox classifier: local Ollama with a strict-JSON prompt (I1 — never a cloud call).
// In tests/CI (MINIME_MOCK_OLLAMA=1) a deterministic heuristic stands in.

import { todayStr } from "../util/clock";
import { config } from "../util/config";

export interface Classification {
  type: "task" | "journal" | "interaction" | "note" | "decision_note" | "unknown";
  confidence: number;
  fields: Record<string, any>;
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
Reply with ONLY a JSON object: {"type": "...", "confidence": 0.0-1.0, "fields": {...}}.
fields by type: task -> {"title": string, "due": "YYYY-MM-DD" | null};
interaction -> {"person_name": string, "kind": "meeting"|"call"|"message"|"email"|"note"};
journal -> {"mood": 1-5 | null}; decision_note -> {"question": string, "choice": string | null};
note -> {"title": string}; unknown -> {}.

Text:
`;
}

export function heuristicClassify(text: string): Classification {
  const t = text.trim();
  const lower = t.toLowerCase();
  const firstLine = t
    .split("\n")[0]!
    .replace(/^<!--.*?-->\s*/s, "")
    .trim();

  if (t.length < 3 || !/[a-z]/i.test(t)) return { type: "unknown", confidence: 0.2, fields: {} };
  if (lower.startsWith("unclear:")) return { type: "unknown", confidence: 0.3, fields: {} };

  if (/^(todo|task)[:\s]/i.test(firstLine) || /\bremind me\b/i.test(lower)) {
    const title = firstLine.replace(/^(todo|task)[:\s]+/i, "").trim() || firstLine;
    const due = lower.match(/\bby (\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null;
    return { type: "task", confidence: 0.9, fields: { title, due } };
  }
  if (/^(met|call(ed)? with|talked to|coffee with|lunch with)\b/i.test(firstLine)) {
    const m = firstLine.match(
      /^(?:met|call(?:ed)? with|talked to|coffee with|lunch with)\s+([A-Z][\w'-]+(?:\s[A-Z][\w'-]+)?)/i,
    );
    const kind = /call/i.test(firstLine) ? "call" : "meeting";
    return {
      type: "interaction",
      confidence: 0.85,
      fields: { person_name: m?.[1] ?? "Unknown", kind },
    };
  }
  if (/^(decided|decision[:\s])/i.test(firstLine)) {
    return {
      type: "decision_note",
      confidence: 0.8,
      fields: { question: firstLine, choice: null },
    };
  }
  if (/\b(today|feeling|grateful|tired|mood)\b/i.test(lower) && /\b(i|my|me)\b/i.test(lower)) {
    return { type: "journal", confidence: 0.8, fields: { mood: null } };
  }
  if (t.length > 40)
    return { type: "note", confidence: 0.75, fields: { title: firstLine.slice(0, 80) } };
  return { type: "unknown", confidence: 0.4, fields: {} };
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
    return { type, confidence, fields: parsed.fields ?? {} };
  } catch {
    // provider down, key missing, or junk output: leave for the evening review, never guess
    return { type: "unknown", confidence: 0, fields: {} };
  }
}
