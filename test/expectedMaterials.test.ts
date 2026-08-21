import { describe, expect, it } from "vitest";
import {
  expectedJobCost,
  expectedMaterialsByClass,
  jobKey,
} from "../src/domain/expectedMaterials.js";
import { getReportingWeekFromStart } from "../src/domain/week.js";
import { loadConfig as lc } from "../src/config.js";
import { loadConfig } from "../src/config.js";

const coverage = loadConfig({} as NodeJS.ProcessEnv).coverage;

describe("expectedJobCost", () => {
  it("prices a flake job near the known ~$0.70/sqft spec", () => {
    const cost = expectedJobCost(1000, "Full Floor Coating", "Glacier", coverage);
    // flake 150lb→3.75 boxes×$62 + basecoat 7.5gal×$25 + topcoat ~15.4gal×$44.
    expect(cost / 1000).toBeGreaterThan(0.6);
    expect(cost / 1000).toBeLessThan(0.8);
  });

  it("prices a rubber job near ~$3.2/sqft ($57 landed EPDM bags)", () => {
    const cost = expectedJobCost(435, "Rubber Overlay", "Sterling", coverage);
    expect(cost / 435).toBeGreaterThan(2.9);
    expect(cost / 435).toBeLessThan(3.6);
  });

  it("returns 0 for types that use no material", () => {
    expect(expectedJobCost(500, "Inspection", null, coverage)).toBe(0);
  });
});

describe("expectedMaterialsByClass with job-facts history", () => {
  const cfg = lc({} as NodeJS.ProcessEnv);
  const week = getReportingWeekFromStart("2026-08-09", 0);
  const completed = [
    {
      jobNumber: "JOB-197886",
      client: "A",
      projectName: null,
      className: "Austin",
      completedDate: Date.parse("2026-08-12T12:00:00Z"),
      soldAmount: null,
      paidAmount: null,
      contractPrice: 7000,
      laborCost: null,
      type: "Full Floor Coating",
      foreman: null,
      worker1: null,
      projectManager: null,
      salesPerson: null,
    },
  ];

  it("joins via remembered facts when the job left the pipeline", () => {
    // Current pipeline is empty; history knows the job (digit-normalised key).
    const rows = expectedMaterialsByClass(
      completed as never,
      week,
      [],
      cfg.customFields,
      cfg.coverage,
      { [jobKey("197886")]: { sqft: 1000, color: "Glacier" } }
    );
    expect(rows[0]?.jobsWithSqft).toBe(1);
    expect(rows[0]?.sqft).toBe(1000);
    expect(rows[0]?.expectedCost).toBeGreaterThan(500);
  });

  it("normalises job-number formats", () => {
    expect(jobKey("JOB-197886")).toBe(jobKey(" 197886 "));
  });
});
