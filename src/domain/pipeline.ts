import type { BuilderPrimeProject } from "../builderPrime/types.js";
import { extractColorFromText, normalizeColor } from "./colors.js";

/**
 * Parser for the Builder Prime "Production Pipeline Report" Excel export.
 *
 * The browser reads the .xlsx into a grid of raw rows (array-of-arrays) and
 * posts them here; this maps the columns onto the same project shape the rest
 * of the app already uses, so the schedule and report work unchanged. Mapping
 * lives server-side (not in the browser) so it stays testable.
 *
 * Layout: row 1 is a title, row 2 is the header, rows 3+ are jobs. Columns are
 * matched by header name, so column reordering doesn't break it.
 */

export type RawGrid = unknown[][];

/** Thrown when an uploaded file isn't a recognisable pipeline export. */
export class PipelineFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineFormatError";
  }
}

// Every uploader configures their own columns in Builder Prime's Export data
// view, so each field carries the spellings seen across the team's exports.
// Only Job # is required — everything else is optional and matched by name,
// in any order.
const HEADER_ALIASES: Record<keyof ColumnMap, string[]> = {
  jobNumber: ["job #", "job number", "job no", "job#", "job id", "project #", "project number", "project id"],
  description: ["description", "project description", "notes"],
  laborCost: ["labor cost", "labor"],
  materialCost: ["material cost", "materials cost"],
  soldAmount: ["sold amount", "sold", "contract amount"],
  start: ["start", "start date", "scheduled start"],
  finish: ["finish", "finish date", "end", "end date"],
  projectManager: ["project manager", "project mgr", "pm"],
  salesPerson: ["sales person", "salesperson", "sales"],
  type: ["type", "project type"],
  className: ["class", "location"],
  sqft: ["project sq ft", "project sqft", "sq ft", "sqft", "square feet", "square footage"],
  contractPrice: ["total contract price", "contract price"],
  flakeColor: ["flake color"],
  revaColor: ["revaflex color", "reva flex color", "rubber color"],
  projectName: ["project name", "job name"],
  client: ["client", "client name", "customer", "customer name"],
  city: ["city"],
  state: ["state"],
  zip: ["zip", "zip code"],
};

interface ColumnMap {
  jobNumber: number;
  description: number;
  laborCost: number;
  materialCost: number;
  soldAmount: number;
  start: number;
  finish: number;
  projectManager: number;
  salesPerson: number;
  type: number;
  className: number;
  sqft: number;
  contractPrice: number;
  flakeColor: number;
  revaColor: number;
  projectName: number;
  client: number;
  city: number;
  state: number;
  zip: number;
}

export interface PipelineParseResult {
  projects: BuilderPrimeProject[];
  rowCount: number;
  /** Job count per cleaned class, for the upload summary. */
  classes: Record<string, number>;
  /** Title-row label, e.g. "ReVamp - Data as of 6/29/26 @ 3:38 pm". */
  sourceLabel: string | null;
}

const EXCEL_EPOCH_DIFF_DAYS = 25569; // days between 1899-12-30 and 1970-01-01
const MS_PER_DAY = 86_400_000;

function cell(row: unknown[], idx: number): unknown {
  return idx >= 0 && idx < row.length ? row[idx] : undefined;
}

function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Convert a date cell (ISO string, "YYYY-MM-DD HH:mm", JS Date, or Excel serial) to ms. */
export function toMs(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") {
    // Excel serial date (days since 1899-12-30).
    if (v > 1 && v < 100000) return Math.round((v - EXCEL_EPOCH_DIFF_DAYS) * MS_PER_DAY);
    return v; // already ms
  }
  const s = String(v).trim();
  let ms = Date.parse(s);
  if (Number.isNaN(ms)) ms = Date.parse(s.replace(" ", "T"));
  return Number.isNaN(ms) ? undefined : ms;
}

/** Strip "Deluxe Garages - " / ", TX" to a short region label for grouping. */
export function cleanClassName(raw: string | null): string {
  if (!raw) return "Unassigned";
  const out =
    raw
      .replace(/^deluxe garages\s*[-–—]?\s*/i, "")
      .replace(/,\s*[A-Z]{2}\s*$/i, "")
      .trim() || raw;
  // Canonicalise variants so counts, POs, goals, and revenue all join.
  if (/^corpus( christi)?$/i.test(out)) return "Corpus Christi";
  return out;
}

function findHeaderRow(grid: RawGrid): { index: number; map: ColumnMap } | null {
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const row = grid[r] ?? [];
    const lower = row.map((c) => toText(c)?.toLowerCase() ?? "");
    if (!lower.some((c) => HEADER_ALIASES.jobNumber.includes(c))) continue;

    const map = {} as ColumnMap;
    for (const key of Object.keys(HEADER_ALIASES) as (keyof ColumnMap)[]) {
      map[key] = lower.findIndex((c) => HEADER_ALIASES[key].includes(c));
    }
    return { index: r, map };
  }
  return null;
}

