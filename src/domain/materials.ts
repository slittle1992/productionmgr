import type { CoverageConfig } from "../config.js";
import { roundMoney } from "./calculations.js";

/**
 * Material calculator. Quantities are driven entirely by SQFT, but the products
 * differ by coating type:
 *
 *  - Flake / concrete coating: flake pounds (sqft × 0.15, 40 lb boxes),
 *    polyurea basecoat A/B gallons (200 sqft per total gallon, mixed 2:1 A:B),
 *    and polyaspartic topcoat A/B gallons (130 sqft per total gallon, equal
 *    parts). The job's color names which flake blend to pull.
 *  - Rubber coating: 50 lb rubber-granule bags (30 sqft/bag), 5-gal binder
 *    kits (160 sqft/kit), and 5-gal primer kits (700 sqft/kit; each primer kit
 *    is mixed from 3.5 gal binder + 1.5 gal alcohol spirits). The color names
 *    which granule blend to pull.
 *  - Warranty / inspection / sand & clear: no material, matching how those
 *    rows were left blank in the sheet.
 *
 * All fields are always present (zeroed when not applicable) so consumers can
 * sum columns without branching; `kind` says which set is meaningful.
 */

const NO_MATERIAL_TYPES = ["warranty", "inspection", "sand & clear", "sand and clear"];

export type MaterialKind = "flake" | "rubber" | "none";

export interface ColorInfo {
  /** Canonical color name (identifies the rubber granule blend). */
  name: string | null;
  /** Flake product to pull from inventory (for flake jobs). */
  flakeProduct: string | null;
}

export interface MaterialEstimate {
  kind: MaterialKind;
  /** False when the project type doesn't use material. */
  applies: boolean;
  /** The product to pull: flake blend for flake jobs, color for rubber jobs. */
  flake: string | null;
  // Flake / concrete coating
  basecoatAGallons: number;
  basecoatBGallons: number;
  topcoatAGallons: number;
  topcoatBGallons: number;
  flakePounds: number;
  flakeBoxes: number;
  // Rubber coating
  rubberBags: number;
  binderBuckets: number;
  primerBuckets: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalizeType(projectType: string | null | undefined): string {
  return (projectType ?? "").toLowerCase().replace(/\*+$/, "").trim();
}

export function appliesMaterial(projectType: string | null | undefined): boolean {
  if (!projectType) return true;
  return !NO_MATERIAL_TYPES.includes(normalizeType(projectType));
}

export function isRubberType(projectType: string | null | undefined): boolean {
  return normalizeType(projectType).includes("rubber");
}

const ZEROES = {
  basecoatAGallons: 0,
  basecoatBGallons: 0,
  topcoatAGallons: 0,
  topcoatBGallons: 0,
  flakePounds: 0,
  flakeBoxes: 0,
  rubberBags: 0,
  binderBuckets: 0,
  primerBuckets: 0,
};

export function computeMaterials(
  sqft: number | null | undefined,
  projectType: string | null | undefined,
  color: ColorInfo,
  coverage: CoverageConfig
): MaterialEstimate {
  if (!appliesMaterial(projectType)) {
    return { kind: "none", applies: false, flake: null, ...ZEROES };
  }

  const area = sqft && sqft > 0 ? sqft : 0;
  const per = (unit: number) => (unit > 0 ? round2(area / unit) : 0);

  if (isRubberType(projectType)) {
    const r = coverage.rubber;
    return {
      kind: "rubber",
      applies: true,
      flake: color.name,
      ...ZEROES,
      rubberBags: per(r.sqftPerBag),
      binderBuckets: per(r.sqftPerBinderBucket),
      primerBuckets: per(r.sqftPerPrimerBucket),
    };
  }

  const f = coverage.flake;
  // Polyurea basecoat: total gallons split by the A:B mix ratio (2:1).
  const puTotal = f.polyureaSqftPerGallon > 0 ? area / f.polyureaSqftPerGallon : 0;
  const parts = f.polyureaPartsA + f.polyureaPartsB;
  const shareA = parts > 0 ? f.polyureaPartsA / parts : 0;
  const shareB = parts > 0 ? f.polyureaPartsB / parts : 0;
  // Polyaspartic topcoat: equal parts A and B of the total gallons.
  const paTotal = f.polyasparticSqftPerGallon > 0 ? area / f.polyasparticSqftPerGallon : 0;

  const flakePounds = roundMoney(area * f.flakeLbsPerSqft);
  return {
    kind: "flake",
    applies: true,
    flake: color.flakeProduct,
    ...ZEROES,
    basecoatAGallons: round2(puTotal * shareA),
    basecoatBGallons: round2(puTotal * shareB),
    topcoatAGallons: round2(paTotal / 2),
    topcoatBGallons: round2(paTotal / 2),
    flakePounds,
    flakeBoxes: f.flakeBoxLbs > 0 ? round2(flakePounds / f.flakeBoxLbs) : 0,
  };
}
