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
  /**
   * Default polyurea basecoat for this flake blend (earth/brown blends run on
   * Tan, grey/blue/black blends on Grey). The schedule auto-fills the Base
   * column from this; a per-job pick in the schedule still wins. Edit here to
   * correct a blend's standard base.
   */
  base?: "Tan" | "Grey";
  /** Lower-cased alternate spellings that normalise to this color. */
  aliases?: string[];
}

export const COLOR_CATALOG: ColorEntry[] = [
  { name: "Ash", base: "Grey" },
  { name: "Atlantis", base: "Grey" },
  { name: "Autumn Brown", base: "Tan", aliases: ["autumn", "autumn brow"] },
  { name: "Beige", base: "Tan" },
  { name: "Black", base: "Grey", aliases: ["sbr black"] },
  { name: "Brown", base: "Tan" },
  { name: "Brownstone", base: "Tan", aliases: ["brownstone w"] },
  { name: "Cabin Fever", base: "Tan", aliases: ["cabinfever"] },
  { name: "Cappuccino", base: "Tan", aliases: ["cappucino"] },
  { name: "Carbon", base: "Grey" },
  { name: "Caspian", base: "Grey", aliases: ["caspain"] },
  { name: "Cherokee", base: "Tan" },
  { name: "Claystone", base: "Tan" },
  { name: "Coastal Sand", base: "Tan", flakeProduct: "Coastal Sand / Madras", aliases: ["coastal sand/madras", "madras"] },
  { name: "Cookie Dough", base: "Tan", flakeProduct: "Cookie Dough/Saddle Tan/Outback", aliases: ["saddle tan"] },
  { name: "Coyote", base: "Tan" },
  { name: "Creekbed", base: "Tan", flakeProduct: "Gravity/Creekbed", aliases: ["creek bed", "gravity"] },
  { name: "Crimson", base: "Grey" },
  { name: "Dakota Grey", base: "Grey", aliases: ["dakote grey"] },
  { name: "Dolphin", base: "Grey" },
  { name: "Domino", base: "Grey" },
  { name: "Eggshell", base: "Tan", aliases: ["eggshell border"] },
  { name: "Feather Grey", base: "Grey", aliases: ["feather gray", "feathered grey"] },
  { name: "Glacier", base: "Grey", aliases: ["galcier"] },
  { name: "Graphite", base: "Grey" },
  { name: "Granite", base: "Grey" },
  { name: "Gravel", base: "Grey" },
  { name: "Gray", base: "Grey", aliases: ["grey", "neutral gray", "dark grey"] },
  { name: "Limestone", base: "Tan" },
  { name: "Lunar", base: "Grey" },
  { name: "Marlin", base: "Grey" },
  { name: "Medium Tan", base: "Tan" },
  { name: "Mocha", base: "Tan" },
  { name: "Nickel", base: "Grey", aliases: ["nickle"] },
  { name: "Nightfall", base: "Grey" },
  { name: "Orbit", base: "Grey", flakeProduct: "Voodoo / Orbit", aliases: ["voodoo"] },
  { name: "Outback", base: "Tan", aliases: [] },
  { name: "Performance Red", base: "Grey", aliases: ["red"] },
  { name: "Platinum", base: "Grey", aliases: ["platinum w"] },
  { name: "Safari", base: "Tan" },
  { name: "Sahara", base: "Tan" },
  { name: "Sandalwood", base: "Tan", aliases: ["sandalwoond"] },
  { name: "Sandstone", base: "Tan", flakeProduct: "Sand Stone", aliases: ["sand stone"] },
  { name: "Santa Fe", base: "Tan", aliases: ["santafe"] },
  { name: "Schist", base: "Grey" },
  { name: "Seminole", base: "Tan" },
  { name: "Shoreline", base: "Tan", flakeProduct: "Tucson/Shoreline", aliases: ["shorline", "tucson"] },
  { name: "Slate", base: "Grey" },
  { name: "Smoke", base: "Grey" },
  { name: "Spartan", base: "Grey" },
  { name: "Stargazer", base: "Grey" },
  { name: "Sterling", base: "Grey" },
  { name: "Stonewash", base: "Grey" },
  { name: "Terracotta", base: "Tan" },
  { name: "Tidal Wave", base: "Grey", aliases: ["tidalwave"] },
  { name: "Touch of Blue", base: "Grey" },
  { name: "Tuxedo", base: "Grey" },
  { name: "Wombat", base: "Tan" },
];
