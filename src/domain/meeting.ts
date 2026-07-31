import type { BuilderPrimeProject } from "../builderPrime/types.js";
import { readCustomField } from "../builderPrime/types.js";
import type { CustomFieldNames } from "../config.js";
import type { ReportingWeek } from "./week.js";
import { isWithinWeek } from "./week.js";
import type { WorkOrder } from "./workOrders.js";
import { isClosedStatus } from "./workOrders.js";
import type { CompletedJob } from "./completedProjects.js";
import { completedRevenue } from "./completedProjects.js";

/**
 * Pure computations behind the Friday Production Meeting screen: work-order
 * review (§2), pipeline health checks (§3), and labor rates (§4). Manual
 * checklist items (§5–7 Reviews / Lytx / Ramp) are plain per-week state.
 */

// ───────────────────────── Per-week meeting document ─────────────────────────

export type CheckKey = "reviews" | "lytx" | "ramp";
export const CHECK_KEYS: CheckKey[] = ["reviews", "lytx", "ramp"];

export interface ManualCheck {
  status: "pending" | "done";
  /** What was found — incidents this week, review counts, etc. */
  notes: string;
  /** Who reviewed the dashboard. */
  by: string;
  at: string | null;
}

export interface LaborEntry {
  /** Production-department gross pay for the week (from payroll sheet). */
  productionPayroll: number | null;
  /** Manual override of completed revenue, when the upload isn't available. */
  revenueOverride: number | null;
  /** Which payroll sheet the number came from, for the audit trail. */
  sheetName: string | null;
  by: string | null;
}

export type SectionKey =
  | "pastdue"
  | "workorders"
  | "pipeline"
  | "labor"
  | CheckKey;

export const SECTION_KEYS: SectionKey[] = [
  "pastdue",
  "workorders",
  "pipeline",
  "labor",
  "reviews",
  "lytx",
  "ramp",
];

export interface SectionState {
  done: boolean;
  by: string | null;
  at: string | null;
}

export interface MeetingWeekDoc {
  weekStart: string;
  checks: Record<CheckKey, ManualCheck>;
  /** Labor-rate inputs keyed by class name. */
  labor: Record<string, LaborEntry>;
  /** Manual sign-off per section. */
  sections: Partial<Record<SectionKey, SectionState>>;
  updatedAt: string | null;
}

export function emptyWeekDoc(weekStart: string): MeetingWeekDoc {
  const check = (): ManualCheck => ({ status: "pending", notes: "", by: "", at: null });
  return {
    weekStart,
    checks: { reviews: check(), lytx: check(), ramp: check() },
    labor: {},
    sections: {},
    updatedAt: null,
  };
}

// ───────────────────────── §2 Work-order review ─────────────────────────

/** Lead/cause tag a meeting attendee puts on a warranty work order. */
export interface WoNote {
  woId: string;
  /** Crew lead responsible for the warranty. */
  lead: string;
  /** Why the warranty happened. */
  cause: string;
  by: string | null;
  at: string;
}

/** Types that count as quality issues caused by an install crew. */
const WARRANTY_TYPE = /warranty|call\s*back|redo|re-do/i;

export function isWarrantyType(type: string | null | undefined): boolean {
  return Boolean(type && WARRANTY_TYPE.test(type));
}

export interface WorkOrderClassSummary {
  className: string;
  open: number;
  completed: number;
  openWarranties: number;
}

export interface WarrantyRow {
  id: string;
  woNumber: string;
  client: string;
  city: string | null;
  type: string;
  status: string | null;
  startDate: number | null;
  createdDate: number | null;
  className: string;
  open: boolean;
  lead: string;
  cause: string;
}

export interface LeadWarrantySummary {
  lead: string;
  count: number;
  causes: string[];
}

export interface WorkOrderReview {
  classes: WorkOrderClassSummary[];
  /** Warranty-type WOs, open first then newest first, with lead/cause tags. */
  warranties: WarrantyRow[];
  /** Warranties grouped by tagged lead — "who causes warranties and why". */
  byLead: LeadWarrantySummary[];
  untaggedWarranties: number;
  totalOpen: number;
  totalCompleted: number;
}

