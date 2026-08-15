// Mixed-intent capture plan. The single-label classifier files one primary row;
// this pre-pass decides whether leftover strong-typed lines should become
// companion rows (same inbox id, derived_from). Narrative dumps without
// prefixes stay on the single-classify path — no LLM on this slice.

import { type Classification, heuristicClassify, identityCaptureName } from "./classify";

export type IntentItem = {
  classification: Classification;
  text: string;
};

export type IntentPlan = { kind: "none" } | { kind: "items"; items: IntentItem[] };

const MAX_ITEMS = 4;

// Line-start only. A mention of "todo" or "met" mid-sentence must not split.
const STRONG_LINE =
  /^(?:todo|task|org|company|person|decision|journal|note)\s*:|^(?:decided|met|called|talked\s+to|coffee\s+with|lunch\s+with)\b/iu;

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
