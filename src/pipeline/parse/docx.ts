// Proving DOCX extractor: word/document.xml paragraphs only. No images/OLE.

import { InboxParseError } from "./error";
import { hasZipMagic } from "./sniff";
import { xmlBlocks, xmlTexts } from "./xml";
import { zipEntryNames, zipReadFile } from "./zip";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function docxFailed(): never {
  throw new InboxParseError("parse_failed", DOCX_MIME);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    docxFailed();
  }
}

export function looksLikeDocx(bytes: Uint8Array): boolean {
  if (!hasZipMagic(bytes)) return false;
  try {
    const names = zipEntryNames(bytes);
    return names.includes("[Content_Types].xml") && names.includes("word/document.xml");
  } catch {
    return false;
  }
}

function docxXmlToMarkdown(xml: string): string {
  return xmlBlocks(xml, "w:p")
    .map((para) => xmlTexts(para.inner, "w:t"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractDocxMarkdown(bytes: Uint8Array): string {
  try {
    return docxXmlToMarkdown(decodeUtf8(zipReadFile(bytes, "word/document.xml")));
  } catch (error) {
    if (error instanceof InboxParseError) throw error;
    docxFailed();
  }
}
