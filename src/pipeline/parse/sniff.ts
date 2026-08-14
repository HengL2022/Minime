import { extname } from "node:path";

const PDF_MAGIC = Buffer.from("%PDF");
const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  return Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).equals(PDF_MAGIC);
}

export function hasZipMagic(bytes: Uint8Array): boolean {
  if (bytes.length < ZIP_LOCAL.length) return false;
  return Buffer.from(bytes.subarray(0, ZIP_LOCAL.length)).equals(ZIP_LOCAL);
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
