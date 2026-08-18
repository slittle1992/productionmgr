import { describe, expect, it } from "vitest";
import {
  isPurchaseOrderGrid,
  parsePurchaseOrder,
} from "../src/domain/purchaseOrders.js";

// Shaped like the PDF text extraction of a RevaRok PO.
const PO_GRID: unknown[][] = [
  ["PURCHASE ORDER"],
  ["RevaRok PO NUMBER:"],
  ["ORDER DATE:"],
  ["EST. RECEIVE DATE:"],
  ["FM-DALLAS-091025"],
  ["9/11/2025"],
  ["10/31/2025"],
  ["Supplier"],
  ["Fieldmaster"],
  ["No. 1279 Tongxie Road, Shangcheng District"],
  ["Ship to"],
  ["RevaRok"],
  ["756 Port America Place: Suite 100"],
  ["Grapevine, TX 76051"],
  ["Product ID Description Packing Quantity Unit price Subtotal"],
  ["CM-EPDM-ATLANTIS CM - EPDM - ATLANTIS 160 36.25 5,800.00"],
  ["EPDM-BLACK EPDM - BLACK 160 34.75 5,560.00"],
  ["Total: 113,600.00"],
];

describe("purchase orders", () => {
  it("distinguishes POs from inventory counts", () => {
    expect(isPurchaseOrderGrid(PO_GRID)).toBe(true);
    expect(
      isPurchaseOrderGrid([["FLAKE COLOR", "Count"], ["Glacier", 42]])
    ).toBe(false);
  });

  it("parses number, supplier, ship-to location, and total", () => {
    const po = parsePurchaseOrder(PO_GRID);
    expect(po.poNumber).toBe("FM-DALLAS-091025");
    expect(po.supplier).toBe("Fieldmaster");
    expect(po.className).toBe("Dallas");
    expect(po.total).toBe(113600);
    expect(po.orderMs).toBe(Date.UTC(2025, 8, 11));
  });

  it("maps the other ship-to cities", () => {
    const at = (city: string) =>
      parsePurchaseOrder([
        ["PURCHASE ORDER"],
        ["Unit price"],
        ["Ship to"],
        [city],
        ["Product ID"],
        ["Total: 100.00"],
      ]).className;
    expect(at("89 Falon Lane; Liberty Hill, TX 78642")).toBe("Austin");
    expect(at("132 Windy Meadows; Schertz, Texas")).toBe("San Antonio");
    expect(at("3838 Wow Rd; Corpus Christi, TX")).toBe("Corpus");
    expect(at("8028 Dowdell Road; Tomball, TX")).toBe("Houston");
    expect(at("916 S. Arcade Ave; Freeport, IL")).toBeNull();
  });
});
