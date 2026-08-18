import { describe, expect, it } from "vitest";
import { expectedJobCost } from "../src/domain/expectedMaterials.js";
import { loadConfig } from "../src/config.js";

const coverage = loadConfig({} as NodeJS.ProcessEnv).coverage;

describe("expectedJobCost", () => {
  it("prices a flake job near the known ~$0.70/sqft spec", () => {
    const cost = expectedJobCost(1000, "Full Floor Coating", "Glacier", coverage);
    // flake 150lb→3.75 boxes×$62 + basecoat 7.5gal×$25 + topcoat ~15.4gal×$44.
    expect(cost / 1000).toBeGreaterThan(0.6);
    expect(cost / 1000).toBeLessThan(0.8);
  });

  it("prices a rubber job near ~$2.5/sqft", () => {
    const cost = expectedJobCost(435, "Rubber Overlay", "Sterling", coverage);
    expect(cost / 435).toBeGreaterThan(2.2);
    expect(cost / 435).toBeLessThan(2.9);
  });

  it("returns 0 for types that use no material", () => {
    expect(expectedJobCost(500, "Inspection", null, coverage)).toBe(0);
  });
});
