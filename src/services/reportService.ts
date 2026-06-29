import type { BuilderPrimeProject } from "../builderPrime/types.js";
import {
  applyOverrides,
  computeDerived,
  roundMoney,
  type PriorQtd,
} from "../domain/calculations.js";
import {
  getReportingWeek,
  getReportingWeekFromStart,
  isWithinWeek,
  quarterWeekStarts,
  type ReportingWeek,
} from "../domain/week.js";
import {
  emptyAutoFields,
  emptyManualFields,
  type AutoFilledFields,
  type AutoOverrides,
  type ManualFields,
  type StoredReport,
  type WeeklyReport,
} from "../domain/weeklyReport.js";
import type { ReportRepository } from "../storage/repository.js";
import type { ProjectsService } from "./projectsService.js";

export interface SaveReportInput {
  overrides: AutoOverrides;
  manual: ManualFields;
}

/**
 * Compute the auto-filled fields for a week directly from Builder Prime project
 * records (FR-1). Cancelled projects never count.
 */
export function computeAutoFromProjects(
  projects: BuilderPrimeProject[],
  week: ReportingWeek
): AutoFilledFields {
  const auto = emptyAutoFields();
  for (const p of projects) {
    if (p.projectStatusIsCancelled) continue;

    const startsThisWeek = isWithinWeek(p.estimatedStartDate, week);
    const completedThisWeek =
      Boolean(p.projectStatusIsComplete) &&
      isWithinWeek(p.completionDateTime ?? p.estimatedFinishDate, week);

    if (startsThisWeek && !p.projectStatusIsComplete) {
      auto.projectedJobSchedule += p.estimatedValue ?? 0;
      auto.projectedLabor += p.laborCost ?? 0;
    }
    if (completedThisWeek) {
      auto.completedJobsRevenue += p.estimatedValue ?? 0;
    }
  }
  return {
    projectedJobSchedule: roundMoney(auto.projectedJobSchedule),
    completedJobsRevenue: roundMoney(auto.completedJobsRevenue),
    projectedLabor: roundMoney(auto.projectedLabor),
  };
}

export class ReportService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly repo: ReportRepository,
    private readonly laborMultiplier: number,
    private readonly weekStartDay: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  private resolveWeek(weekStart?: string): ReportingWeek {
    return weekStart
      ? getReportingWeekFromStart(weekStart, this.weekStartDay)
      : getReportingWeek(this.now(), this.weekStartDay);
  }

  /** Sum prior weeks' manual counts for the quarter, excluding `week` itself. */
  private async priorQtd(week: ReportingWeek): Promise<PriorQtd> {
    const starts = quarterWeekStarts(week, this.weekStartDay).filter(
      (s) => s !== week.weekStart
    );
    const stored = await Promise.all(starts.map((s) => this.repo.get(s)));
    return stored.reduce<PriorQtd>(
      (acc, r) => {
        if (r) {
          acc.warranties += r.manual.warrantiesOpenedThisWeek;
          acc.leads += r.manual.leadsThisWeek;
        }
        return acc;
      },
      { warranties: 0, leads: 0 }
    );
  }

  private assemble(
    week: ReportingWeek,
    stored: StoredReport | null,
    autoSource: AutoFilledFields,
    overrides: AutoOverrides,
    manual: ManualFields,
    priorQtd: PriorQtd,
    usingSampleData: boolean
  ): WeeklyReport {
    const auto = applyOverrides(autoSource, overrides);
    const derived = computeDerived({
      auto,
      manual,
      laborMultiplier: this.laborMultiplier,
      priorQtd,
    });
    return {
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      quarter: week.quarter,
      status: stored?.status ?? "draft",
      auto,
      autoSource,
      overrides,
      manual,
      derived,
      updatedAt: stored?.updatedAt ?? new Date(this.now()).toISOString(),
      submittedAt: stored?.submittedAt ?? null,
      usingSampleData,
    };
  }

  /**
   * Load (and live-refresh) the report for a week. A submitted report keeps its
   * Builder Prime snapshot; a draft re-pulls fresh auto values while preserving
   * the manager's manual entries and overrides.
   */
  async getReport(weekStart?: string): Promise<WeeklyReport> {
    const week = this.resolveWeek(weekStart);
    const stored = await this.repo.get(week.weekStart);

    let autoSource: AutoFilledFields;
    let usingSampleData: boolean;
    if (stored && stored.status === "submitted") {
      autoSource = stored.autoSource;
      usingSampleData = stored.usingSampleData;
    } else {
      const raw = await this.projects.fetchRawProjects();
      autoSource = computeAutoFromProjects(raw, week);
      usingSampleData = this.projects.usingSampleData;
    }

    const overrides = stored?.overrides ?? {};
    const manual = stored?.manual ?? emptyManualFields();
    const priorQtd = await this.priorQtd(week);

    return this.assemble(
      week,
      stored,
      autoSource,
      overrides,
      manual,
      priorQtd,
      usingSampleData
    );
  }

  /** Save a draft or submit a final report (FR-4, FR-5). */
  async saveReport(
    weekStart: string | undefined,
    input: SaveReportInput,
    submit: boolean
  ): Promise<WeeklyReport> {
    const week = this.resolveWeek(weekStart);
    const existing = await this.repo.get(week.weekStart);

    // Refresh the snapshot from Builder Prime at save time so the stored auto
    // values match what the manager is confirming.
    const raw = await this.projects.fetchRawProjects();
    const autoSource = computeAutoFromProjects(raw, week);
    const usingSampleData = this.projects.usingSampleData;

    const nowIso = new Date(this.now()).toISOString();
    const toStore: StoredReport = {
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      quarter: week.quarter,
      status: submit ? "submitted" : "draft",
      autoSource,
      overrides: input.overrides,
      manual: input.manual,
      updatedAt: nowIso,
      submittedAt: submit ? nowIso : existing?.submittedAt ?? null,
      usingSampleData,
    };
    await this.repo.save(toStore);

    const priorQtd = await this.priorQtd(week);
    return this.assemble(
      week,
      toStore,
      autoSource,
      input.overrides,
      input.manual,
      priorQtd,
      usingSampleData
    );
  }

  /** Lightweight history list for the archive view. */
  async listHistory(): Promise<
    Array<Pick<StoredReport, "weekStart" | "weekEnd" | "quarter" | "status" | "submittedAt">>
  > {
    const all = await this.repo.listAll();
    return all.map((r) => ({
      weekStart: r.weekStart,
      weekEnd: r.weekEnd,
      quarter: r.quarter,
      status: r.status,
      submittedAt: r.submittedAt,
    }));
  }
}
