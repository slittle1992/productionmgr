/**
 * Weekly report data model. Mirrors the field source map in §4 of the spec.
 *
 * Three groups of fields:
 *  - auto:    pulled from Builder Prime (pre-filled, overridable)
 *  - manual:  only the manager knows these
 *  - derived: computed by the app (never entered)
 */

/** Fields Builder Prime can supply. Each is a number of dollars. */
export interface AutoFilledFields {
  /** Sum of estimatedValue for projects starting in the target week. */
  projectedJobSchedule: number;
  /** Sum of value for projects completed in the week. */
  completedJobsRevenue: number;
  /** Sum of laborCost for projected projects. */
  projectedLabor: number;
}

/** Fields only the manager can provide (§4 "manual" rows). */
export interface ManualFields {
  /** Raw labor total from payroll + manager salary, BEFORE the x1.2 multiplier. */
  actualLaborRaw: number;
  /** Count of warranties opened this week (manual in v1 — §8.1). */
  warrantiesOpenedThisWeek: number;
  /** New leads this week (feeds Total Leads QTD). */
  leadsThisWeek: number;
  /** Materials given for warranties this week ($). */
  materialsGivenForWarranties: number;
  /** Projected materials cost ($) — Option A: entered directly (§6). */
  projectedMaterials: number;
  /** Actual materials from inventory count ($). */
  actualMaterials: number;
  /** Total sundries cost from the PO list ($). */
  totalSundriesCost: number;
}

/** Manager overrides of auto-filled values. Undefined means "use the auto value". */
export type AutoOverrides = Partial<AutoFilledFields>;

/** Values computed by the app. */
export interface DerivedFields {
  /** actualLaborRaw x laborMultiplier. */
  actualLabor: number;
  /** Mirrors completedJobsRevenue (§4 Installed Revenue). */
  installedRevenue: number;
  /** totalSundriesCost / completedJobsRevenue (0 when no revenue). */
  sundriesRatio: number;
  /** This week's warranties + prior weeks' total this quarter. */
  totalWarrantiesQTD: number;
  /** This week's leads + prior weeks' total this quarter. */
  totalLeadsQTD: number;
}

export type ReportStatus = "draft" | "submitted";

export interface WeeklyReport {
  weekStart: string;
  /** Class this report covers (e.g. "Austin"); "All" = company-wide. */
  className: string;
  weekEnd: string;
  quarter: string;
  status: ReportStatus;
  /** Effective auto values after any overrides are applied. */
  auto: AutoFilledFields;
  /** Raw values pulled from Builder Prime, before overrides (for "auto-filled" badge + reset). */
  autoSource: AutoFilledFields;
  overrides: AutoOverrides;
  manual: ManualFields;
  derived: DerivedFields;
  updatedAt: string;
  submittedAt: string | null;
  /** True when auto values came from sample data rather than the live API. */
  usingSampleData: boolean;
}

/** Persisted shape — the inputs we need to recompute a report deterministically. */
export interface StoredReport {
  weekStart: string;
  /** Class this report covers; "All" = company-wide. */
  className: string;
  weekEnd: string;
  quarter: string;
  status: ReportStatus;
  autoSource: AutoFilledFields;
  overrides: AutoOverrides;
  manual: ManualFields;
  updatedAt: string;
  submittedAt: string | null;
  usingSampleData: boolean;
}

export function emptyManualFields(): ManualFields {
  return {
    actualLaborRaw: 0,
    warrantiesOpenedThisWeek: 0,
    leadsThisWeek: 0,
    materialsGivenForWarranties: 0,
    projectedMaterials: 0,
    actualMaterials: 0,
    totalSundriesCost: 0,
  };
}

export function emptyAutoFields(): AutoFilledFields {
  return { projectedJobSchedule: 0, completedJobsRevenue: 0, projectedLabor: 0 };
}
