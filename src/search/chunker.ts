// Markdown-aware chunker (spec §9): target 250–400 tokens, 40-token overlap,
// headings prepended to chunk text. "Tokens" approximated by whitespace words, except
// each Han character counts as one token — Chinese has no spaces, so pure word-counting
// saw whole documents as a handful of "words" and never split them (DECISIONS.md
// 2026-06-11). Sizing only; stored chunk text keeps the original (unspaced) characters.

import { CJK_CHAR, tokenCount } from "../util/cjk";

// Child embed/FTS/rerank size. Program W8 asked 120–200; shipping that now would
// move sealed mock floors. Keep current bounds until a live battery. // eval-calibration pending
const TARGET = 350;
const MAX = 400;
const OVERLAP = 40;
// const CHILD_TARGET = 160; // eval-calibration pending — not enabled

export interface ChunkSpan {
  text: string;
  children: string[];
}

interface Section {
  heading: string; // breadcrumb of headings, e.g. "Title > Sub"
  text: string;
}

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

// Split markdown into sections by heading, tracking the heading breadcrumb.
function sections(md: string): Section[] {
  const lines = md.split("\n");
  const out: Section[] = [];
  const crumb: string[] = [];
  let buf: string[] = [];

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) out.push({ heading: crumb.filter(Boolean).join(" > "), text });
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flush();
      const level = m[1]!.length;
      crumb.length = level - 1;
      crumb[level - 1] = m[2]!.trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// A single sentence above MAX tokens: window by words, or by characters when it is one
// unspaced CJK run with no whitespace to cut on.
function hardSplit(sentence: string): string[] {
  if (tokenCount(sentence) <= MAX) return [sentence];
  const ws = words(sentence);
  if (ws.length > 1) {
    const mid = Math.ceil(ws.length / 2);
    return [...hardSplit(ws.slice(0, mid).join(" ")), ...hardSplit(ws.slice(mid).join(" "))];
  }
  const chars = Array.from(sentence);
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += TARGET) parts.push(chars.slice(i, i + TARGET).join(""));
  return parts;
}

// Oversized paragraphs are pre-split so the accumulator below stays simple: sentence
// boundaries first (incl. fullwidth 。！？；), character windows as a last resort.
function splitParagraph(p: string): string[] {
  if (tokenCount(p) <= MAX) return [p];
  const sentences = p
    .split(/(?<=[.!?。！？；])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  const flush = () => {
    if (cur.length > 0) parts.push(cur.join(" "));
    cur = [];
    curTokens = 0;
  };
  for (const sentence of sentences) {
    for (const piece of hardSplit(sentence)) {
      const t = tokenCount(piece);
      if (curTokens + t > TARGET) flush();
      cur.push(piece);
      curTokens += t;
    }
  }
  flush();
  return parts.length > 0 ? parts : [p];
}

function sectionChildren(sec: Section, title?: string): string[] {
  const prefix = [title, sec.heading].filter(Boolean).join(" > ");
  const paragraphs = sec.text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap(splitParagraph);
  const chunks: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  let overlapTokens = 0;

  const emit = () => {
    const body = cur.join("\n\n");
    chunks.push(prefix ? `${prefix}\n\n${body}` : body);
    const ws = words(body);
    const tail: string[] = [];
    let t = 0;
    for (let i = ws.length - 1; i >= 0 && t < OVERLAP; i--) {
      let w = ws[i]!;
      const wTokens = Math.max(1, w.match(CJK_CHAR)?.length ?? 0);
      if (tail.length === 0 && wTokens > OVERLAP) w = Array.from(w).slice(-OVERLAP).join("");
      tail.unshift(w);
      t += Math.min(wTokens, OVERLAP);
    }
    cur = tail.length > 0 ? [tail.join(" ")] : [];
    curTokens = t;
    overlapTokens = t;
  };

  for (const p of paragraphs) {
    const t = tokenCount(p);
    if (curTokens + t > MAX && curTokens > overlapTokens) emit();
    cur.push(p);
    curTokens += t;
    if (curTokens >= TARGET) emit();
  }
  if (curTokens > overlapTokens) emit();
  return chunks;
}

export function chunkMarkdownSpans(md: string, title?: string): ChunkSpan[] {
  const spans: ChunkSpan[] = [];
  for (const sec of sections(md)) {
    const children = sectionChildren(sec, title);
    if (children.length === 0) continue;
    const prefix = [title, sec.heading].filter(Boolean).join(" > ");
    spans.push({ text: prefix ? `${prefix}\n\n${sec.text}` : sec.text, children });
  }
  if (spans.length === 0 && md.trim()) {
    const fallback = title ? `${title}\n\n${md.trim()}` : md.trim();
    spans.push({ text: fallback, children: [fallback] });
  }
  return spans;
}

export function chunkMarkdown(md: string, title?: string): string[] {
  return chunkMarkdownSpans(md, title).flatMap((span) => span.children);
}
