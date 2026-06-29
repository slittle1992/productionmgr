import { describe, expect, it } from "vitest";
import { computeAutoFromProjects } from "../src/services/reportService.js";
import { getReportingWeekFromStart } from "../src/domain/week.js";
import type { BuilderPrimeProject } from "../src/builderPrime/types.js";

const week = getReportingWeekFromStart("2026-06-28"); // Sun 6/28 – Sat 7/4
const inWeek = Date.parse("2026-06-30T12:00:00Z");
const outOfWeek = Date.parse("2026-07-20T12:00:00Z");

describe("computeAutoFromProjects", () => {
  it("sums estimatedValue and laborCost for projects starting in the week", () => {
    const projects: BuilderPrimeProject[] = [
      { estimatedValue: 1000, laborCost: 300, estimatedStartDate: inWeek },
      { estimatedValue: 2000, laborCost: 500, estimatedStartDate: inWeek },
      { estimatedValue: 9999, laborCost: 999, estimatedStartDate: outOfWeek },
    ];
    const auto = computeAutoFromProjects(projects, week);
    expect(auto.projectedJobSchedule).toBe(3000);
    expect(auto.projectedLabor).toBe(800);
  });

  it("sums completed revenue for projects completed in the week", () => {
    const projects: BuilderPrimeProject[] = [
      {
        estimatedValue: 5000,
        projectStatusIsComplete: true,
        completionDateTime: inWeek,
      },
      {
        estimatedValue: 7000,
        projectStatusIsComplete: true,
        completionDateTime: outOfWeek,
      },
    ];
    const auto = computeAutoFromProjects(projects, week);
    expect(auto.completedJobsRevenue).toBe(5000);
  });

  it("excludes cancelled projects entirely", () => {
    const projects: BuilderPrimeProject[] = [
      {
        estimatedValue: 5000,
        laborCost: 1000,
        estimatedStartDate: inWeek,
        projectStatusIsCancelled: true,
      },
    ];
    const auto = computeAutoFromProjects(projects, week);
    expect(auto.projectedJobSchedule).toBe(0);
    expect(auto.projectedLabor).toBe(0);
  });

  it("does not count a completed project toward the projected schedule", () => {
    const projects: BuilderPrimeProject[] = [
      {
        estimatedValue: 5000,
        laborCost: 1000,
        estimatedStartDate: inWeek,
        projectStatusIsComplete: true,
        completionDateTime: inWeek,
      },
    ];
    const auto = computeAutoFromProjects(projects, week);
    expect(auto.projectedJobSchedule).toBe(0);
    expect(auto.completedJobsRevenue).toBe(5000);
  });
});
