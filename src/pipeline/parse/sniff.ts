import { extname } from "node:path";

const PDF_MAGIC = Buffer.from("%PDF");

export function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  return Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).equals(PDF_MAGIC);
}

export function inboxExtension(filePath: string): string {
  return extname(filePath).toLowerCase();
}

export function textMimeForExt(filePath: string): string {
  return inboxExtension(filePath) === ".md" ? "text/markdown" : "text/plain";
}

// NUL or invalid UTF-8 means binary: never Buffer.toString("utf8") those bytes.
export function isValidUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
