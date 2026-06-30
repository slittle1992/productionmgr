import { describe, expect, it } from "vitest";
import { appliesMaterial, computeMaterials } from "../src/domain/materials.js";
import type { CoverageRates } from "../src/config.js";

const rates: CoverageRates = {
  basecoatADivisor: 315,
  basecoatBDivisor: 630,
  topcoatADivisor: 330,
  topcoatBDivisor: 330,
  flakeLbsPerSqft: 0.125,
};

describe("computeMaterials", () => {
  it("derives gallons and flake pounds from sqft", () => {
    const m = computeMaterials(435, "Rubber", "Caspian", rates);
    expect(m.basecoatAGallons).toBe(1.38); // 435/315
    expect(m.basecoatBGallons).toBe(0.69); // 435/630
    expect(m.topcoatAGallons).toBe(1.32); // 435/330
    expect(m.topcoatBGallons).toBe(1.32);
    expect(m.flakePounds).toBe(54.38); // 435 * 0.125, rounded to 2dp
    expect(m.flake).toBe("Caspian");
    expect(m.applies).toBe(true);
  });

  it("returns zero material for warranty / inspection / sand & clear", () => {
    for (const type of ["Warranty", "Inspection", "Sand & Clear", "Flake*"]) {
      const m = computeMaterials(500, type, "Gray", rates);
      if (type === "Flake*") {
        expect(m.applies).toBe(true); // trailing * is just "scheduled"
        expect(m.flakePounds).toBeGreaterThan(0);
      } else {
        expect(m.applies).toBe(false);
        expect(m.flakePounds).toBe(0);
        expect(m.flake).toBeNull();
      }
    }
  });

  it("handles missing sqft gracefully", () => {
    const m = computeMaterials(null, "Flake", "Gray", rates);
    expect(m.basecoatAGallons).toBe(0);
    expect(m.flakePounds).toBe(0);
  });
});

describe("appliesMaterial", () => {
  it("treats coating types as applicable and warranty-like as not", () => {
    expect(appliesMaterial("Flake")).toBe(true);
    expect(appliesMaterial("Rubber")).toBe(true);
    expect(appliesMaterial("Warranty")).toBe(false);
    expect(appliesMaterial("inspection")).toBe(false);
    expect(appliesMaterial(null)).toBe(true);
  });
});
