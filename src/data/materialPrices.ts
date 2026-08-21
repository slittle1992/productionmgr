import { itemKey } from "../domain/inventory.js";

/**
 * Default unit costs, preloaded from the purchase orders in the shared Drive
 * folder (June–Aug 2026 POs from Simiron, Torginol, AP Nonweiler, Decorative
 * Concrete Supply, Aramsco, Uline). Keys are inventory-tracker item names;
 * a PM can override any of these from the usage table in the app — stored
 * prices always win over these defaults.
 *
 * EPDM granules come from the Fieldmaster PO FM-DALLAS-091025: flat
 * $57/bag landed (base colors and custom-mix blends alike) —
 * the flat tier price is applied to every color in each tier, including
 * the few not on that PO.
 *
 * Resins and binders come from the Polyval POs (UV Resin $175, UV Primer
 * $158, Paving Binder $85 per pail) and the Simiron Trowel Glide PO ($73).
 * The numbered "UV Resin Binder" batches are priced as the PO's UV RESIN
 * BINDER line; UV PAVING RESIN as the paving binder line.
 *
 * Not covered by any PO (enter in the app when known): Rubaroc-sourced
 * black EPDM, RevaPave, Fumed Silica, Trowel Glide MS, the extreme-heat
 * aliphatic binder, RevaSEAL, Tek Grip, Ballistix Vapor Lock, kit-size
 * (1.5/2 gal) coatings, boxes of squeegees (per-box count unknown), and
 * the off-list Torginol flake colors (Bengal, Cherokee, Crimson,
 * Pheasant).
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

  // ── EPDM base colors — $57 per 55 lb bag, landed ──
  "EPDM - BEIGE - CH02": 57,
  "EPDM - BLACK - CH57 (Fieldmaster)": 57,
  "EPDM - BRIGHT GREEN - CH42": 57,
  "EPDM - BROWN - CH58": 57,
  "EPDM - DARK BLUE - CH53": 57,
  "EPDM - DARK GREY CH43": 57,
  "EPDM - EGGSHELL CH14": 57,
  "EPDM - IRON GREEN - CH49": 57,
  "EPDM - LIGHT BLUE CH39": 57,
  "EPDM - LIGHT GREEN CH27": 57,
  "EPDM - LIGHT GREY CH15": 57,
  "EPDM - MEDIUM GREY CH22": 57,
  "EPDM - ORANGE - CH38": 57,
  "EPDM - PINK - CH24": 57,
  "EPDM - PURPLE - CH40": 57,
  "EPDM - RED CH59": 57,
  "EPDM - TEAL - CH04": 57,
  "EPDM - WHITE CH07": 57,
  "EPDM - YELLOW - CH37": 57,

  // ── EPDM custom-mix blends — Fieldmaster $36.25 per 55 lb bag ──
  "EPDM Atlantis": 57,
  "EPDM Brownstone": 57,
  "EPDM Caspian": 57,
  "EPDM Lilypad": 57,
  "EPDM Limestone": 57,
  "EPDM Mocha": 57,
  "EPDM Nickel": 57,
  "EPDM Platinum": 57,
  "EPDM Sandalwood": 57,
  "EPDM Sandstone": 57,
  "EPDM Santa Fe": 57,
  "EPDM Seminole": 57,
  "EPDM Slate": 57,
  "EPDM Sterling": 57,
  "EPDM Terra Cotta": 57,

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

  // ── Rubber resins & binders — Polyval / Simiron POs ──
  "Rubaroc UV Resin (RESIN-UVRESIN)": 175,
  "UV Resin Binder 4469": 175,
  "UV Resin Binder 5609": 175,
  "UV Resin Binder 8000": 175,
  "UV Resin Binder V2": 175,
  "Rubaroc UV Primer (RESIN-UVPRIMER)": 158,
  "Paving Binder": 85,
  "UV PAVING RESIN - X 61-7501": 85,
  "Trowel Glide": 73,

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
