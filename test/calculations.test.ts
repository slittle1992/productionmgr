import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  computeDerived,
  roundMoney,
} from "../src/domain/calculations.js";
import { emptyManualFields } from "../src/domain/weeklyReport.js";

describe("roundMoney", () => {
  it("rounds to cents without float noise", () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(1234.005)).toBe(1234.01);
  });
});

describe("applyOverrides", () => {
  const source = {
    projectedJobSchedule: 100,
    completedJobsRevenue: 200,
    projectedLabor: 50,
  };
  it("keeps source values when no override is present", () => {
    expect(applyOverrides(source, {})).toEqual(source);
  });
  it("applies only the provided overrides", () => {
    expect(applyOverrides(source, { completedJobsRevenue: 250 })).toEqual({
      projectedJobSchedule: 100,
      completedJobsRevenue: 250,
      projectedLabor: 50,
    });
  });
  it("treats a 0 override as a real override, not a fallback", () => {
    expect(applyOverrides(source, { projectedLabor: 0 }).projectedLabor).toBe(0);
  });
});

describe("computeDerived", () => {
  const base = {
    auto: { projectedJobSchedule: 0, completedJobsRevenue: 10000, projectedLabor: 0 },
    laborMultiplier: 1.2,
    priorQtd: { warranties: 3, leads: 12 },
  };

  it("applies the 1.2x labor multiplier", () => {
    const d = computeDerived({
      ...base,
      manual: { ...emptyManualFields(), actualLaborRaw: 5000 },
    });
    expect(d.actualLabor).toBe(6000);
  });

  it("mirrors completed revenue into installed revenue", () => {
    const d = computeDerived({ ...base, manual: emptyManualFields() });
    expect(d.installedRevenue).toBe(10000);
  });

  it("computes sundries ratio as sundries / completed revenue", () => {
    const d = computeDerived({
      ...base,
      manual: { ...emptyManualFields(), totalSundriesCost: 1500 },
    });
    expect(d.sundriesRatio).toBe(0.15);
  });

  it("guards against divide-by-zero when there is no completed revenue", () => {
    const d = computeDerived({
      auto: { projectedJobSchedule: 0, completedJobsRevenue: 0, projectedLabor: 0 },
      laborMultiplier: 1.2,
      priorQtd: { warranties: 0, leads: 0 },
      manual: { ...emptyManualFields(), totalSundriesCost: 500 },
    });
    expect(d.sundriesRatio).toBe(0);
  });

  it("rolls warranties and leads forward from prior quarter weeks", () => {
    const d = computeDerived({
      ...base,
      manual: {
        ...emptyManualFields(),
        warrantiesOpenedThisWeek: 2,
        leadsThisWeek: 5,
      },
    });
    expect(d.totalWarrantiesQTD).toBe(5);
    expect(d.totalLeadsQTD).toBe(17);
  });
});
