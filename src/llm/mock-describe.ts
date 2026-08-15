// Offline VLM stand-in: captions keyed by file hash, never by path or pixels.

import {
  PHOTO_CAPTION,
  PHOTO_PNG,
  RECEIPT_CAPTION,
  RECEIPT_PNG,
} from "../../fixtures/parse/images";
import { sha256Hex } from "../util/hash";

const CAPTIONS = new Map<string, string>([
  [sha256Hex(PHOTO_PNG), PHOTO_CAPTION],
  [sha256Hex(RECEIPT_PNG), RECEIPT_CAPTION],
]);

export function mockDescribe(sha256: string): string {
  return CAPTIONS.get(sha256) ?? `Fictional image ${sha256.slice(0, 8)}`;
}
