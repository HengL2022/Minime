// Proving PDF extractor, not a full engine. Enough for simple text PDFs
// (uncompressed or /FlateDecode, Tj/TJ/'/" literals) so classify stays
// format-agnostic without a new npm dependency.

import { inflateRawSync, inflateSync } from "node:zlib";
import { InboxParseError } from "./error";

const STREAM = Buffer.from("stream");
const ENDSTREAM = Buffer.from("endstream");
const KNOWN_FILTERS = [
  "FlateDecode",
  "ASCIIHexDecode",
  "ASCII85Decode",
  "LZWDecode",
  "RunLengthDecode",
  "CCITTFaxDecode",
  "JBIG2Decode",
  "DCTDecode",
  "JPXDecode",
  "Crypt",
] as const;

interface PdfStream {
  dict: string;
  data: Uint8Array;
  nextIndex: number;
}

function pdfFailed(): never {
  throw new InboxParseError("parse_failed", "application/pdf");
}

function isTokenBoundary(buf: Buffer, i: number): boolean {
  if (i < 0 || i >= buf.length) return true;
  const c = buf[i]!;
  return c <= 32 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x2f;
}

function pdfDirectLength(dict: string): number | null {
  const match = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
  return match ? Number(match[1]) : null;
}

function pdfFilters(dict: string): string[] {
  const found: string[] = [];
  for (const name of KNOWN_FILTERS) {
    if (dict.includes(`/${name}`)) found.push(name);
  }
  return found;
}

function slicePdfStream(buf: Buffer, streamAt: number): PdfStream {
  const dict = buf.toString("latin1", Math.max(0, streamAt - 1024), streamAt);
  let dataStart = streamAt + STREAM.length;
  if (buf[dataStart] === 0x0d) dataStart++;
  if (buf[dataStart] === 0x0a) dataStart++;
  const length = pdfDirectLength(dict);
  if (length !== null && dataStart + length <= buf.length) {
    const dataEnd = dataStart + length;
    let nextIndex = dataEnd;
    if (buf[nextIndex] === 0x0d) nextIndex++;
    if (buf[nextIndex] === 0x0a) nextIndex++;
    if (buf.subarray(nextIndex, nextIndex + ENDSTREAM.length).equals(ENDSTREAM)) {
      nextIndex += ENDSTREAM.length;
    }
    return { dict, data: buf.subarray(dataStart, dataEnd), nextIndex };
  }
  const end = buf.indexOf(ENDSTREAM, dataStart);
  if (end < 0) pdfFailed();
  let dataEnd = end;
  if (buf[dataEnd - 1] === 0x0a) dataEnd--;
  if (dataEnd > 0 && buf[dataEnd - 1] === 0x0d) dataEnd--;
  return { dict, data: buf.subarray(dataStart, dataEnd), nextIndex: end + ENDSTREAM.length };
}

function locatePdfStreams(bytes: Uint8Array): PdfStream[] {
  const buf = Buffer.from(bytes);
  const found: PdfStream[] = [];
  let i = 0;
  while (i < buf.length) {
    const at = buf.indexOf(STREAM, i);
    if (at < 0) break;
    const insideEndstream = at >= 3 && buf.subarray(at - 3, at).equals(Buffer.from("end"));
    if (
      insideEndstream ||
      !isTokenBoundary(buf, at - 1) ||
      !isTokenBoundary(buf, at + STREAM.length)
    ) {
      i = at + 1;
      continue;
    }
    const stream = slicePdfStream(buf, at);
    found.push(stream);
    i = stream.nextIndex;
  }
  return found;
}

function inflatePdf(data: Uint8Array): Buffer {
  try {
    return inflateSync(data);
  } catch {
    try {
      return inflateRawSync(data);
    } catch {
      pdfFailed();
    }
  }
}

