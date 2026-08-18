import { PipelineFormatError, cleanClassName, type RawGrid } from "./pipeline.js";

/**
 * Weekly inventory counts (ReVamp Material Tracker export).
 *
 * The sheet is a list of category sections — "EPDM COLOR", "FLAKE BASE COAT",
 * "FLAKE COLOR", … — each with Item + Count rows. There are no dollar amounts
 * in the export, so material COST is derived elsewhere: usage = last week's
 * count − this week's count, priced with the app's unit-cost catalog.
 */

export interface InventoryCountLine {
  item: string;
  category: string | null;
  count: number;
}

export interface InventoryParseResult {
  lines: InventoryCountLine[];
  itemCount: number;
  /** e.g. "Submitted 8/17/2026, 7:59:59 AM · by John Blake · 4 trailers" */
  sourceLabel: string | null;
  /** Location parsed from the sheet title ("Deluxe Garages - Austin — Inventory Count"). */
  className: string | null;
}

/**
 * Plain text lines (pasted table or PDF-extracted text) → grid rows: the
 * trailing number on a line is the count, the rest is the item name.
 */
export function textLinesToGrid(lines: string[]): RawGrid {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)[\s ]+(-?\d[\d,]*(?:\.\d+)?)$/);
      return m ? [m[1]!, m[2]!] : [line];
    });
}

export interface InventoryUsageLine {
  item: string;
  category: string | null;
  /** Last week's count, or null when the item wasn't on last week's sheet. */
  prevCount: number | null;
  count: number;
  /** Units used this week (prev − current, floored at 0); null without a prior week. */
  used: number | null;
  /** True when the count went UP (shipment received / returns) — usage shows 0. */
  restocked: boolean;
  unitCost: number | null;
  /** used × unitCost, when both are known. */
  cost: number | null;
}

export interface InventoryUsage {
  lines: InventoryUsageLine[];
  /** Σ cost over priced lines. */
  totalCost: number;
  /** Lines with used > 0. */
  usedCount: number;
  /** Lines with used > 0 and a unit cost. */
  pricedCount: number;
  /** Items that were used but have no unit cost yet (cost is understated). */
  unpricedItems: string[];
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = text(v);
  if (!s || !/^-?\$?\d[\d,]*(\.\d+)?$/.test(s)) return null;
  const n = Number(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Canonical item name: the tracker appends warning annotations
 * (⚠ increase — "Received a shipment") and blend recipes (— Finale: 33% CH15 …)
 * that vary week to week, so both are stripped to keep names stable.
 */
export function cleanItemName(raw: string): string {
  return raw
    .replace(/⚠.*$/u, "")
    .replace(/[—-]\s*Finale:.*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Matching key for week-over-week and price lookups. */
export function itemKey(name: string): string {
  return cleanItemName(name).toLowerCase();
}

/**
 * Parse an uploaded counts grid. Accepts the tracker's section layout
 * (category header rows ending in "Count", then Item|Count rows) as well as a
 * plain two-column Item/Count sheet. Rows may come from a spreadsheet (item and
 * count in separate cells) or from pasted text split client-side.
 */
export function parseInventory(grid: RawGrid): InventoryParseResult {
  if (!Array.isArray(grid)) {
    throw new PipelineFormatError("Inventory data must be a grid of rows.");
  }

  const lines: InventoryCountLine[] = [];
  const seen = new Set<string>();
  let category: string | null = null;
  let sourceLabel: string | null = null;
  let className: string | null = null;

  for (const raw of grid) {
    const cells = (raw ?? []).map(text).filter((c): c is string => c !== null);
    if (!cells.length) continue;

    // Item rows end with a number; everything before it is the name.
    const last = cells[cells.length - 1]!;
    const count = cells.length > 1 ? num(last) : null;
    if (count !== null) {
      const item = cleanItemName(cells.slice(0, -1).join(" "));
      if (!item) continue;
      const key = itemKey(item);
      if (seen.has(key)) continue; // duplicated rows in some exports
      seen.add(key);
      lines.push({ item, category, count });
      continue;
    }

    // Non-item rows: section headers ("EPDM COLOR  Count"), the submitted
    // stamp, or page furniture we can ignore.
    const joined = cells.join(" ").trim();
    if (/^submitted\b/i.test(joined)) {
      sourceLabel = joined;
      continue;
    }
    // Sheet title carries the location: "Deluxe Garages - Austin — Inventory Count".
    const title = joined.match(/^(.+?)\s*[—-]{1,2}\s*Inventory Count\b/i);
    if (title && !className) {
      className = cleanClassName(title[1]!) || null;
      continue;
    }
    // Section headers end in "Count" ("FLAKE COLOR  Count"); skip URLs,
    // timestamps, plain Item/Count headers, and long prose.
    const header = joined.replace(/\s*count$/i, "").trim();
    if (
      header &&
      header.length < joined.length &&
      header.length <= 40 &&
      header.toLowerCase() !== "item" &&
      !/https?:|\d{1,2}\/\d{1,2}\/\d{2}/.test(header)
    ) {
      category = header;
    }
  }

  if (lines.length < 3) {
    throw new PipelineFormatError(
      "Couldn't read the inventory count — expected rows of item names with a " +
        "count at the end (the ReVamp Material Tracker export)."
    );
  }
  return { lines, itemCount: lines.length, sourceLabel, className };
}

/**
 * Week-over-week usage: what was on the trailer last week but not this week.
 * A count that went UP (shipment / returns) counts as 0 used — the tracker
 * doesn't report shipment sizes separately, so usage in a restock week is
 * understated and flagged instead of guessed.
 */
export function computeInventoryUsage(
  prev: InventoryCountLine[] | null,
  current: InventoryCountLine[],
  prices: Record<string, number>
): InventoryUsage {
  const prevByKey = new Map(
    (prev ?? []).map((l) => [itemKey(l.item), l.count])
  );

  const lines: InventoryUsageLine[] = current.map((l) => {
    const key = itemKey(l.item);
    const prevCount = prev ? prevByKey.get(key) ?? null : null;
    const used = prevCount === null ? null : r2(Math.max(prevCount - l.count, 0));
    const unitCost = prices[key] ?? null;
    return {
      item: l.item,
      category: l.category,
      prevCount,
      count: l.count,
      used,
      restocked: prevCount !== null && l.count > prevCount,
      unitCost,
      cost: used !== null && unitCost !== null ? r2(used * unitCost) : null,
    };
  });

  const usedLines = lines.filter((l) => (l.used ?? 0) > 0);
  return {
    lines,
    totalCost: r2(usedLines.reduce((n, l) => n + (l.cost ?? 0), 0)),
    usedCount: usedLines.length,
    pricedCount: usedLines.filter((l) => l.unitCost !== null).length,
    unpricedItems: usedLines.filter((l) => l.unitCost === null).map((l) => l.item),
  };
}
