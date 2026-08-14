// Proving RFC822 extractor: Subject/From/Date plus text/plain. Fail closed on
// HTML-only mail and never fold attachment/base64 blobs into markdown.

import { InboxParseError } from "./error";

export const EML_MIME = "message/rfc822";

const WELL_KNOWN = new Set([
  "from",
  "subject",
  "date",
  "to",
  "cc",
  "mime-version",
  "content-type",
  "message-id",
  "return-path",
  "received",
]);

interface MimePart {
  headers: Map<string, string>;
  body: string;
}

function emlFailed(): never {
  throw new InboxParseError("parse_failed", EML_MIME);
}

function decodeMessageBytes(bytes: Uint8Array): string {
  if (bytes.includes(0)) emlFailed();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString("latin1");
  }
}

function stripUnixFrom(raw: string): string {
  if (!raw.startsWith("From ")) return raw;
  const nl = raw.indexOf("\n");
  return nl < 0 ? "" : raw.slice(nl + 1);
}

function splitHeaderBody(raw: string): { headers: string; body: string } {
  const text = stripUnixFrom(
    raw
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n"),
  );
  const sep = text.indexOf("\n\n");
  if (sep < 0) return { headers: text, body: "" };
  return { headers: text.slice(0, sep), body: text.slice(sep + 2) };
}

function unfoldHeaderLines(block: string): string[] {
  const lines: string[] = [];
  for (const line of block.split("\n")) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += ` ${line.trim()}`;
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of unfoldHeaderLines(block)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    const prev = headers.get(name);
    headers.set(name, prev ? `${prev}\n${match[2]}` : match[2]!);
  }
  return headers;
}

function headersHaveShape(block: string): boolean {
  const lines = unfoldHeaderLines(block).filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return /^[A-Za-z][A-Za-z0-9-]*:\s?/.test(lines[0]!);
}

export function looksLikeRfc822(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const { headers } = splitHeaderBody(text);
  if (!headersHaveShape(headers)) return false;
  const parsed = parseHeaders(headers);
  const known = [...parsed.keys()].filter((name) => WELL_KNOWN.has(name));
  // From + Date/Subject is too common in notes. Require a mail-specific header
  // so a todo/journal that mentions "From:" is not stolen as RFC822.
  const mailSpecific = ["mime-version", "received", "return-path", "message-id"];
  return known.includes("from") && known.some((name) => mailSpecific.includes(name));
}

function parseContentType(value: string | undefined): {
  type: string;
  params: Record<string, string>;
} {
  if (!value) return { type: "text/plain", params: { charset: "us-ascii" } };
  const parts = value.split(";").map((part) => part.trim());
  const type = (parts[0] ?? "text/plain").toLowerCase();
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { type, params };
}

function decodeQuotedPrintable(raw: string): Uint8Array {
  const stripped = raw.replace(/=\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(stripped.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(stripped.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    out.push(stripped.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  const name = charset.toLowerCase().replace(/['"]/g, "");
  if (
    name === "utf-8" ||
    name === "utf8" ||
    name === "us-ascii" ||
    name === "ascii" ||
    name === ""
  ) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      emlFailed();
    }
  }
  if (
    name === "iso-8859-1" ||
    name === "latin1" ||
    name === "iso-8859-15" ||
    name === "windows-1252"
  ) {
    return Buffer.from(bytes).toString("latin1");
  }
  emlFailed();
}

function decodeTransfer(body: string, encoding: string): Uint8Array {
  const enc = encoding.toLowerCase();
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64");
  if (enc === "7bit" || enc === "8bit" || enc === "binary" || enc === "") {
    return Buffer.from(body, "latin1");
  }
  emlFailed();
}

function isAttachment(headers: Map<string, string>): boolean {
  return /^\s*attachment\b/i.test(headers.get("content-disposition") ?? "");
}

function parsePart(raw: string): MimePart {
  const { headers, body } = splitHeaderBody(raw);
  return { headers: parseHeaders(headers), body };
}

function splitMultipart(body: string, boundary: string): MimePart[] {
  if (!boundary) emlFailed();
  const delim = `--${boundary}`;
  const closeAt = body.indexOf(`${delim}--`);
  const cut = closeAt < 0 ? body : body.slice(0, closeAt);
  const chunks = cut.split(delim).slice(1);
  return chunks.map((chunk) => {
    let raw = chunk;
    if (raw.startsWith("\n")) raw = raw.slice(1);
    if (raw.endsWith("\n")) raw = raw.slice(0, -1);
    return parsePart(raw);
  });
}

function decodePlain(part: MimePart): string {
  const ct = parseContentType(part.headers.get("content-type"));
  const enc = part.headers.get("content-transfer-encoding") ?? "7bit";
  return decodeCharset(decodeTransfer(part.body, enc), ct.params.charset ?? "utf-8").trim();
}

function collectPlain(part: MimePart, alternative: boolean): string | null {
  const ct = parseContentType(part.headers.get("content-type"));
  if (!ct.type.startsWith("multipart/")) {
    if (isAttachment(part.headers) || ct.type !== "text/plain") return null;
    return decodePlain(part);
  }
  const children = splitMultipart(part.body, ct.params.boundary ?? "");
  if (alternative) {
    for (const child of children) {
      const childCt = parseContentType(child.headers.get("content-type"));
      const nested = collectPlain(child, childCt.type === "multipart/alternative");
      if (nested !== null) return nested;
    }
    return null;
  }
  const texts: string[] = [];
  for (const child of children) {
    if (isAttachment(child.headers)) continue;
    const childCt = parseContentType(child.headers.get("content-type"));
    const nested = collectPlain(child, childCt.type === "multipart/alternative");
    if (nested !== null) texts.push(nested);
  }
  return texts.length > 0 ? texts.join("\n\n") : null;
}

function extractBody(root: MimePart): string {
  const ct = parseContentType(root.headers.get("content-type"));
  if (ct.type === "text/html") emlFailed();
  if (ct.type.startsWith("multipart/")) {
    const text = collectPlain(root, ct.type === "multipart/alternative");
    if (text === null) emlFailed();
    return text;
  }
  if (ct.type !== "text/plain" && root.headers.has("content-type")) emlFailed();
  return decodePlain(root);
}

function headerMarkdown(headers: Map<string, string>): string {
  return ["Subject", "From", "Date"]
    .flatMap((name) => {
      const value = headers.get(name.toLowerCase())?.trim();
      return value ? [`${name}: ${value}`] : [];
    })
    .join("\n");
}

export function extractEmlMarkdown(bytes: Uint8Array): string {
  try {
    const raw = decodeMessageBytes(bytes);
    const { headers, body } = splitHeaderBody(raw);
    if (!headersHaveShape(headers)) emlFailed();
    const root = { headers: parseHeaders(headers), body };
    const head = headerMarkdown(root.headers);
    const text = extractBody(root);
    const markdown = [head, text].filter((part) => part.length > 0).join("\n\n");
    if (markdown.length === 0) emlFailed();
    return markdown;
  } catch (error) {
    if (error instanceof InboxParseError) throw error;
    emlFailed();
  }
}
