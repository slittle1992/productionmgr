/**
 * Canonical flake/rubber color catalog.
 *
 * Colors in the old spreadsheet were free-typed, producing duplicates and typos
 * ("Caspian"/"Caspain", "Tidal wave"/"Tidal Wave", "Glacier"/"Galcier"). This
 * curated list — seeded from the Flake Inventory and the colors actually used on
 * recent schedules — backs a fixed dropdown so every job uses one canonical name.
 *
 * `aliases` map the messy historical spellings (and Builder Prime's stored value)
 * onto the canonical name. Edit this list to add colors or correct a flake mapping.
 */
export interface ColorEntry {
  /** Canonical, customer-facing color name (what the dropdown shows). */
  name: string;
  /** Flake blend / product to pull from inventory. Defaults to the name. */
  flakeProduct?: string;
  /** Lower-cased alternate spellings that normalise to this color. */
  aliases?: string[];
}

export const COLOR_CATALOG: ColorEntry[] = [
  { name: "Ash" },
  { name: "Atlantis" },
  { name: "Autumn Brown", aliases: ["autumn", "autumn brow"] },
  { name: "Beige" },
  { name: "Black", aliases: ["sbr black"] },
  { name: "Brown" },
  { name: "Brownstone", aliases: ["brownstone w"] },
  { name: "Cabin Fever", aliases: ["cabinfever"] },
  { name: "Cappuccino", aliases: ["cappucino"] },
  { name: "Carbon" },
  { name: "Caspian", aliases: ["caspain"] },
  { name: "Cherokee" },
  { name: "Claystone" },
  { name: "Coastal Sand", flakeProduct: "Coastal Sand / Madras", aliases: ["coastal sand/madras", "madras"] },
  { name: "Cookie Dough", flakeProduct: "Cookie Dough/Saddle Tan/Outback", aliases: ["saddle tan"] },
  { name: "Coyote" },
  { name: "Creekbed", flakeProduct: "Gravity/Creekbed", aliases: ["creek bed", "gravity"] },
  { name: "Crimson" },
  { name: "Dakota Grey", aliases: ["dakote grey"] },
  { name: "Dolphin" },
  { name: "Domino" },
  { name: "Eggshell", aliases: ["eggshell border"] },
  { name: "Feather Grey", aliases: ["feather gray", "feathered grey"] },
  { name: "Glacier", aliases: ["galcier"] },
  { name: "Graphite" },
  { name: "Granite" },
  { name: "Gravel" },
  { name: "Gray", aliases: ["grey", "neutral gray", "dark grey"] },
  { name: "Limestone" },
  { name: "Lunar" },
  { name: "Marlin" },
  { name: "Medium Tan" },
  { name: "Mocha" },
  { name: "Nickel", aliases: ["nickle"] },
  { name: "Nightfall" },
  { name: "Orbit", flakeProduct: "Voodoo / Orbit", aliases: ["voodoo"] },
  { name: "Outback", aliases: [] },
  { name: "Performance Red", aliases: ["red"] },
  { name: "Platinum", aliases: ["platinum w"] },
  { name: "Safari" },
  { name: "Sahara" },
  { name: "Sandalwood", aliases: ["sandalwoond"] },
  { name: "Sandstone", flakeProduct: "Sand Stone", aliases: ["sand stone"] },
  { name: "Santa Fe", aliases: ["santafe"] },
  { name: "Schist" },
  { name: "Seminole" },
  { name: "Shoreline", flakeProduct: "Tucson/Shoreline", aliases: ["shorline", "tucson"] },
  { name: "Slate" },
  { name: "Smoke" },
  { name: "Spartan" },
  { name: "Stargazer" },
  { name: "Sterling" },
  { name: "Stonewash" },
  { name: "Terracotta" },
  { name: "Tidal Wave", aliases: ["tidalwave"] },
  { name: "Touch of Blue" },
  { name: "Tuxedo" },
  { name: "Wombat" },
];
