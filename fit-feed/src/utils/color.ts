// Palette colour helpers.
//
// Posts carry palettes in two shapes: early posts stored bare hex strings,
// later ones store {hex, name, percentage} from the analyser. Both are
// normalised here so feed cards, post detail and Explore all read colours the
// same way instead of each keeping their own copy of this logic.

export type PaletteColor =
  | string
  | { hex?: string; name?: string; percentage?: number };

export interface NormalizedColor {
  hex: string;
  name: string;
  percentage: number | null;
}

/** Best-effort human name for a bare hex value. */
export function hexToReadableName(hex: string): string {
  if (!hex) return 'Unknown';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 'Unknown';

  const brightness = (r * 299 + g * 587 + b * 114) / 1000;

  if (r > 200 && g < 100 && b < 100) return 'Red';
  if (r < 100 && g > 150 && b < 100) return 'Green';
  if (r < 100 && g < 100 && b > 200) return 'Blue';
  if (r > 200 && g > 150 && b < 100) return 'Orange';
  if (r > 200 && g > 200 && b < 100) return 'Yellow';
  if (r > 150 && g < 100 && b > 150) return 'Purple';
  if (r > 180 && g < 120 && b > 120) return 'Rose';
  if (r > 150 && g > 100 && b < 80) return 'Camel';
  if (r < 80 && g < 80 && b < 80) return 'Black';
  if (brightness > 220) return 'White';
  if (brightness > 180) return 'Cream';
  if (brightness > 150) return 'Light Gray';
  if (brightness > 100) return 'Gray';
  if (brightness > 50) return 'Charcoal';
  return 'Dark';
}

export function normalizeColor(color: PaletteColor): NormalizedColor {
  if (typeof color === 'string') {
    return { hex: color, name: hexToReadableName(color), percentage: null };
  }
  const hex = color.hex ?? '#000000';
  return {
    hex,
    name: color.name || hexToReadableName(hex) || 'Unknown',
    percentage: color.percentage ?? null,
  };
}

/** True when a colour is light enough to need dark text on top of it. */
export function isLightColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;
  return r > 200 && g > 200 && b > 200;
}
