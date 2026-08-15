// Offline VLM stand-in: captions keyed by file hash, never by path or pixels.

import { BAKEOFF_IMAGES } from "../../fixtures/parse/images";
import { sha256Hex } from "../util/hash";

const CAPTIONS = new Map<string, string>(
  BAKEOFF_IMAGES.map((image) => [sha256Hex(image.png), image.caption]),
);

export function mockDescribe(sha256: string): string {
  return CAPTIONS.get(sha256) ?? `Fictional image ${sha256.slice(0, 8)}`;
}
