// Inbox parse registry: original capture bytes → markdown for classify/file.
// Hash, identity, and archive stay on the original bytes. Originals live at
// data/files/<yyyy>/<hash>.<ext> with append-only data/files/manifest.ndjson.

import { extractCsvMarkdown } from "./csv";
import { extractDocxMarkdown, looksLikeDocx } from "./docx";
import { extractEmlMarkdown, looksLikeRfc822 } from "./eml";
import { InboxParseError } from "./error";
import { extractPdfMarkdown } from "./pdf";
import { hasPdfMagic, inboxExtension, isValidUtf8Text, textMimeForExt } from "./sniff";
import { extractXlsxMarkdown, looksLikeXlsx } from "./xlsx";

export { InboxParseError, type InboxParseCode } from "./error";

export interface InboxParseResult {
  markdown: string;
  mime: string;
  meta?: Record<string, unknown>;
}

function runParser(
  mime: string,
  parser: string,
  extract: (bytes: Uint8Array) => string,
  bytes: Uint8Array,
): InboxParseResult {
  try {
    return { markdown: extract(bytes), mime, meta: { parser } };
  } catch (error) {
    if (error instanceof InboxParseError) throw error;
    throw new InboxParseError("parse_failed", mime);
  }
}

export function parseInboxSource(filePath: string, bytes: Uint8Array): InboxParseResult {
  if (bytes.length === 0) return { markdown: "", mime: "text/plain", meta: { parser: "text" } };
  const ext = inboxExtension(filePath);
  if (hasPdfMagic(bytes) || ext === ".pdf") {
    return runParser("application/pdf", "pdf", extractPdfMarkdown, bytes);
  }
  if (looksLikeDocx(bytes) || ext === ".docx") {
    return runParser(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx",
      extractDocxMarkdown,
      bytes,
    );
  }
  if (looksLikeXlsx(bytes) || ext === ".xlsx") {
    return runParser(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "xlsx",
      extractXlsxMarkdown,
      bytes,
    );
  }
  if (looksLikeRfc822(bytes) || ext === ".eml") {
    return runParser("message/rfc822", "eml", extractEmlMarkdown, bytes);
  }
  if (ext === ".csv") return runParser("text/csv", "csv", extractCsvMarkdown, bytes);
  if (isValidUtf8Text(bytes)) {
    return {
      markdown: new TextDecoder("utf-8").decode(bytes),
      mime: textMimeForExt(filePath),
      meta: { parser: "text" },
    };
  }
  throw new InboxParseError("unsupported_type", "application/octet-stream");
}
