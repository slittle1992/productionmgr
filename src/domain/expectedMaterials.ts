import { computeMaterials } from "./materials.js";
import { normalizeColor } from "./colors.js";
import { itemKey } from "./inventory.js";
import { isWithinWeek, type ReportingWeek } from "./week.js";
import { DEFAULT_UNIT_COSTS } from "../data/materialPrices.js";
import type { CompletedJob } from "./completedProjects.js";
import type { CoverageConfig, CustomFieldNames } from "../config.js";
import {
  readCustomField,
  type BuilderPrimeProject,
} from "../builderPrime/types.js";

/**
 * "Spec" material cost for the week's completed jobs: each completed job is
 * joined to its pipeline row by job number for SQFT and color, run through the
 * coverage math, and priced at PO prices. Actual ÷ expected is the usage
 * multiple the 21.5% material calculator tracks (1.0× = crews used exactly
 * what the spec calls for).
 */

export interface ExpectedMaterialsRow {
  className: string;
  /** Completed jobs in the labor week. */
  completedJobs: number;
  /** How many of those had a pipeline match with SQFT. */
  jobsWithSqft: number;
  sqft: number;
  expectedCost: number;
}

// $ per unit at PO prices (see src/data/materialPrices.ts).
const BASECOAT_PER_GAL = 125 / 5;
const TOPCOAT_PER_GAL = 220 / 5;
const RUBBER_BAG = 36.25;
const BINDER_BUCKET = 175;
const PRIMER_BUCKET = 158;
const FLAKE_BOX_FALLBACK = 62;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Catalog price for a flake color name, tolerating the tracker's suffixes. */
function flakeBoxPrice(colorName: string | null): number {
  if (!colorName) return FLAKE_BOX_FALLBACK;
  const key = itemKey(colorName);
  if (DEFAULT_UNIT_COSTS[key] !== undefined) return DEFAULT_UNIT_COSTS[key]!;
  const hit = Object.keys(DEFAULT_UNIT_COSTS).find((k) => k.startsWith(key));
  return hit ? DEFAULT_UNIT_COSTS[hit]! : FLAKE_BOX_FALLBACK;
}

/** Spec material $ for one job. */
export function expectedJobCost(
  sqft: number,
  projectType: string | null,
  colorName: string | null,
  coverage: CoverageConfig
): number {
  const normalized = normalizeColor(colorName);
  const color = normalized ?? { name: colorName, flakeProduct: null };
  const m = computeMaterials(sqft, projectType, color, coverage);
  if (!m.applies) return 0;
  if (m.kind === "rubber") {
    return r2(
      m.rubberBags * RUBBER_BAG +
        m.binderBuckets * BINDER_BUCKET +
        m.primerBuckets * PRIMER_BUCKET
    );
  }
  return r2(
    m.flakeBoxes * flakeBoxPrice(color.name) +
      (m.basecoatAGallons + m.basecoatBGallons) * BASECOAT_PER_GAL +
      (m.topcoatAGallons + m.topcoatBGallons) * TOPCOAT_PER_GAL
  );
}

export function expectedMaterialsByClass(
  completed: CompletedJob[],
  week: ReportingWeek,
  projects: BuilderPrimeProject[],
  fields: CustomFieldNames,
  coverage: CoverageConfig
): ExpectedMaterialsRow[] {
  // jobNumber → pipeline sqft/color.
  const str = (v: unknown) =>
    v === null || v === undefined || String(v).trim() === ""
      ? null
      : String(v).trim();
  const num = (v: unknown) => {
    const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const byJob = new Map<string, { sqft: number | null; color: string | null }>();
  for (const p of projects) {
    const jobNumber =
      str(readCustomField(p, fields.jobNumber)) ?? str(p.jobNumber);
    if (!jobNumber) continue;
    byJob.set(jobNumber, {
      sqft: num(readCustomField(p, fields.sqft)),
      color: str(readCustomField(p, fields.color)),
    });
  }

  const rows = new Map<string, ExpectedMaterialsRow>();
  for (const job of completed) {
    if (!isWithinWeek(job.completedDate ?? undefined, week)) continue;
    const cls = job.className || "Unassigned";
    const row =
      rows.get(cls) ??
      ({ className: cls, completedJobs: 0, jobsWithSqft: 0, sqft: 0, expectedCost: 0 } as ExpectedMaterialsRow);
    row.completedJobs++;
    const match = byJob.get(job.jobNumber);
    if (match?.sqft) {
      row.jobsWithSqft++;
      row.sqft += match.sqft;
      row.expectedCost = r2(
        row.expectedCost +
          expectedJobCost(match.sqft, job.type, match.color, coverage)
      );
    }
    rows.set(cls, row);
  }
  return [...rows.values()].sort((a, b) => a.className.localeCompare(b.className));
}
