// Fictional 1×1 PNG fixtures for W6 image-parse tests and the VLM bake-off.
// Bytes only — never real photos. Captions are the sealed gold for mock describe
// and for the retrieval-img corpus.

export const PHOTO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export const RECEIPT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export const WHITEBOARD_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgCNgCAAFYAQVoJ2Z+AAAAAElFTkSuQmCC",
  "base64",
);

export const WETLAB_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQWKABAAHkAPFD+bn3AAAAAElFTkSuQmCC",
  "base64",
);

export const NYCKELHARPA_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPYUqEBAAM4AVUprF78AAAAAElFTkSuQmCC",
  "base64",
);

export const BISCUIT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4sSAAAAPsAbnYxPzJAAAAAElFTkSuQmCC",
  "base64",
);

export const NIDELVA_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQsakAAAEwAMmb5zfxAAAAAElFTkSuQmCC",
  "base64",
);

export const SILDRE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOIiooCAAIgAQ/kH0CsAAAAAElFTkSuQmCC",
  "base64",
);

export const BAKERY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGO4E6ABAANgAVVUIGmXAAAAAElFTkSuQmCC",
  "base64",
);

export const PASSPORT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQkwsAAADqAI3fxsLYAAAAAElFTkSuQmCC",
  "base64",
);

export const PHOTO_CAPTION = "A fictional harbor pier at dusk with coiled rope on the dock.";
export const RECEIPT_CAPTION =
  "A fictional cafe receipt dated 2026-03-12 totaling 12.40 for tea and a bun.";
export const WHITEBOARD_CAPTION =
  "A fictional whiteboard sketch of a 36-node hydrophone array with labeled cables and a Trondheim fjord bathymetry outline.";
export const WETLAB_CAPTION =
  "A fictional wet-lab tray with printed sample labels for herring otoliths and a dated run sheet.";
export const NYCKELHARPA_CAPTION =
  "A fictional three-row nyckelharpa lying on a birch table beside a resin bow and a Byss-Calle tune sheet.";
export const BISCUIT_CAPTION =
  "A fictional fawn whippet named Biscuit wearing a mustard wool jumper on a sofa.";
export const NIDELVA_CAPTION =
  "A fictional winter morning run along the Nidelva with frost on the path and the Nidaros spire in the distance.";
export const SILDRE_CAPTION =
  "A fictional wooden crate stenciled SILDRE NODE 07 with a foam-packed hydrophone and a firmware USB stick.";
export const BAKERY_CAPTION =
  "A fictional bakery window on Bakklandet showing cinnamon buns and a handwritten ranking card.";
export const PASSPORT_CAPTION =
  "A fictional passport page with a Japan visa stamp dated April 2025 and a Takayama entry mark.";

export type BakeoffKind = "photo" | "receipt" | "whiteboard" | "document";

export interface BakeoffImage {
  id: string;
  filename: string;
  title: string;
  kind: BakeoffKind;
  suggestedTier: 1 | 2;
  png: Buffer;
  caption: string;
}

export const BAKEOFF_IMAGES: readonly BakeoffImage[] = [
  {
    id: "harbor-pier",
    filename: "harbor-pier.png",
    title: "Harbor pier at dusk",
    kind: "photo",
    suggestedTier: 2,
    png: PHOTO_PNG,
    caption: PHOTO_CAPTION,
  },
  {
    id: "cafe-receipt",
    filename: "cafe-receipt.png",
    title: "Cafe receipt",
    kind: "receipt",
    suggestedTier: 2,
    png: RECEIPT_PNG,
    caption: RECEIPT_CAPTION,
  },
  {
    id: "whiteboard-array",
    filename: "whiteboard-hydrophone.png",
    title: "Whiteboard hydrophone array",
    kind: "whiteboard",
    suggestedTier: 1,
    png: WHITEBOARD_PNG,
    caption: WHITEBOARD_CAPTION,
  },
  {
    id: "wetlab-tray",
    filename: "wet-lab-tray.png",
    title: "Wet-lab tray labels",
    kind: "document",
    suggestedTier: 1,
    png: WETLAB_PNG,
    caption: WETLAB_CAPTION,
  },
  {
    id: "nyckelharpa-table",
    filename: "nyckelharpa-table.png",
    title: "Nyckelharpa on a table",
    kind: "photo",
    suggestedTier: 2,
    png: NYCKELHARPA_PNG,
    caption: NYCKELHARPA_CAPTION,
  },
  {
    id: "biscuit-whippet",
    filename: "biscuit-whippet.png",
    title: "Biscuit the whippet",
    kind: "photo",
    suggestedTier: 2,
    png: BISCUIT_PNG,
    caption: BISCUIT_CAPTION,
  },
  {
    id: "nidelva-run",
    filename: "nidelva-run.png",
    title: "Nidelva river run",
    kind: "photo",
    suggestedTier: 2,
    png: NIDELVA_PNG,
    caption: NIDELVA_CAPTION,
  },
  {
    id: "sildre-crate",
    filename: "sildre-crate.png",
    title: "SILDRE node crate",
    kind: "photo",
    suggestedTier: 2,
    png: SILDRE_PNG,
    caption: SILDRE_CAPTION,
  },
  {
    id: "bakery-window",
    filename: "bakery-window.png",
    title: "Cinnamon-bun bakery window",
    kind: "photo",
    suggestedTier: 2,
    png: BAKERY_PNG,
    caption: BAKERY_CAPTION,
  },
  {
    id: "passport-visa",
    filename: "passport-visa.png",
    title: "Passport visa stamp",
    kind: "document",
    suggestedTier: 2,
    png: PASSPORT_PNG,
    caption: PASSPORT_CAPTION,
  },
];