export function buildWorkOrderReview(
  workOrders: WorkOrder[],
  notes: Record<string, WoNote>
): WorkOrderReview {
  const classes = new Map<string, WorkOrderClassSummary>();
  const warranties: WarrantyRow[] = [];
  let totalOpen = 0;
  let totalCompleted = 0;

  for (const wo of workOrders) {
    const cls = wo.className || "Unassigned";
    let sum = classes.get(cls);
    if (!sum) {
      sum = { className: cls, open: 0, completed: 0, openWarranties: 0 };
      classes.set(cls, sum);
    }
    const closed = isClosedStatus(wo.status);
    const warranty = isWarrantyType(wo.type);
    if (closed) {
      sum.completed++;
      totalCompleted++;
    } else {
      sum.open++;
      totalOpen++;
      if (warranty) sum.openWarranties++;
    }
    if (warranty) {
      const note = notes[wo.id];
      warranties.push({
        id: wo.id,
        woNumber: wo.woNumber,
        client: wo.client,
        city: wo.city,
        type: wo.type,
        status: wo.status,
        startDate: wo.startDate,
        createdDate: wo.createdDate,
        className: cls,
        open: !closed,
        lead: note?.lead ?? "",
        cause: note?.cause ?? "",
      });
    }
  }

  warranties.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return (b.createdDate ?? 0) - (a.createdDate ?? 0);
  });

  const byLeadMap = new Map<string, LeadWarrantySummary>();
  let untagged = 0;
  for (const w of warranties) {
    if (!w.lead) {
      untagged++;
      continue;
    }
    let entry = byLeadMap.get(w.lead.toLowerCase());
    if (!entry) {
      entry = { lead: w.lead, count: 0, causes: [] };
      byLeadMap.set(w.lead.toLowerCase(), entry);
    }
    entry.count++;
    if (w.cause && !entry.causes.includes(w.cause)) entry.causes.push(w.cause);
  }

  return {
    classes: [...classes.values()].sort((a, b) =>
      a.className.localeCompare(b.className)
    ),
    warranties,
    byLead: [...byLeadMap.values()].sort((a, b) => b.count - a.count),
    untaggedWarranties: untagged,
    totalOpen,
    totalCompleted,
  };
}

// ───────────────────────── §3 Pipeline health ─────────────────────────

export interface PipelineJobFlag {
  jobNumber: string;
  description: string | null;
  className: string;
  soldAmount: number;
  startDate: number | null;
  salesPerson: string | null;
  /** True when the job starts inside the first look-ahead week (urgent). */
  startsSoon: boolean;
}

export interface DayLoad {
  /** ISO date. */
  date: string;
  jobs: number;
  total: number;
  /** empty | light | ok | heavy — relative to the class's average day. */
  load: "empty" | "light" | "ok" | "heavy";
}

export interface PipelineClassWeek {
  className: string;
  jobsThisWeek: number;
  totalThisWeek: number;
  days: DayLoad[];
}

/** One look-ahead week's per-class daily load. */
export interface PipelineWeekLoad {
  weekStart: string;
  weekEnd: string;
  classes: PipelineClassWeek[];
  jobCount: number;
}

export interface PipelineChecks {
  /** Jobs with no start date at all (unscheduled backlog), by class. */
  noStartDate: PipelineJobFlag[];
  /** Jobs scheduled (any date) but with no crew/labor assigned. */
  noCrew: PipelineJobFlag[];
  /**
   * Per-day load for the UPCOMING weeks. The Friday meeting looks ahead:
   * on Friday 7/31 you're checking that 8/2–8/8 (and 8/9–8/15) are full and
   * evenly scheduled, not the week that's ending.
   */
  weeks: PipelineWeekLoad[];
  totalJobs: number;
}

