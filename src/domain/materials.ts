import type { CoverageRates } from "../config.js";
import { roundMoney } from "./calculations.js";

/**
 * Material calculator. Quantities are driven entirely by SQFT using fixed
 * coverage rates (from the spreadsheet's Job-Costing sheet); the job's color
 * names which flake blend to pull. This is "color auto-populates material."
 *
 * Project types that don't apply coating (warranty, inspection, sand & clear)
 * produce no material, matching how those rows were left blank in the sheet.
 */

const NO_MATERIAL_TYPES = ["warranty", "inspection", "sand & clear", "sand and clear"];

export interface MaterialEstimate {
  basecoatAGallons: number;
  basecoatBGallons: number;
  topcoatAGallons: number;
  topcoatBGallons: number;
  flakePounds: number;
  /** The flake blend to pull (from the job's color). */
  flake: string | null;
  /** False when the project type doesn't use material. */
  applies: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function appliesMaterial(projectType: string | null | undefined): boolean {
  if (!projectType) return true;
  return !NO_MATERIAL_TYPES.includes(projectType.toLowerCase().replace(/\*+$/, "").trim());
}

export function computeMaterials(
  sqft: number | null | undefined,
  projectType: string | null | undefined,
  flake: string | null,
  rates: CoverageRates
): MaterialEstimate {
  const applies = appliesMaterial(projectType);
  const area = applies && sqft && sqft > 0 ? sqft : 0;

  const div = (d: number) => (d > 0 ? round2(area / d) : 0);
  return {
    basecoatAGallons: div(rates.basecoatADivisor),
    basecoatBGallons: div(rates.basecoatBDivisor),
    topcoatAGallons: div(rates.topcoatADivisor),
    topcoatBGallons: div(rates.topcoatBDivisor),
    flakePounds: roundMoney(area * rates.flakeLbsPerSqft),
    flake: applies ? flake : null,
    applies,
  };
}
