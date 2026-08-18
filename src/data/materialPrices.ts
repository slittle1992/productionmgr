import { itemKey } from "../domain/inventory.js";

/**
 * Default unit costs, preloaded from the purchase orders in the shared Drive
 * folder (June–Aug 2026 POs from Simiron, Torginol, AP Nonweiler, Decorative
 * Concrete Supply, Aramsco, Uline). Keys are inventory-tracker item names;
 * a PM can override any of these from the usage table in the app — stored
 * prices always win over these defaults.
 *
 * EPDM granules come from the Fieldmaster PO FM-DALLAS-091025: flat
 * $34.75/bag for base colors and $36.25/bag for custom-mix (CM) blends —
 * the flat tier price is applied to every color in each tier, including
 * the few not on that PO.
 *
 * Not covered by any PO (enter in the app when known): Rubaroc-sourced
 * black EPDM, RevaPave, Rubaroc UV Resin/Primer, Paving Binder, Fumed
 * Silica, Trowel Glide, Tek Grip, Ballistix Vapor Lock, kit-size
 * (1.5/2 gal) coatings, and the off-list Torginol flake colors (Bengal,
 * Cherokee, Crimson, Pheasant).
 */
const NAMED_UNIT_COSTS: Record<string, number> = {
  // ── Flake colors — Simiron 40 lb boxes at $62 (POs 111088-112258) ──
  "Autumn Brown": 62,
  "Cabin Fever FB-127": 62,
  Carbon: 62,
  Coyote: 62,
  "Creek Bed FB-716": 62,
  "Domino FB-411": 62,
  "Feather Gray": 62,
  Glacier: 62,
  Gravel: 62,
  "Nightfall FB-715": 62,
  "Orbit FB-310": 62,
  "Outback FB-517": 62,
  Safari: 62,
  "Shoreline FB-421": 62,
  Stargazer: 62,
  "Stonewash FB-708": 62,
  "Tidal Wave FB-807": 62,
  "Wombat FB/616": 62,
  // Torginol boxes.
  Claystone: 82.4,
  "All Other Flake Colors (combined count of colors not listed)": 60.4,

  // ── EPDM base colors — Fieldmaster $34.75 per 55 lb bag ──
  "EPDM - BEIGE - CH02": 34.75,
  "EPDM - BLACK - CH57 (Fieldmaster)": 34.75,
  "EPDM - BRIGHT GREEN - CH42": 34.75,
  "EPDM - BROWN - CH58": 34.75,
  "EPDM - DARK BLUE - CH53": 34.75,
  "EPDM - DARK GREY CH43": 34.75,
  "EPDM - EGGSHELL CH14": 34.75,
  "EPDM - IRON GREEN - CH49": 34.75,
  "EPDM - LIGHT BLUE CH39": 34.75,
  "EPDM - LIGHT GREEN CH27": 34.75,
  "EPDM - LIGHT GREY CH15": 34.75,
  "EPDM - MEDIUM GREY CH22": 34.75,
  "EPDM - ORANGE - CH38": 34.75,
  "EPDM - PINK - CH24": 34.75,
  "EPDM - PURPLE - CH40": 34.75,
  "EPDM - RED CH59": 34.75,
  "EPDM - TEAL - CH04": 34.75,
  "EPDM - WHITE CH07": 34.75,
  "EPDM - YELLOW - CH37": 34.75,

  // ── EPDM custom-mix blends — Fieldmaster $36.25 per 55 lb bag ──
  "EPDM Atlantis": 36.25,
  "EPDM Brownstone": 36.25,
  "EPDM Caspian": 36.25,
  "EPDM Lilypad": 36.25,
  "EPDM Limestone": 36.25,
  "EPDM Mocha": 36.25,
  "EPDM Nickel": 36.25,
  "EPDM Platinum": 36.25,
  "EPDM Sandalwood": 36.25,
  "EPDM Sandstone": 36.25,
  "EPDM Santa Fe": 36.25,
  "EPDM Seminole": 36.25,
  "EPDM Slate": 36.25,
  "EPDM Sterling": 36.25,
  "EPDM Terra Cotta": 36.25,

  // ── RevaFlex basecoat — $125 per 5-gal (all Part A variants + Part B) ──
  "REVAFLEX BASECOAT ACTIVATOR PART B 5 GAL": 125,
  "REVAFLEX SUMMER SLOW GRAY BASECOAT PART A 5 GAL": 125,
  "REVAFLEX SUMMER SLOW TAN BASECOAT PART A 5 GAL": 125,
  "REVAFLEX SUMMER SLOW NEUTRAL BASECOAT PART A 5 GAL": 125,
  "REVAFLEX XTREME HEAT EXTRA SLOW GRAY BASECOAT PART A 5 GAL": 125,
  "REVAFLEX XTREME HEAT EXTRA SLOW TAN BASECOAT PART A 5 GAL": 125,
  "REVAFLEX MEDIUM TAN BASECOAT PART A 5 GAL": 125,

  // ── RevaFlex top coat — $220 per 5-gal; Resistance $130 ──
  "REVAFLEX SUMMER SLOW TOP COAT PART A 5 GAL": 220,
  "REVAFLEX TOP COAT ACTIVATOR PART B 5 GAL": 220,
  "REVAFLEX XTREME HEAT EXTRA SLOW TOP COAT PART A 5 GAL": 220,
  "REVAFLEX RESISTANCE TOP COAT": 130,

  // ── Mender — $175 per 5-gal ──
  "REVAFLEX MENDER PART A 5 GAL": 175,
  "REVAFLEX SUMMER MENDER PART B 5 GAL": 175,

  // ── Solvents ──
  "ACETONE - 5 GALLON": 51.2,
  "Solvent - Isopropyl Alcohol 55 Gal Drum": 384.4,

  // ── Sundries / tooling (derived from case prices on the POs) ──
  // #2519 4" mini rollers: $420 per 600 → $35 per 50-count case.
  '4" Mini rollers -- 50/case': 35,
  // CB-3 chip brushes: $220.32 per 432 (12 boxes of 36) → $18.36 per box.
  "Boxes of Chip Brushes": 18.36,
  // ECCW4518T threaded cup wheel, $22.99 each.
  '4" Cup Wheels': 22.99,
};

/** Same table keyed by the normalised item key the usage math looks up. */
export const DEFAULT_UNIT_COSTS: Record<string, number> = Object.fromEntries(
  Object.entries(NAMED_UNIT_COSTS).map(([name, price]) => [itemKey(name), price])
);
