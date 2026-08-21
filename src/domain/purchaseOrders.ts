import type { RawGrid } from "./pipeline.js";

/**
 * Purchase-order PDFs (RevaRok / RevaFlex Surfaces format): dropped into the
 * inventory section straight from the vendor email at ORDER time, they sit as
 * "pending" until a PM taps Received — which books the dollars into that
 * location's purchases for the week the material actually landed.
 */

export interface PoItem {
  description: string;
  qty: number;
  unitPrice: number;
  subtotal: number;
}

export interface ParsedPurchaseOrder {
  poNumber: string | null;
  supplier: string | null;
  /** UTC ms of the order date, when present. */
  orderMs: number | null;
  /** Location resolved from the Ship-to block, when recognisable. */
  className: string | null;
  /** The PO's grand total in dollars. */
  total: number | null;
  /** Line items (description, qty, unit price, subtotal). */
  items: PoItem[];
}

/** Ship-to city → class/location. */
const CITY_CLASSES: [RegExp, string][] = [
  [/grapevine/i, "Dallas"],
  [/liberty hill|leander|austin/i, "Austin"],
  [/schertz|san antonio/i, "San Antonio"],
  [/corpus/i, "Corpus Christi"],
  [/tomball|houston/i, "Houston"],
];

const joinRow = (row: unknown[]): string =>
  row
    .map((c) => (c === null || c === undefined ? "" : String(c)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/** True when the grid is a vendor purchase order, not an inventory count. */
export function isPurchaseOrderGrid(grid: RawGrid): boolean {
  const text = grid.slice(0, 40).map(joinRow).join("\n");
  return /purchase order/i.test(text) && /unit price|subtotal/i.test(text);
}

function parseDate(s: string): number | null {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

export function parsePurchaseOrder(grid: RawGrid): ParsedPurchaseOrder {
  const lines = grid.map(joinRow).filter(Boolean);

  let poNumber: string | null = null;
  let supplier: string | null = null;
  let orderMs: number | null = null;
  let className: string | null = null;
  let total: number | null = null;
  const items: PoItem[] = [];
  const num = (v: string) => Number(v.replace(/,/g, ""));

  let supplierAt = -1;
  let shipToAt = -1;
  let productsAt = lines.length;

  lines.forEach((line, i) => {
    if (supplierAt < 0 && /^supplier$/i.test(line)) supplierAt = i;
    if (shipToAt < 0 && /^ship ?to$/i.test(line)) shipToAt = i;
    if (/^product id\b/i.test(line) && i < productsAt) productsAt = i;

    // "Total: 113,600.00" (possibly split across runs).
    const t = line.match(/total:?\s*\$?\s*([\d,]+\.\d{2})/i);
    if (t) total = Number(t[1]!.replace(/,/g, ""));

    // Product lines end "<qty> <unit price> <subtotal>"; wrapped descriptions
    // simply fail the match and are skipped.
    if (!t && i > productsAt) {
      const it = line.match(
        /^(.*?)\s+(\d[\d,]*(?:\.\d+)?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/
      );
      if (it) {
        const qty = num(it[2]!);
        const unitPrice = num(it[3]!);
        const subtotal = num(it[4]!);
        // Sanity: qty × unit ≈ subtotal keeps page furniture out.
        if (Math.abs(qty * unitPrice - subtotal) < 1) {
          items.push({ description: it[1]!.trim(), qty, unitPrice, subtotal });
        }
      }
    }

    // PO numbers look like "FM-DALLAS-091025" or a bare "111088"; they can
    // share a line with their label or lead lines like "111088 6/15/2026--".
    if (!poNumber) {
      const labelled = line.match(/PO NUMBER:?\s+([A-Z0-9][A-Z0-9-]{3,})/i);
      if (labelled) poNumber = labelled[1]!;
    }
    if (!poNumber) {
      const m =
        line.match(/^([A-Z][A-Z0-9]+(?:-[A-Z0-9]+){1,3})\s*$/i) &&
        !/^(supplier|ship ?to|total)/i.test(line)
          ? line.match(/^([A-Z][A-Z0-9]+(?:-[A-Z0-9]+){1,3})\s*$/i)
          : line.match(/^(\d{6})\b/);
      if (m && !/purchase|order|date/i.test(m[1]!)) poNumber = m[1]!;
    }
    if (orderMs === null && !/est\.?\s*receive/i.test(line)) {
      const d = parseDate(line);
      // The first date on the page is the order date (receive is usually later
      // in the same line block, guarded above).
      if (d !== null && !/\d{1,2}\/\d{1,2}\/\d{2},/.test(line)) orderMs = d;
    }
  });

  if (supplierAt >= 0) {
    supplier = lines[supplierAt + 1]?.slice(0, 60) ?? null;
  }
  const shipWindow = lines
    .slice(shipToAt >= 0 ? shipToAt : 0, productsAt)
    .join(" ");
  for (const [re, cls] of CITY_CLASSES) {
    if (re.test(shipWindow)) {
      className = cls;
      break;
    }
  }

  return { poNumber, supplier, orderMs, className, total, items };
}
