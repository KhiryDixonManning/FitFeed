export const CATEGORIES = [
  "streetwear",
  "alternative",
  "preppy",
  "western",
  "vintage",
  "minimalist",
  "y2k",
  "business casual",
  "athleisure",
  "cottagecore",
] as const;

export type Category = typeof CATEGORIES[number];
