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
import type { JobFacts } from "../storage/pipelineStore.js";

/** Join key tolerant of formatting: the digits of a job number, else as-is. */
export function jobKey(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 4 ? digits : raw.trim().toLowerCase();
}

const strVal = (v: unknown) =>
  v === null || v === undefined || String(v).trim() === ""
    ? null
    : String(v).trim();
const numVal = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Lenient sqft-backfill parser: any export with a Job # column and a SQFT
 * column (Completed Projects with SQFT added via the column picker, an old
 * pipeline export, etc.) yields jobKey → sqft for the permanent history.
 */
export function parseSqftBackfill(grid: unknown[][]): {
  facts: Record<string, JobFacts>;
  rows: number;
} {
  const JOB_NAMES = ["job #", "job number", "job no", "job"];
  const SQFT_NAMES = ["sqft", "sq ft", "sq. ft.", "sq ft.", "square feet", "total sqft", "square footage"];
  const txt = (v: unknown) => {
    const s = String(v ?? "").trim();
    return s === "" ? null : s;
  };
  let jobCol = -1;
  let sqftCol = -1;
  let headerRow = -1;
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const lower = Array.from(grid[r] ?? [], (c) => txt(c)?.toLowerCase() ?? "");
    const j = lower.findIndex((c) => JOB_NAMES.includes(c));
    const s = lower.findIndex((c) => SQFT_NAMES.includes(c));
    if (j >= 0 && s >= 0) {
      jobCol = j;
      sqftCol = s;
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) {
    throw new Error(
      "Couldn't find Job # and SQFT columns. Export the Completed Projects " +
        "report with the SQFT column added (Builder Prime's column picker), " +
        "or any report carrying Job # and SQFT."
    );
  }
  const facts: Record<string, JobFacts> = {};
  let rows = 0;
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const job = txt(row[jobCol]);
    if (!job || !/\d/.test(job)) continue;
    rows++;
    const sqft = Number(String(row[sqftCol] ?? "").replace(/[,\s]/g, ""));
    if (!Number.isFinite(sqft) || sqft <= 0) continue;
    facts[jobKey(job)] = { sqft, color: null };
  }
  return { facts, rows };
}

/** jobKey → sqft/color for every job in a pipeline upload. */
export function extractJobFacts(
  projects: BuilderPrimeProject[],
  fields: CustomFieldNames
): Record<string, JobFacts> {
  const facts: Record<string, JobFacts> = {};
  for (const p of projects) {
    const jobNumber =
      strVal(readCustomField(p, fields.jobNumber)) ?? strVal(p.jobNumber);
    if (!jobNumber) continue;
    facts[jobKey(jobNumber)] = {
      sqft: numVal(readCustomField(p, fields.sqft)),
      color: strVal(readCustomField(p, fields.color)),
    };
  }
  return facts;
}

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
const RUBBER_BAG = 57;
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
  coverage: CoverageConfig,
  history: Record<string, JobFacts> = {}
): ExpectedMaterialsRow[] {
  // Remembered facts from past uploads first; the current pipeline overlays
  // them (completed jobs usually aged out of the current export).
  const byJob = new Map<string, JobFacts>(Object.entries(history));
  for (const [key, f] of Object.entries(extractJobFacts(projects, fields))) {
    const old = byJob.get(key);
    byJob.set(key, {
      sqft: f.sqft ?? old?.sqft ?? null,
      color: f.color ?? old?.color ?? null,
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
    const match = byJob.get(jobKey(job.jobNumber));
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
