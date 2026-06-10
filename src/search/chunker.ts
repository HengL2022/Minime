// Markdown-aware chunker (spec §9): target 250–400 tokens, 40-token overlap,
// headings prepended to chunk text. "Tokens" approximated by whitespace words —
// good enough for sizing, and keeps us dependency-free.

const TARGET = 350;
const MAX = 400;
const OVERLAP = 40;

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

// Oversized paragraphs are pre-split so the accumulator below stays simple.
function splitParagraph(p: string): string[] {
  const ws = words(p);
  if (ws.length <= MAX) return [p];
  const parts: string[] = [];
  for (let i = 0; i < ws.length; i += TARGET - OVERLAP) {
    parts.push(ws.slice(i, i + TARGET).join(" "));
    if (i + TARGET >= ws.length) break;
  }
  return parts;
}

export function chunkMarkdown(md: string, title?: string): string[] {
  const chunks: string[] = [];

  for (const sec of sections(md)) {
    const prefix = [title, sec.heading].filter(Boolean).join(" > ");
    const paragraphs = sec.text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap(splitParagraph);

    let cur: string[] = [];
    let curWords = 0;
    let overlapWords = 0; // how many words of `cur` are carried-over overlap

    const emit = () => {
      const body = cur.join("\n\n");
      chunks.push(prefix ? `${prefix}\n\n${body}` : body);
      const tail = words(body).slice(-OVERLAP);
      cur = tail.length > 0 ? [tail.join(" ")] : [];
      curWords = tail.length;
      overlapWords = tail.length;
    };

    for (const p of paragraphs) {
      const w = words(p).length;
      if (curWords + w > MAX && curWords > overlapWords) emit();
      cur.push(p);
      curWords += w;
      if (curWords >= TARGET) emit();
    }
    // flush remainder unless it is nothing but the carried overlap tail
    if (curWords > overlapWords) emit();
  }

  if (chunks.length === 0 && md.trim()) {
    chunks.push(title ? `${title}\n\n${md.trim()}` : md.trim());
  }
  return chunks;
}
