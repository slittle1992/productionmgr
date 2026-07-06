import { cleanClassName, toMs, type RawGrid } from "./pipeline.js";
import { PipelineFormatError } from "./pipeline.js";

/**
 * Parser for the Builder Prime work-order export ("Export data" .xlsx).
 * Columns: WO#, Client, Address, City, Type, Start, Class, Urgency, Created,
 * Modified, Status. Header row is matched by name so column order can change.
 *
 * Work orders (warranty/paid repairs) show up on the weekly schedule in their
 * class; the PM sets SQFT + color on the row and material auto-computes into
 * the crew staging lists.
 */
export interface WorkOrder {
  /** Stable id used for schedule assignments, e.g. "wo-17066". */
  id: string;
  woNumber: string;
  client: string;
  address: string | null;
  city: string | null;
  /** e.g. "Warranty Repair", "Paid Repair". */
  type: string;
  startDate: number | null;
  className: string;
  urgency: string | null;
  status: string | null;
  createdDate: number | null;
  /** True when added by a PM in the app rather than uploaded. */
  manual?: boolean;
}

const HEADERS: Record<string, string[]> = {
  wo: ["wo#", "wo #", "wo number", "work order", "work order #"],
  client: ["client", "customer", "customer name"],
  address: ["address"],
  city: ["city"],
  type: ["type"],
  start: ["start"],
  className: ["class"],
  urgency: ["urgency"],
  created: ["created"],
  status: ["status"],
};

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export interface WorkOrderParseResult {
  workOrders: WorkOrder[];
  sourceLabel: string | null;
}

export function parseWorkOrders(grid: RawGrid): WorkOrderParseResult {
  if (!Array.isArray(grid)) throw new PipelineFormatError("Work-order data must be a grid of rows.");

  let headerRow = -1;
  const col: Record<string, number> = {};
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const lower = (grid[r] ?? []).map((c) => text(c)?.toLowerCase() ?? "");
    if (lower.some((c) => HEADERS.wo!.includes(c))) {
      headerRow = r;
      for (const [key, names] of Object.entries(HEADERS)) {
        col[key] = lower.findIndex((c) => names.includes(c));
      }
      break;
    }
  }
  if (headerRow < 0) {
    throw new PipelineFormatError(
      "Couldn't find the work-order header row (expected a 'WO#' column). " +
        "Make sure you uploaded the work-orders export."
    );
  }

  let sourceLabel: string | null = null;
  for (let r = 0; r < headerRow; r++) {
    for (const c of grid[r] ?? []) {
      const t = text(c);
      if (t && /\bas of\b/i.test(t)) sourceLabel = t;
    }
  }

  const cell = (row: unknown[], key: string) =>
    col[key]! >= 0 ? row[col[key]!] : undefined;

  const workOrders: WorkOrder[] = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const wo = text(cell(row, "wo"));
    if (!wo) continue;
    workOrders.push({
      id: `wo-${wo}`,
      woNumber: wo,
      client: text(cell(row, "client")) ?? "—",
      address: text(cell(row, "address")),
      city: text(cell(row, "city")),
      type: text(cell(row, "type")) ?? "Warranty Repair",
      startDate: toMs(cell(row, "start")) ?? null,
      className: cleanClassName(text(cell(row, "className"))),
      urgency: text(cell(row, "urgency")),
      status: text(cell(row, "status")),
      createdDate: toMs(cell(row, "created")) ?? null,
    });
  }
  return { workOrders, sourceLabel };
}

/** Statuses that mean the visit already happened — no material to stage. */
export function isClosedStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return ["complete", "completed", "paid", "canceled", "cancelled", "closed"].includes(
    status.toLowerCase()
  );
}
