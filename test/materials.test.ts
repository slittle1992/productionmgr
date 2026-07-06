import { describe, expect, it } from "vitest";
import {
  appliesMaterial,
  computeMaterials,
  isRubberType,
} from "../src/domain/materials.js";
import type { CoverageConfig } from "../src/config.js";

const coverage: CoverageConfig = {
  flake: {
    flakeLbsPerSqft: 0.15,
    flakeBoxLbs: 40,
    polyureaSqftPerGallon: 200,
    polyureaPartsA: 2,
    polyureaPartsB: 1,
    polyasparticSqftPerGallon: 130,
  },
  rubber: {
    sqftPerBag: 30,
    sqftPerBinderBucket: 160,
    sqftPerPrimerBucket: 700,
  },
};

const color = (name: string, flakeProduct = name) => ({ name, flakeProduct });

describe("computeMaterials — flake", () => {
  it("derives polyurea, polyaspartic, and flake quantities from sqft", () => {
    const m = computeMaterials(435, "Flake", color("Caspian"), coverage);
    expect(m.kind).toBe("flake");
    // Polyurea basecoat: 200 sqft per total gallon, mixed 2:1 A:B.
    expect(m.basecoatAGallons).toBe(1.45); // 435/200 * 2/3
    expect(m.basecoatBGallons).toBe(0.72); // 435/200 * 1/3 (0.72499… rounds down)
    // Polyaspartic topcoat: 130 sqft per total gallon, equal parts.
    expect(m.topcoatAGallons).toBe(1.67); // 435/130 / 2
    expect(m.topcoatBGallons).toBe(1.67);
    // Flake: sqft x 0.15 lbs, in 40 lb boxes.
    expect(m.flakePounds).toBe(65.25); // 435 * 0.15
    expect(m.flakeBoxes).toBe(1.63); // 65.25 / 40
    expect(m.flake).toBe("Caspian");
    // Rubber fields stay zeroed.
    expect(m.rubberBags).toBe(0);
    expect(m.binderBuckets).toBe(0);
  });

  it("splits polyurea 2:1 so A is exactly double B on round numbers", () => {
    const m = computeMaterials(600, "Flake", color("Gray"), coverage);
    expect(m.basecoatAGallons).toBe(2); // 600/200 = 3 total → A 2
    expect(m.basecoatBGallons).toBe(1); // → B 1
  });

  it("uses the flake product name, not the display color", () => {
    const m = computeMaterials(100, "Concrete Coating", color("Orbit", "Voodoo / Orbit"), coverage);
    expect(m.flake).toBe("Voodoo / Orbit");
  });
});

describe("computeMaterials — rubber", () => {
  it("derives bags, binder, and primer from sqft (30 / 160 / 700 sqft per unit)", () => {
    const m = computeMaterials(480, "Rubber Coating", color("Limestone"), coverage);
    expect(m.kind).toBe("rubber");
    expect(m.rubberBags).toBe(16); // 480/30
    expect(m.binderBuckets).toBe(3); // 480/160
    expect(m.primerBuckets).toBe(0.69); // 480/700
    // Rubber pulls the color blend itself, not a flake product.
    expect(m.flake).toBe("Limestone");
    // Flake fields stay zeroed.
    expect(m.basecoatAGallons).toBe(0);
    expect(m.flakePounds).toBe(0);
  });

  it("recognizes rubber regardless of case or trailing *", () => {
    for (const t of ["Rubber", "rubber*", "Rubber Coating"]) {
      expect(computeMaterials(30, t, color("Black"), coverage).kind).toBe("rubber");
      expect(isRubberType(t)).toBe(true);
    }
    expect(isRubberType("Concrete Coating")).toBe(false);
  });
});

describe("computeMaterials — no-material types", () => {
  it("returns zero material for warranty / inspection / sand & clear", () => {
    for (const type of ["Warranty", "Inspection", "Sand & Clear"]) {
      const m = computeMaterials(500, type, color("Gray"), coverage);
      expect(m.kind).toBe("none");
      expect(m.applies).toBe(false);
      expect(m.flakePounds).toBe(0);
      expect(m.rubberBags).toBe(0);
      expect(m.flake).toBeNull();
    }
  });

  it("treats a trailing * as scheduled, not a different type", () => {
    const m = computeMaterials(500, "Flake*", color("Gray"), coverage);
    expect(m.applies).toBe(true);
    expect(m.flakePounds).toBeGreaterThan(0);
  });

  it("handles missing sqft gracefully", () => {
    const flake = computeMaterials(null, "Flake", color("Gray"), coverage);
    expect(flake.basecoatAGallons).toBe(0);
    const rubber = computeMaterials(null, "Rubber", color("Gray"), coverage);
    expect(rubber.rubberBags).toBe(0);
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
