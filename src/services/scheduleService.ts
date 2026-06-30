import type { CoverageRates, CustomFieldNames } from "../config.js";
import type { ProjectProvider } from "../builderPrime/provider.js";
import { readCustomField, type BuilderPrimeProject } from "../builderPrime/types.js";
import { normalizeColor } from "../domain/colors.js";
import { computeMaterials, type MaterialEstimate } from "../domain/materials.js";
import {
  getReportingWeek,
  getReportingWeekFromStart,
  isWithinWeek,
  type ReportingWeek,
} from "../domain/week.js";
import type { JobAssignment, ScheduleStore } from "../storage/scheduleStore.js";

/** One job line on the weekly schedule. */
export interface ScheduleJob {
  id: string;
  jobNumber: string;
  customer: string;
  projectType: string;
  className: string;
  city: string;
  sqft: number | null;
  color: string | null;
  /** True when the color matched the canonical catalog. */
  colorRecognized: boolean;
  /** Manager-assigned crew (not in Builder Prime). */
  crew: string;
  /** Scheduled day (ms) and weekday label. */
  scheduledDate: number | null;
  scheduledDay: string | null;
  material: MaterialEstimate;
  /** True when the manager corrected the pulled color/sqft. */
  edited: { color: boolean; sqft: boolean };
}

export interface ScheduleClassGroup {
  className: string;
  jobs: ScheduleJob[];
}

export interface WeeklySchedule {
  weekStart: string;
  weekEnd: string;
  usingSampleData: boolean;
  classes: ScheduleClassGroup[];
  jobCount: number;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export class ScheduleService {
  constructor(
    private readonly provider: ProjectProvider,
    private readonly store: ScheduleStore,
    private readonly coverage: CoverageRates,
    private readonly fields: CustomFieldNames,
    private readonly weekStartDay: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  get usingSampleData(): boolean {
    return this.provider.isSample;
  }

  private resolveWeek(weekStart?: string): ReportingWeek {
    return weekStart
      ? getReportingWeekFromStart(weekStart, this.weekStartDay)
      : getReportingWeek(this.now(), this.weekStartDay);
  }

  private buildJob(
    p: BuilderPrimeProject,
    index: number,
    week: ReportingWeek,
    assignments: Record<string, JobAssignment>
  ): ScheduleJob {
    const jobNumber =
      str(readCustomField(p, this.fields.jobNumber)) ??
      str(p.jobNumber) ??
      str(p.projectId) ??
      str(p.opportunityId) ??
      `job-${index}`;
    const id = jobNumber;
    const assignment = assignments[id] ?? {};

    const bpSqft = toNumber(readCustomField(p, this.fields.sqft));
    const sqft = assignment.sqftOverride ?? bpSqft;

    const bpColorRaw = str(readCustomField(p, this.fields.color));
    const effectiveColorRaw = assignment.colorOverride ?? bpColorRaw;
    const normalized = normalizeColor(effectiveColorRaw);

    const projectType =
      str(readCustomField(p, this.fields.projectType)) ??
      str(p.projectStatusDescription) ??
      "—";

    const scheduledDate = p.estimatedStartDate ?? null;
    const material = computeMaterials(
      sqft,
      projectType,
      normalized?.flakeProduct ?? null,
      this.coverage
    );

    return {
      id,
      jobNumber,
      customer:
        [p.clientFirstName, p.clientLastName].filter(Boolean).join(" ").trim() ||
        p.clientCompanyName ||
        p.projectName ||
        "—",
      projectType,
      className: str(p.className) ?? "Unassigned",
      city: [p.city, p.state].filter(Boolean).join(", "),
      sqft,
      color: normalized?.name ?? null,
      colorRecognized: normalized?.recognized ?? false,
      crew: assignment.crew ?? "",
      scheduledDate,
      scheduledDay:
        scheduledDate !== null ? WEEKDAYS[new Date(scheduledDate).getUTCDay()]! : null,
      material,
      edited: {
        color: assignment.colorOverride !== undefined,
        sqft: assignment.sqftOverride !== undefined,
      },
    };
  }

  /** Build the weekly schedule grouped by Builder Prime class. */
  async getSchedule(weekStart?: string): Promise<WeeklySchedule> {
    const week = this.resolveWeek(weekStart);
    const [projects, assignments] = await Promise.all([
      this.provider.listAllProjects({}),
      this.store.getWeek(week.weekStart),
    ]);

    const jobs = projects
      .filter((p) => !p.projectStatusIsCancelled)
      .filter((p) => isWithinWeek(p.estimatedStartDate, week))
      .map((p, i) => this.buildJob(p, i, week, assignments));

    // Group by class, preserving a stable, readable order.
    const groups = new Map<string, ScheduleJob[]>();
    for (const job of jobs) {
      const bucket = groups.get(job.className) ?? [];
      bucket.push(job);
      groups.set(job.className, bucket);
    }

    const classes: ScheduleClassGroup[] = [...groups.entries()]
      .map(([className, list]) => ({
        className,
        jobs: list.sort(
          (a, b) => (a.scheduledDate ?? 0) - (b.scheduledDate ?? 0) || a.customer.localeCompare(b.customer)
        ),
      }))
      .sort((a, b) => a.className.localeCompare(b.className));

    return {
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      usingSampleData: this.provider.isSample,
      classes,
      jobCount: jobs.length,
    };
  }

  /** Persist a crew assignment or a color/sqft correction for a job. */
  async assignJob(
    weekStart: string | undefined,
    jobId: string,
    assignment: JobAssignment
  ): Promise<JobAssignment> {
    const week = this.resolveWeek(weekStart);
    return this.store.setJob(week.weekStart, jobId, assignment);
  }
}
