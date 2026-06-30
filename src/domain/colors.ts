import { COLOR_CATALOG, type ColorEntry } from "../data/colors.js";

/**
 * Color normalisation. Builder Prime stores whatever was typed historically, so
 * incoming values are matched (case/space/punctuation-insensitive) against the
 * canonical catalog and its aliases. Unknown values are preserved but flagged so
 * the manager can pick the right canonical color from the dropdown.
 */

function key(value: string): string {
  return value
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Build a lookup from canonical names + aliases → catalog entry.
const lookup = new Map<string, ColorEntry>();
for (const entry of COLOR_CATALOG) {
  lookup.set(key(entry.name), entry);
  for (const alias of entry.aliases ?? []) lookup.set(key(alias), entry);
}

export interface NormalizedColor {
  /** Canonical color name, or the cleaned original if unmatched. */
  name: string;
  /** Flake product to pull from inventory. */
  flakeProduct: string;
  /** True when the input matched the catalog. */
  recognized: boolean;
}

export function normalizeColor(raw: string | null | undefined): NormalizedColor | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  // Try the whole value, then the first part of a slash-separated combo.
  const candidates = [cleaned, ...cleaned.split("/").map((s) => s.trim())];
  for (const candidate of candidates) {
    const hit = lookup.get(key(candidate));
    if (hit) {
      return {
        name: hit.name,
        flakeProduct: hit.flakeProduct ?? hit.name,
        recognized: true,
      };
    }
  }
  return { name: cleaned, flakeProduct: cleaned, recognized: false };
}

/** The dropdown options exposed to the UI. */
export function colorOptions(): Array<{ name: string; flakeProduct: string }> {
  return COLOR_CATALOG.map((c) => ({
    name: c.name,
    flakeProduct: c.flakeProduct ?? c.name,
  }));
}