function crewOf(p: BuilderPrimeProject, fields: CustomFieldNames): string | null {
  const custom = readCustomField(p, fields.crew);
  if (custom !== undefined && custom !== null && String(custom).trim() !== "") {
    return String(custom).trim();
  }
  const pm = [p.projectManagerFirstName, p.projectManagerLastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return pm || null;
}

const MS_PER_DAY = 86_400_000;

function buildWeekLoad(
  projects: BuilderPrimeProject[],
  week: ReportingWeek
): PipelineWeekLoad {
  const perClassDay = new Map<string, Map<string, { jobs: number; total: number }>>();
  let jobCount = 0;

  for (const p of projects) {
    if (p.projectStatusIsCancelled || p.projectStatusIsComplete) continue;
    const start = p.estimatedStartDate;
    if (!isWithinWeek(start, week) || start === undefined) continue;
    jobCount++;
    const cls = p.className ?? "Unassigned";
    const day = new Date(start).toISOString().slice(0, 10);
    let days = perClassDay.get(cls);
    if (!days) {
      days = new Map();
      perClassDay.set(cls, days);
    }
    const d = days.get(day) ?? { jobs: 0, total: 0 };
    d.jobs++;
    d.total += p.estimatedValue ?? 0;
    days.set(day, d);
  }

  // Mon–Sat working days (Sunday is off).
  const workDays: string[] = [];
  for (let i = 0; i < 7; i++) {
    const ms = week.startMs + i * MS_PER_DAY;
    if (new Date(ms).getUTCDay() === 0) continue;
    workDays.push(new Date(ms).toISOString().slice(0, 10));
  }

  const classes: PipelineClassWeek[] = [];
  for (const [cls, days] of perClassDay) {
    let jobsThisWeek = 0;
    let totalThisWeek = 0;
    for (const d of days.values()) {
      jobsThisWeek += d.jobs;
      totalThisWeek += d.total;
    }
    const scheduledDays = [...days.values()].filter((d) => d.jobs > 0).length || 1;
    const avg = totalThisWeek / scheduledDays;
    const dayLoads: DayLoad[] = workDays.map((date) => {
      const d = days.get(date) ?? { jobs: 0, total: 0 };
      let load: DayLoad["load"] = "ok";
      if (d.jobs === 0) load = "empty";
      else if (avg > 0 && d.total < avg * 0.5) load = "light";
      else if (avg > 0 && d.total > avg * 1.5) load = "heavy";
      return { date, jobs: d.jobs, total: d.total, load };
    });
    classes.push({ className: cls, jobsThisWeek, totalThisWeek, days: dayLoads });
  }
  classes.sort((a, b) => a.className.localeCompare(b.className));

  return { weekStart: week.weekStart, weekEnd: week.weekEnd, classes, jobCount };
}

export function buildPipelineChecks(
  projects: BuilderPrimeProject[],
  weeks: ReportingWeek[],
  fields: CustomFieldNames
): PipelineChecks {
  const noStartDate: PipelineJobFlag[] = [];
  const noCrew: PipelineJobFlag[] = [];
  const soonWeek = weeks[0];

  const flag = (p: BuilderPrimeProject, startsSoon: boolean): PipelineJobFlag => ({
    jobNumber: String(p.jobNumber ?? p.projectId ?? "—"),
    description: p.description ?? p.projectName ?? null,
    className: p.className ?? "Unassigned",
    soldAmount: p.estimatedValue ?? 0,
    startDate: p.estimatedStartDate ?? null,
    salesPerson: p.salesPersonFirstName ?? null,
    startsSoon,
  });

  for (const p of projects) {
    if (p.projectStatusIsCancelled || p.projectStatusIsComplete) continue;
    const start = p.estimatedStartDate;
    if (start === undefined || start === null) {
      noStartDate.push(flag(p, false));
    } else if (!crewOf(p, fields)) {
      noCrew.push(flag(p, soonWeek ? isWithinWeek(start, soonWeek) : false));
    }
  }

  noStartDate.sort(
    (a, b) => a.className.localeCompare(b.className) || b.soldAmount - a.soldAmount
  );
  noCrew.sort((a, b) => {
    if (a.startsSoon !== b.startsSoon) return a.startsSoon ? -1 : 1;
    return (a.startDate ?? 0) - (b.startDate ?? 0);
  });

  return {
    noStartDate,
    noCrew,
    weeks: weeks.map((w) => buildWeekLoad(projects, w)),
    totalJobs: projects.length,
  };
}

// ───────────────────────── §4 Labor rate ─────────────────────────

export interface LaborRateRow {
  className: string;
  /** Sum of completed revenue in the week, from the completed-projects upload. */
  completedRevenue: number;
  /** Jobs behind that revenue. */
  completedJobs: number;
  revenueOverride: number | null;
  productionPayroll: number | null;
  sheetName: string | null;
  /** revenue ÷ (payroll × multiplier); null until payroll is entered. */
  rate: number | null;
}

/** Labor rate = completed revenue ÷ (production payroll × multiplier). */
export function laborRate(
  revenue: number,
  payroll: number | null,
  multiplier: number
): number | null {
  if (payroll === null || payroll <= 0) return null;
  return revenue / (payroll * multiplier);
}

export function buildLaborRates(
  jobs: CompletedJob[],
  week: ReportingWeek,
  labor: Record<string, LaborEntry>,
  multiplier: number
): LaborRateRow[] {
  const byClass = new Map<string, { revenue: number; jobs: number }>();
  for (const job of jobs) {
    if (!isWithinWeek(job.completedDate ?? undefined, week)) continue;
    const cls = job.className || "Unassigned";
    const entry = byClass.get(cls) ?? { revenue: 0, jobs: 0 };
    entry.revenue += completedRevenue(job);
    entry.jobs++;
    byClass.set(cls, entry);
  }

  // A location with saved labor inputs shows up even without completed jobs.
  const names = new Set([...byClass.keys(), ...Object.keys(labor)]);
  const rows: LaborRateRow[] = [];
  for (const className of names) {
    const revenue = byClass.get(className) ?? { revenue: 0, jobs: 0 };
    const entry = labor[className];
    const effectiveRevenue = entry?.revenueOverride ?? revenue.revenue;
    rows.push({
      className,
      completedRevenue: Math.round(revenue.revenue * 100) / 100,
      completedJobs: revenue.jobs,
      revenueOverride: entry?.revenueOverride ?? null,
      productionPayroll: entry?.productionPayroll ?? null,
      sheetName: entry?.sheetName ?? null,
      rate: laborRate(effectiveRevenue, entry?.productionPayroll ?? null, multiplier),
    });
  }
  return rows.sort((a, b) => a.className.localeCompare(b.className));
}
