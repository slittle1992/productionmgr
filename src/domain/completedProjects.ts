import { cleanClassName, toMs, type RawGrid } from "./pipeline.js";
import { PipelineFormatError } from "./pipeline.js";
import { parseMoney } from "./pastDue.js";

/**
 * Parser for the Builder Prime "Completed Projects Report" export.
 *
 * Friday meeting §4: labor rate = completed revenue ÷ (production payroll ×
 * 1.2), per location per week. The completed-projects upload supplies the
 * revenue side; the payroll workbook (or a manual entry) supplies the payroll
 * side.
 */

export interface CompletedJob {
  jobNumber: string;
  client: string;
  projectName: string | null;
  className: string;
  /** When the job was marked completed (ms). */
  completedDate: number | null;
  soldAmount: number | null;
  paidAmount: number | null;
  contractPrice: number | null;
  laborCost: number | null;
  type: string | null;
  foreman: string | null;
  worker1: string | null;
  projectManager: string | null;
  salesPerson: string | null;
}

const HEADERS: Record<string, string[]> = {
  completed: ["completed"],
  client: ["client", "customer"],
  projectName: ["project name"],
  jobNumber: ["job #", "job number", "job no"],
  className: ["class"],
  soldAmount: ["sold amount"],
  paidAmount: ["paid amount"],
  contractPrice: ["total contract price", "contract price"],
  laborCost: ["labor cost"],
  type: ["type"],
  foreman: ["foreman"],
  worker1: ["worker 1", "worker1"],
  projectManager: ["project manager"],
  salesPerson: ["sales person", "salesperson"],
};

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export interface CompletedParseResult {
  jobs: CompletedJob[];
  sourceLabel: string | null;
}

export function parseCompletedProjects(grid: RawGrid): CompletedParseResult {
  if (!Array.isArray(grid)) {
    throw new PipelineFormatError("Completed-projects data must be a grid of rows.");
  }

  let headerRow = -1;
  const col: Record<string, number> = {};
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const lower = (grid[r] ?? []).map((c) => text(c)?.toLowerCase() ?? "");
    if (
      lower.some((c) => HEADERS.completed!.includes(c)) &&
      lower.some((c) => HEADERS.jobNumber!.includes(c))
    ) {
      headerRow = r;
      for (const [key, names] of Object.entries(HEADERS)) {
        col[key] = lower.findIndex((c) => names.includes(c));
      }
      break;
    }
  }
  if (headerRow < 0) {
    throw new PipelineFormatError(
      "Couldn't find the completed-projects header row (expected 'Completed' " +
        "and 'Job #' columns). Make sure you uploaded the Completed Projects report."
    );
  }

  const cell = (row: unknown[], key: string) =>
    col[key]! >= 0 ? row[col[key]!] : undefined;

  const jobs: CompletedJob[] = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const jobNumber = text(cell(row, "jobNumber"));
    if (!jobNumber) continue;
    jobs.push({
      jobNumber,
      client: text(cell(row, "client")) ?? "—",
      projectName: text(cell(row, "projectName")),
      className: cleanClassName(text(cell(row, "className"))),
      completedDate: toMs(cell(row, "completed")) ?? null,
      soldAmount: parseMoney(cell(row, "soldAmount")),
      paidAmount: parseMoney(cell(row, "paidAmount")),
      contractPrice: parseMoney(cell(row, "contractPrice")),
      laborCost: parseMoney(cell(row, "laborCost")),
      type: text(cell(row, "type")),
      foreman: text(cell(row, "foreman")),
      worker1: text(cell(row, "worker1")),
      projectManager: text(cell(row, "projectManager")),
      salesPerson: text(cell(row, "salesPerson")),
    });
  }
  return { jobs, sourceLabel: findSourceLabel(grid, headerRow) };
}

function findSourceLabel(grid: RawGrid, headerRow: number): string | null {
  for (let r = 0; r < headerRow; r++) {
    for (const c of grid[r] ?? []) {
      const t = text(c);
      if (t && /\bas of\b/i.test(t)) return t;
    }
  }
  return null;
}

/** Revenue counted for a completed job: sold amount, else contract price, else paid. */
export function completedRevenue(job: CompletedJob): number {
  return job.soldAmount ?? job.contractPrice ?? job.paidAmount ?? 0;
}
