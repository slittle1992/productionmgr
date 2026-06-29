/**
 * Pure calculation engine for the weekly report. No I/O — given inputs and the
 * quarter-to-date history, it produces the effective auto values and every
 * derived field (FR-3). This is the heart of "the app does the math".
 */

import type {
  AutoFilledFields,
  AutoOverrides,
  DerivedFields,
  ManualFields,
} from "./weeklyReport.js";

/** Round to cents to avoid floating-point noise in money fields. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Apply manager overrides on top of the auto-pulled source values. */
export function applyOverrides(
  source: AutoFilledFields,
  overrides: AutoOverrides
): AutoFilledFields {
  return {
    projectedJobSchedule:
      overrides.projectedJobSchedule ?? source.projectedJobSchedule,
    completedJobsRevenue:
      overrides.completedJobsRevenue ?? source.completedJobsRevenue,
    projectedLabor: overrides.projectedLabor ?? source.projectedLabor,
  };
}

/** Prior-quarter rollup carried in from earlier weeks (excludes this week). */
export interface PriorQtd {
  warranties: number;
  leads: number;
}

export interface ComputeDerivedArgs {
  auto: AutoFilledFields;
  manual: ManualFields;
  laborMultiplier: number;
  priorQtd: PriorQtd;
}

export function computeDerived({
  auto,
  manual,
  laborMultiplier,
  priorQtd,
}: ComputeDerivedArgs): DerivedFields {
  const completed = auto.completedJobsRevenue;
  return {
    actualLabor: roundMoney(manual.actualLaborRaw * laborMultiplier),
    installedRevenue: roundMoney(completed),
    sundriesRatio:
      completed > 0 ? roundMoney(manual.totalSundriesCost / completed) : 0,
    totalWarrantiesQTD:
      priorQtd.warranties + manual.warrantiesOpenedThisWeek,
    totalLeadsQTD: priorQtd.leads + manual.leadsThisWeek,
  };
}
