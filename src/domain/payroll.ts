import { toMs } from "./pipeline.js";
import { parseMoney } from "./pastDue.js";

/**
 * Reader for the per-location weekly payroll workbook (e.g. "Deluxe Garages
 * Austin Payroll"). The browser sends every sheet as a raw grid; each weekly
 * sheet lists employees with a Department column and a Total Gross Pay column.
 * We extract the production-department total per sheet so the meeting can pick
 * the sheet matching the week and fill the labor-rate denominator. Older books
 * label techs "Production"; the 2026 template labels them "Installer - PFP" /
 * "Installer - Hourly" — both count.
 */

export interface PayrollSheet {
  name: string;
  rows: unknown[][];
}

export interface PayrollSheetSummary {
  sheetName: string;
  /** Sum of Total Gross Pay for Department = Production. */
  productionTotal: number;
  /** How many employee rows were counted. */
  employeeCount: number;
  /** "Pay period start date:" cell, when the sheet has one (ISO date). */
  periodStart: string | null;
  periodEnd: string | null;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function isoDate(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Find a labelled date like "Pay period start date:" → "2026-07-19". */
function findLabelledDate(rows: unknown[][], label: RegExp): string | null {
  for (const row of rows) {
    for (let c = 0; c < (row?.length ?? 0); c++) {
      const t = text(row[c]);
      if (!t || !label.test(t)) continue;
      // The date sits in one of the next few cells to the right.
      for (let k = c + 1; k < Math.min(c + 4, row.length); k++) {
        const ms = toMs(row[k]);
        if (ms !== undefined) return isoDate(ms);
      }
    }
  }
  return null;
}

/**
 * Summarise one sheet. Returns null when the sheet has no recognisable
 * Department / Total Gross Pay table (instruction or export-summary sheets).
 */
export function summarisePayrollSheet(sheet: PayrollSheet): PayrollSheetSummary | null {
  const rows = sheet.rows ?? [];

  let headerRow = -1;
  let deptCol = -1;
  let grossCol = -1;
  for (let r = 0; r < rows.length; r++) {
    // Array.from tolerates sparse rows (holes become undefined, not skipped).
    const lower = Array.from(rows[r] ?? [], (c) => text(c)?.toLowerCase() ?? "");
    const d = lower.findIndex((c) => c === "department");
    const g = lower.findIndex((c) => c.startsWith("total gross pay"));
    if (d >= 0 && g >= 0) {
      headerRow = r;
      deptCol = d;
      grossCol = g;
      break;
    }
  }
  if (headerRow < 0) return null;

  let productionTotal = 0;
  let employeeCount = 0;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const dept = text(row[deptCol])?.toLowerCase();
    if (!dept || (dept !== "production" && !dept.startsWith("installer"))) continue;
    const gross = parseMoney(row[grossCol]);
    if (gross === null) continue;
    productionTotal += gross;
    employeeCount++;
  }

  return {
    sheetName: sheet.name,
    productionTotal: Math.round(productionTotal * 100) / 100,
    employeeCount,
    periodStart: findLabelledDate(rows, /pay\s*period\s*start/i),
    periodEnd: findLabelledDate(rows, /pay\s*period\s*end/i),
  };
}

/**
 * Summarise every sheet in the workbook, most useful first: sheets whose pay
 * period overlaps `weekStart`/`weekEnd` sort to the front, then sheets with
 * production pay, then the rest.
 */
export function summarisePayrollWorkbook(
  sheets: PayrollSheet[],
  weekStart?: string,
  weekEnd?: string
): PayrollSheetSummary[] {
  const summaries = sheets
    .map(summarisePayrollSheet)
    .filter((s): s is PayrollSheetSummary => s !== null);

  const overlaps = (s: PayrollSheetSummary): boolean => {
    if (!weekStart || !weekEnd || !s.periodStart || !s.periodEnd) return false;
    return s.periodStart <= weekEnd && s.periodEnd >= weekStart;
  };

  // Template/utility tabs parse like data but shouldn't be the suggestion.
  const utility = (s: PayrollSheetSummary): boolean =>
    /do not touch|master with all|template/i.test(s.sheetName);

  return summaries.sort((a, b) => {
    const byWeek = Number(overlaps(b)) - Number(overlaps(a));
    if (byWeek !== 0) return byWeek;
    const byUtility = Number(utility(a)) - Number(utility(b));
    if (byUtility !== 0) return byUtility;
    const byHasPay = Number(b.productionTotal > 0) - Number(a.productionTotal > 0);
    if (byHasPay !== 0) return byHasPay;
    return 0;
  });
}
