// Fictional 1×1 PNG fixtures for W6 image-parse tests. Bytes only — never real photos.

export const PHOTO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export const RECEIPT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export const PHOTO_CAPTION = "A fictional harbor pier at dusk with coiled rope on the dock.";
export const RECEIPT_CAPTION =
  "A fictional cafe receipt dated 2026-03-12 totaling 12.40 for tea and a bun.";
