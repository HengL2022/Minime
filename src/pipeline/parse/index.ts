// Inbox parse registry: original capture bytes → markdown for classify/file.
// Hash, identity, and archive stay on the original bytes. Next W5 slice (not this
// one): originals-store at data/files/<yyyy>/<hash>.<ext> + append-only
// data/files/manifest.ndjson, plus remaining parsers (docx, xlsx/csv, eml).

import { InboxParseError } from "./error";
import { extractPdfMarkdown } from "./pdf";
import { hasPdfMagic, inboxExtension, isValidUtf8Text, textMimeForExt } from "./sniff";

export { InboxParseError, type InboxParseCode } from "./error";

export interface InboxParseResult {
  markdown: string;
  mime: string;
  meta?: Record<string, unknown>;
}

function parsePdfBytes(bytes: Uint8Array): InboxParseResult {
  try {
    return {
      markdown: extractPdfMarkdown(bytes),
      mime: "application/pdf",
      meta: { parser: "pdf" },
    };
  } catch (error) {
    if (error instanceof InboxParseError) throw error;
    throw new InboxParseError("parse_failed", "application/pdf");
  }
}

export function parseInboxSource(filePath: string, bytes: Uint8Array): InboxParseResult {
  if (bytes.length === 0) return { markdown: "", mime: "text/plain", meta: { parser: "text" } };
  if (hasPdfMagic(bytes) || inboxExtension(filePath) === ".pdf") return parsePdfBytes(bytes);
  if (isValidUtf8Text(bytes)) {
    return {
      markdown: new TextDecoder("utf-8").decode(bytes),
      mime: textMimeForExt(filePath),
      meta: { parser: "text" },
    };
  }
  throw new InboxParseError("unsupported_type", "application/octet-stream");
}
