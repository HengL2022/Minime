// Mixed-intent capture plan. The single-label classifier files one primary row;
// this pre-pass decides whether leftover typed items should become companion
// rows (same inbox id, derived_from). Prefixed dumps stay heuristic. Narrative
// dumps without prefixes may ask the classify provider (assumed tier 2) and
// fail open — never unfile a good one-thing capture.

import { config } from "../util/config";
import {
  CLASSIFIER_TYPES,
  type Classification,
  type ClassifierType,
  captureBodyFirstLine,
  heuristicClassify,
  identityCaptureName,
  orgCue,
} from "./classify";

export type IntentItem = {
  classification: Classification;
  text: string;
};

export type IntentPlan = { kind: "none" } | { kind: "items"; items: IntentItem[] };

const MAX_ITEMS = 4;

// Line-start only. A mention of "todo" or "met" mid-sentence must not split.
const STRONG_LINE =
  /^(?:todo|task|org|company|person|decision|journal|note)\s*:|^(?:decided|met|called|talked\s+to|coffee\s+with|lunch\s+with)\b/iu;

const TASK_CUE = /\b(need to|should|remind me|todo|by \d{4}-\d{2}-\d{2}|send the|book the)\b/i;
const MEET_CUE = /\b(met|called|coffee with|lunch with|talked to|emailed)\b/i;
const NOTE_CUE = /\b(they want|note that|wrote down|written redline)\b/i;
const DECISION_CUE = /\b(decide|decided|decision)\b/i;
const JOURNAL_CUE = /\b(today i|feeling|grateful|tired|mood)\b/i;

function stripLeadingHint(text: string): string {
  return text.replace(/^<!--.*?-->\s*/s, "").trim();
}

export function classifyStrongIntentLine(line: string): Classification | null {
  const t = line.trim();
  if (!t || !STRONG_LINE.test(t)) return null;
  const c = heuristicClassify(t);
  if (c.type === "unknown") return null;
  if ((c.type === "org" || c.type === "person") && !identityCaptureName(t, c.fields)) return null;
  return c;
}

function validMixed(items: IntentItem[]): IntentItem[] | null {
  if (items.length < 2 || items.length > MAX_ITEMS) return null;
  const types = new Set(items.map((item) => item.classification.type));
  return types.size >= 2 ? items : null;
}

function planFromLines(text: string): IntentItem[] | null {
  const items: IntentItem[] = [];
  let current: IntentItem | null = null;
  for (const line of text.split("\n")) {
    const strong = classifyStrongIntentLine(line);
    if (strong) {
      if (current) items.push(current);
      current = { classification: strong, text: line.trim() };
    } else if (current) {
      const extra = line.trim();
      if (extra) current.text = `${current.text}\n${extra}`;
    } else if (line.trim()) {
      return null;
    }
  }
  if (current) items.push(current);
  return validMixed(items);
}

function planFromBlocks(text: string): IntentItem[] | null {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length < 2 || blocks.length > MAX_ITEMS) return null;
  const items: IntentItem[] = [];
  for (const block of blocks) {
    const first = block.split("\n", 1)[0] ?? "";
    const strong = classifyStrongIntentLine(first);
    if (!strong) return null;
    items.push({ classification: strong, text: block });
  }
  return validMixed(items);
}

export function planMixedIntents(text: string): IntentPlan {
  const body = stripLeadingHint(text);
  if (!body) return { kind: "none" };
  const items = planFromLines(body) ?? planFromBlocks(body);
  return items ? { kind: "items", items } : { kind: "none" };
}

function splitBlocks(text: string): string[] | null {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks.length >= 2 && blocks.length <= MAX_ITEMS ? blocks : null;
}

function splitSentences(text: string): string[] | null {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length >= 2 && parts.length <= MAX_ITEMS ? parts : null;
}

function intentClasses(text: string): Set<string> {
  const found = new Set<string>();
  if (TASK_CUE.test(text)) found.add("task");
  if (MEET_CUE.test(text)) found.add("interaction");
  if (NOTE_CUE.test(text)) found.add("note");
  if (DECISION_CUE.test(text)) found.add("decision_note");
  if (JOURNAL_CUE.test(text)) found.add("journal");
  return found;
}

