// Image sniff + caption markdown. Describe is optional and async; the sync stub
// never calls a model. Suggested tier follows the W6 rule: photo→2; document /
// screenshot / whiteboard→1 unless personal/financial; receipts are financial→2
// and flagged for review, never auto-inserted as transactions.

import { basename } from "node:path";
import { sha256Hex } from "../../util/hash";
import { inboxExtension } from "./sniff";

export const IMAGE_KINDS = ["photo", "document", "receipt", "screenshot", "whiteboard"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF_MAGIC = Buffer.from("GIF8", "ascii");
const RIFF_MAGIC = Buffer.from("RIFF", "ascii");
const WEBP_MAGIC = Buffer.from("WEBP", "ascii");

const IMAGE_EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function hasImageMagic(bytes: Uint8Array): boolean {
  if (bytes.length >= JPEG_MAGIC.length && Buffer.from(bytes.subarray(0, 3)).equals(JPEG_MAGIC))
    return true;
  if (bytes.length >= PNG_MAGIC.length && Buffer.from(bytes.subarray(0, 8)).equals(PNG_MAGIC))
    return true;
  if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 4)).equals(GIF_MAGIC)) return true;
  return (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).equals(RIFF_MAGIC) &&
    Buffer.from(bytes.subarray(8, 12)).equals(WEBP_MAGIC)
  );
}

export function imageMimeFor(filePath: string, bytes: Uint8Array): string {
  if (bytes.length >= JPEG_MAGIC.length && Buffer.from(bytes.subarray(0, 3)).equals(JPEG_MAGIC))
    return "image/jpeg";
  if (bytes.length >= PNG_MAGIC.length && Buffer.from(bytes.subarray(0, 8)).equals(PNG_MAGIC))
    return "image/png";
  if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 4)).equals(GIF_MAGIC)) return "image/gif";
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).equals(RIFF_MAGIC) &&
    Buffer.from(bytes.subarray(8, 12)).equals(WEBP_MAGIC)
  )
    return "image/webp";
  return IMAGE_EXT_MIME[inboxExtension(filePath)] ?? "application/octet-stream";
}

export function looksLikeImage(filePath: string, bytes: Uint8Array): boolean {
  return hasImageMagic(bytes) || inboxExtension(filePath) in IMAGE_EXT_MIME;
}

const PERSONAL_FINANCIAL =
  /\b(receipt|invoice|bill|statement|card|ssn|passport|license|journal|diary|private|personal)\b/i;

export function inferImageKind(filePath: string, caption = ""): ImageKind {
  const hay = `${basename(filePath)} ${caption}`;
  if (/\b(receipt|invoice|bill)\b/i.test(hay)) return "receipt";
  if (/\b(screenshot|screen[ _-]?shot)\b/i.test(hay)) return "screenshot";
  if (/\b(whiteboard|diagram)\b/i.test(hay)) return "whiteboard";
  if (/\b(scan|document|doc)\b/i.test(hay)) return "document";
  return "photo";
}

export function suggestedImageTier(kind: ImageKind, filePath: string, caption = ""): 1 | 2 {
  if (kind === "photo" || kind === "receipt") return 2;
  return PERSONAL_FINANCIAL.test(`${basename(filePath)} ${caption}`) ? 2 : 1;
}

export const IMAGE_HINT_RE =
  /<!-- hint: image (photo|document|receipt|screenshot|whiteboard) tier=([12])( receipt_candidate)? -->/;

export function imageMarkdown(input: {
  filePath: string;
  kind: ImageKind;
  suggestedTier: 1 | 2;
  caption: string | null;
}): string {
  const receipt = input.kind === "receipt" ? " receipt_candidate" : "";
  const hint = `<!-- hint: image ${input.kind} tier=${input.suggestedTier}${receipt} -->`;
  const lines = [
    hint,
    "",
    "# Image capture",
    "",
    `filename: ${basename(input.filePath)}`,
    `kind: ${input.kind}`,
  ];
  if (input.caption?.trim()) {
    lines.push("", input.caption.trim());
  }
  return `${lines.join("\n")}\n`;
}

export function imageParseMeta(input: {
  kind: ImageKind;
  suggestedTier: 1 | 2;
  described: boolean;
  bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    parser: "image",
    kind: input.kind,
    suggested_tier: input.suggestedTier,
    described: input.described,
    content_hash: sha256Hex(input.bytes),
    receipt_candidate: input.kind === "receipt",
  };
}