export function parsePipeline(grid: RawGrid): PipelineParseResult {
  if (!Array.isArray(grid)) {
    throw new Error("Pipeline data must be a grid of rows.");
  }

  const header = findHeaderRow(grid);
  if (!header) {
    throw new PipelineFormatError(
      "Couldn't find the pipeline header row (expected a 'Job #' column). " +
        "Make sure you uploaded the Production Pipeline Report export."
    );
  }

  const { index, map } = header;

  // Title rows above the header carry a "... Data as of ..." label; prefer it.
  let sourceLabel: string | null = null;
  for (let r = 0; r < index; r++) {
    for (const c of grid[r] ?? []) {
      const text = toText(c);
      if (text && /\bas of\b/i.test(text)) sourceLabel = text;
    }
  }
  if (!sourceLabel) sourceLabel = toText(grid[0]?.[0]) ?? null;
  const projects: BuilderPrimeProject[] = [];
  const classes: Record<string, number> = {};

  for (let r = index + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const jobNumber = toText(cell(row, map.jobNumber));
    if (!jobNumber) continue; // skip blank / footer rows

    const rawClass = toText(cell(row, map.className));
    const className = cleanClassName(rawClass);
    const description = toText(cell(row, map.description));
    // The job name ("RevaFlex - Pool Deck - 550 - Brownstone") carries the
    // area, sqft, and color in newer exports where Description is blank.
    const projectName = toText(cell(row, map.projectName));
    const type = toText(cell(row, map.type));
    const crew = toText(cell(row, map.projectManager));
    // SQFT: the column, else the middle number of the job name or description
    // ("Back Patio - 396 - Wombat").
    const midNumber = (s: string | null) => {
      const m = s?.match(/-\s*(\d{2,5})\s*-/);
      return m ? Number(m[1]) : null;
    };
    const sqft =
      toNumber(cell(row, map.sqft)) ??
      midNumber(projectName) ??
      midNumber(description);
    // Color: the export's own color columns beat name/description mining. Skip
    // placeholder values that aren't colors.
    const PLACEHOLDER_RE = /^(tbd|custom|revadrive|n\/?a)$/i;
    const colColor = [toText(cell(row, map.flakeColor)), toText(cell(row, map.revaColor))]
      .find((c) => c && !PLACEHOLDER_RE.test(c));
    // The name's trailing "- <color>" segment resolves typos/aliases via the
    // catalog ("Creek Bed" → Creekbed); free-text mining is the last resort.
    const tailColor = (s: string | null) => {
      const tail = s?.match(/-\s*([^-]+?)\s*$/)?.[1] ?? null;
      const hit = normalizeColor(tail);
      return hit?.recognized ? hit.name : null;
    };
    const color =
      colColor ??
      tailColor(projectName) ??
      tailColor(description) ??
      extractColorFromText(projectName) ??
      extractColorFromText(description);
    const client = toText(cell(row, map.client));

    classes[className] = (classes[className] ?? 0) + 1;

    const customFields: Record<string, unknown> = {};
    if (sqft !== null) customFields["SQFT"] = sqft;
    if (color) customFields["Flake Color"] = color;
    if (type) customFields["Project Type"] = type;
    if (crew) customFields["Crew"] = crew;

    projects.push({
      projectId: jobNumber,
      jobNumber,
      // Newer exports carry the customer in a Client column; the job name
      // ("RevaFlex - Pool Deck - 550 - Brownstone") shows as the description.
      clientFirstName: client ?? undefined,
      description: description ?? projectName ?? undefined,
      city: toText(cell(row, map.city)) ?? undefined,
      state: toText(cell(row, map.state)) ?? undefined,
      zip: toText(cell(row, map.zip)) ?? undefined,
      className,
      estimatedValue: toNumber(cell(row, map.soldAmount)) ?? 0,
      laborCost: toNumber(cell(row, map.laborCost)) ?? 0,
      materialCost: toNumber(cell(row, map.materialCost)) ?? 0,
      estimatedStartDate: toMs(cell(row, map.start)),
      estimatedFinishDate: toMs(cell(row, map.finish)),
      projectStatusDescription: type ?? undefined,
      projectStatusIsComplete: false,
      projectStatusIsCancelled: false,
      salesPersonFirstName: toText(cell(row, map.salesPerson)) ?? undefined,
      customFields,
    });
  }

  return { projects, rowCount: projects.length, classes, sourceLabel };
}