export function llmIntentCue(text: string): boolean {
  const body = stripLeadingHint(text);
  const units = splitBlocks(body) ?? splitSentences(body);
  return Boolean(units && intentClasses(body).size >= 2);
}

function classifyNarrativeBlock(text: string): Classification | null {
  const c = heuristicClassify(text);
  if (c.type !== "unknown" && c.type !== "note") return c;
  if (MEET_CUE.test(text)) {
    const m = text.match(
      /(?:met|called|coffee with|lunch with|talked to|emailed)\s+([A-Z][\w'-]+(?:\s[A-Z][\w'-]+)?)/i,
    );
    return {
      type: "interaction",
      confidence: 0.8,
      fields: {
        person_name: m?.[1] ?? "Unknown",
        kind: /call|emailed/i.test(text) ? (/emailed/i.test(text) ? "email" : "call") : "meeting",
        subject_type: orgCue(text) ? "org" : "person",
      },
      reason: "narrative interaction cue",
    };
  }
  if (TASK_CUE.test(text)) {
    return {
      type: "task",
      confidence: 0.8,
      fields: { title: captureBodyFirstLine(text).slice(0, 80), due: null },
      reason: "narrative task cue",
    };
  }
  return c.type === "note" ? c : null;
}

export function heuristicNarrativeIntents(text: string): IntentPlan {
  if (!llmIntentCue(text)) return { kind: "none" };
  const body = stripLeadingHint(text);
  const units = splitBlocks(body) ?? splitSentences(body);
  if (!units) return { kind: "none" };
  const items: IntentItem[] = [];
  for (const unit of units) {
    const classification = classifyNarrativeBlock(unit);
    if (!classification || classification.type === "unknown") return { kind: "none" };
    items.push({ classification, text: unit });
  }
  const mixed = validMixed(items);
  return mixed ? { kind: "items", items: mixed } : { kind: "none" };
}

function parseLlmIntentPlan(raw: string): IntentPlan {
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return { kind: "none" };
    const items: IntentItem[] = [];
    for (const row of parsed.items.slice(0, MAX_ITEMS)) {
      if (!row || typeof row !== "object") continue;
      const rec = row as { type?: unknown; text?: unknown; fields?: unknown };
      if (!(CLASSIFIER_TYPES as readonly string[]).includes(String(rec.type))) continue;
      if (typeof rec.text !== "string" || !rec.text.trim()) continue;
      const type = rec.type as ClassifierType;
      if (type === "unknown") continue;
      const fields = rec.fields && typeof rec.fields === "object" ? rec.fields : {};
      items.push({
        classification: { type, confidence: 0.8, fields: fields as Record<string, unknown> },
        text: rec.text.trim(),
      });
    }
    const mixed = validMixed(items);
    return mixed ? { kind: "items", items: mixed } : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

function buildIntentPrompt(text: string): string {
  return `You split a personal capture into 2-4 distinct fileable items when it clearly mixes types.
Return ONLY JSON: {"items":[{"type":"task"|"journal"|"interaction"|"note"|"decision_note"|"org"|"person","text":"...","fields":{}}]}.
Use verbatim excerpts from the text. Do not invent facts. If it is one intent, return {"items":[]}.
Cap at 4. Types follow the inbox classifier. fields match that type (task title, interaction person_name/kind).

Text:
${text.slice(0, 4000)}`;
}

// Prefixed heuristic wins. LLM (or the mock narrative heuristic) runs only when
// that plan is silent and a mixed-class cue fired. Failure / junk / one type
// is none — never unfile a good one-thing capture.
export async function resolveIntentPlan(text: string, fetchFn?: typeof fetch): Promise<IntentPlan> {
  const det = planMixedIntents(text);
  if (det.kind !== "none") return det;
  if (!llmIntentCue(text)) return { kind: "none" };
  if (config.mockOllama) return heuristicNarrativeIntents(text);
  try {
    const { classifyProviderForTier } = await import("../llm");
    const raw = await classifyProviderForTier(2, fetchFn).completeJson(buildIntentPrompt(text));
    return parseLlmIntentPlan(raw);
  } catch {
    return { kind: "none" };
  }
}