function decodePdfStream(stream: PdfStream): string {
  const filters = pdfFilters(stream.dict);
  if (filters.some((name) => name !== "FlateDecode")) pdfFailed();
  const data = filters.includes("FlateDecode") ? inflatePdf(stream.data) : stream.data;
  return Buffer.from(data).toString("latin1");
}

function readPdfEscape(src: string, start: number): { text: string; end: number } {
  const next = src[start + 1];
  if (next === undefined) return { text: "", end: start + 1 };
  if (next === "\n" || next === "\r") {
    let end = start + 2;
    if (next === "\r" && src[end] === "\n") end++;
    return { text: "", end };
  }
  const named: Record<string, string> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    "(": "(",
    ")": ")",
    "\\": "\\",
  };
  if (next in named) return { text: named[next]!, end: start + 2 };
  if (next >= "0" && next <= "7") {
    let oct = next;
    let end = start + 2;
    while (oct.length < 3 && src[end]! >= "0" && src[end]! <= "7") {
      oct += src[end]!;
      end++;
    }
    return { text: String.fromCharCode(Number.parseInt(oct, 8) & 0xff), end };
  }
  return { text: next, end: start + 2 };
}

function readPdfLiteral(src: string, start: number): { text: string; end: number } {
  let i = start + 1;
  let depth = 1;
  let text = "";
  while (i < src.length && depth > 0) {
    const ch = src[i]!;
    if (ch === "\\") {
      const esc = readPdfEscape(src, i);
      text += esc.text;
      i = esc.end;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return { text, end: i + 1 };
    }
    if (depth > 0) text += ch;
    i++;
  }
  pdfFailed();
}

function peekShowOp(
  src: string,
  start: number,
): { op: "Tj" | "TJ" | "'" | '"'; end: number } | null {
  let i = start;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src.startsWith("TJ", i) && !/\w/.test(src[i + 2] ?? "")) return { op: "TJ", end: i + 2 };
  if (src.startsWith("Tj", i) && !/\w/.test(src[i + 2] ?? "")) return { op: "Tj", end: i + 2 };
  if (src[i] === "'") return { op: "'", end: i + 1 };
  if (src[i] === '"') return { op: '"', end: i + 1 };
  return null;
}

function readPdfArrayStrings(src: string, start: number): { strings: string[]; end: number } {
  const strings: string[] = [];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "]") return { strings, end: i + 1 };
    if (ch === "(") {
      const lit = readPdfLiteral(src, i);
      strings.push(lit.text);
      i = lit.end;
      continue;
    }
    i++;
  }
  pdfFailed();
}

function looksLikeContent(decoded: string): boolean {
  return /(?:BT|ET|Tj|TJ|T\*)\b/.test(decoded);
}

function normalizePdfText(parts: string[]): string {
  return parts
    .join(" ")
    .replace(/ *\n */g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function extractPdfText(content: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === "%") {
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "(") {
      const lit = readPdfLiteral(content, i);
      const show = peekShowOp(content, lit.end);
      if (show?.op === "Tj") parts.push(lit.text);
      else if (show?.op === "'" || show?.op === '"') parts.push(`\n${lit.text}`);
      i = show ? show.end : lit.end;
      continue;
    }
    if (ch === "[") {
      const arr = readPdfArrayStrings(content, i);
      const show = peekShowOp(content, arr.end);
      if (show?.op === "TJ") parts.push(arr.strings.join(""));
      i = show ? show.end : arr.end;
      continue;
    }
    if (content.startsWith("T*", i) && !/\w/.test(content[i + 2] ?? "")) {
      parts.push("\n");
      i += 2;
      continue;
    }
    i++;
  }
  return normalizePdfText(parts);
}

export function extractPdfMarkdown(bytes: Uint8Array): string {
  const streams = locatePdfStreams(bytes);
  if (streams.length === 0) pdfFailed();
  const decoded = streams.map(decodePdfStream);
  const contentish = decoded.filter(looksLikeContent);
  return extractPdfText((contentish.length > 0 ? contentish : decoded).join("\n"));
}
