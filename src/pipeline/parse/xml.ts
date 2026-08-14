// Tiny OOXML tag scanner. Not a general XML engine — enough to pull w:t / cell
// text without a dependency, and never throw the raw capture back.

export interface XmlBlock {
  open: string;
  inner: string;
}

function xmlCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  return String.fromCodePoint(n);
}

export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => xmlCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => xmlCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function xmlAttr(open: string, name: string): string | null {
  const key = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dq = open.match(new RegExp(`\\s${key}="([^"]*)"`));
  if (dq) return decodeXmlEntities(dq[1]!);
  const sq = open.match(new RegExp(`\\s${key}='([^']*)'`));
  return sq ? decodeXmlEntities(sq[1]!) : null;
}

function tagNameEndOk(ch: string | undefined): boolean {
  return ch === ">" || ch === "/" || ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

export function xmlBlocks(xml: string, tag: string): XmlBlock[] {
  const openTok = `<${tag}`;
  const closeTok = `</${tag}>`;
  const blocks: XmlBlock[] = [];
  let i = 0;
  while (i < xml.length) {
    const start = xml.indexOf(openTok, i);
    if (start < 0) break;
    const after = start + openTok.length;
    if (!tagNameEndOk(xml[after])) {
      i = after;
      continue;
    }
    const tagEnd = xml.indexOf(">", after);
    if (tagEnd < 0) break;
    const open = xml.slice(start, tagEnd + 1);
    if (open.endsWith("/>")) {
      blocks.push({ open, inner: "" });
      i = tagEnd + 1;
      continue;
    }
    const end = xml.indexOf(closeTok, tagEnd + 1);
    if (end < 0) break;
    blocks.push({ open, inner: xml.slice(tagEnd + 1, end) });
    i = end + closeTok.length;
  }
  return blocks;
}

export function xmlTexts(xml: string, tag: string): string {
  return xmlBlocks(xml, tag)
    .map((block) => decodeXmlEntities(block.inner))
    .join("");
}
