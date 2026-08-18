import { describe, expect, it } from "vitest";
import {
  cleanItemName,
  computeInventoryUsage,
  itemKey,
  parseInventory,
} from "../src/domain/inventory.js";
import { PipelineFormatError } from "../src/domain/pipeline.js";

/** Grid shaped like the ReVamp Material Tracker export (item + count cells). */
const TRACKER_GRID: unknown[][] = [
  ["Deluxe Garages - Austin — Inventory Count"],
  ["Submitted 8/10/2026, 8:07:26 AM · by John Blake · 4 trailers"],
  ["EPDM COLOR", "Count"],
  ["EPDM - BEIGE - CH02", 14.5],
  ["EPDM - LIGHT GREY CH15", 40],
  ['EPDM - EGGSHELL CH14 ⚠ big drop — "Used on jobs this week"', 2],
  ["EPDM Brownstone — Finale: 33% CH15 / 33% CH14/ 33% CH58", 76],
  ["FLAKE COLOR", "Count"],
  ["Autumn Brown", 36],
  ["Claystone", 7],
  ["UV Resin Binder 4469", 2.5],
];

describe("parseInventory", () => {
  it("reads tracker-format counts with categories and annotations", () => {
    const result = parseInventory(TRACKER_GRID);
    expect(result.itemCount).toBe(7);
    expect(result.sourceLabel).toMatch(/^Submitted 8\/10\/2026/);

    const beige = result.lines.find((l) => l.item.includes("BEIGE"));
    expect(beige).toMatchObject({ category: "EPDM COLOR", count: 14.5 });

    // ⚠ annotations and Finale blend recipes are stripped from names.
    expect(result.lines.map((l) => l.item)).toContain("EPDM - EGGSHELL CH14");
    expect(result.lines.map((l) => l.item)).toContain("EPDM Brownstone");

    const brown = result.lines.find((l) => l.item === "Autumn Brown");
    expect(brown).toMatchObject({ category: "FLAKE COLOR", count: 36 });
  });

  it("keeps numbers that are part of item names out of the count", () => {
    const result = parseInventory(TRACKER_GRID);
    const resin = result.lines.find((l) => l.item === "UV Resin Binder 4469");
    expect(resin?.count).toBe(2.5);
  });

  it("reads pasted-text rows where the count is the trailing token", () => {
    const result = parseInventory([
      ["FLAKE COLOR  Count"],
      ["Autumn Brown", "36"],
      ["Glacier", "42"],
      ["Wombat FB/616", "23"],
    ]);
    expect(result.itemCount).toBe(3);
    expect(result.lines[0]).toMatchObject({
      item: "Autumn Brown",
      category: "FLAKE COLOR",
      count: 36,
    });
  });

  it("rejects grids without recognizable count rows", () => {
    expect(() => parseInventory([["Hello"], ["World"]])).toThrow(PipelineFormatError);
  });
});

describe("item name normalisation", () => {
  it("strips annotations and blend recipes but keeps real names", () => {
    expect(cleanItemName('Claystone ⚠ big drop — "Used on jobs"')).toBe("Claystone");
    expect(cleanItemName("EPDM Slate — Finale: 50% CH15 / 50% CH57")).toBe("EPDM Slate");
    expect(cleanItemName("Chestnut / Cherokee - FB002")).toBe("Chestnut / Cherokee - FB002");
    expect(itemKey("  AUTUMN  Brown ")).toBe("autumn brown");
  });
});

describe("computeInventoryUsage", () => {
  const prev = [
    { item: "Claystone", category: "FLAKE COLOR", count: 17 },
    { item: "Autumn Brown", category: "FLAKE COLOR", count: 36 },
    { item: "Creek Bed FB-716", category: "FLAKE COLOR", count: 13 },
  ];
  const curr = [
    { item: "Claystone", category: "FLAKE COLOR", count: 7 },
    { item: "Autumn Brown", category: "FLAKE COLOR", count: 36 },
    { item: "Creek Bed FB-716", category: "FLAKE COLOR", count: 30 },
    { item: "Crimson - FB004", category: "FLAKE COLOR", count: 1 },
  ];

  it("computes used = prev − current, floors restocks at 0", () => {
    const usage = computeInventoryUsage(prev, curr, {});
    const by = new Map(usage.lines.map((l) => [l.item, l]));
    expect(by.get("Claystone")).toMatchObject({ prevCount: 17, used: 10, restocked: false });
    expect(by.get("Autumn Brown")?.used).toBe(0);
    expect(by.get("Creek Bed FB-716")).toMatchObject({ used: 0, restocked: true });
    // New item this week: no prior count, no usage claim.
    expect(by.get("Crimson - FB004")).toMatchObject({ prevCount: null, used: null });
    expect(usage.usedCount).toBe(1);
    expect(usage.totalCost).toBe(0);
    expect(usage.unpricedItems).toEqual(["Claystone"]);
  });

  it("prices usage from the unit-cost catalog", () => {
    const usage = computeInventoryUsage(prev, curr, { claystone: 80.5 });
    const clay = usage.lines.find((l) => l.item === "Claystone");
    expect(clay?.cost).toBe(805);
    expect(usage.totalCost).toBe(805);
    expect(usage.pricedCount).toBe(1);
    expect(usage.unpricedItems).toEqual([]);
  });

  it("reports no usage when there is no prior week", () => {
    const usage = computeInventoryUsage(null, curr, {});
    expect(usage.lines.every((l) => l.used === null)).toBe(true);
    expect(usage.usedCount).toBe(0);
  });
});
