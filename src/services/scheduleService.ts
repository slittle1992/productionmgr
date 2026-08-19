import type { CoverageConfig, CustomFieldNames } from "../config.js";
import type { ProjectProvider } from "../builderPrime/provider.js";
import { readCustomField, type BuilderPrimeProject } from "../builderPrime/types.js";
import { normalizeColor } from "../domain/colors.js";
import { computeMaterials, type MaterialEstimate } from "../domain/materials.js";
import { isClosedStatus, type WorkOrder } from "../domain/workOrders.js";
import {
  getReportingWeek,
  getReportingWeekFromStart,
  isWithinWeek,
  type ReportingWeek,
} from "../domain/week.js";
import { jobKey } from "../domain/expectedMaterials.js";
import type { JobAssignment, ScheduleStore } from "../storage/scheduleStore.js";
import type { JobFacts } from "../storage/pipelineStore.js";
import type { WorkOrderStore } from "../storage/workOrderStore.js";

/** One line on the weekly schedule — a pipeline job or a work order. */
export interface ScheduleJob {
  id: string;
  jobNumber: string;
  customer: string;
  projectType: string;
  className: string;
  city: string;
  /** Free-text description / notes. */
  description: string | null;
  /** Contract (sold) amount — the commissionable basis for performance pay. */
  contractValue: number | null;
  sqft: number | null;
  color: string | null;
  colorRecognized: boolean;
  /** Polyurea base color for flake jobs ("Grey" | "Tan" | "Black"). */
  baseColor: string | null;
  /** Ordered crew: [0]=First, [1]=Second, [2]=Third, plus extras. */
  crewMembers: string[];
  /** Joined crew string (search / grouping / legacy display). */
  crew: string;
  scheduledDate: number | null;
  /** Effective weekday index 0–6 (after any PM day move), null if undated. */
  dayIndex: number | null;
  /** How many days the job runs (default 1). */
  days: number;
  /** "Tue" or "Tue–Thu". */
  dayLabel: string | null;
  scheduledDay: string | null;
  material: MaterialEstimate;
  /** Work-order extras. */
  isWorkOrder: boolean;
  urgency: string | null;
  status: string | null;
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
  workOrderCount: number;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WD3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

function crewList(assignment: JobAssignment, defaultCrew: string | null): string[] {
  if (assignment.crewMembers?.length) return assignment.crewMembers;
  if (assignment.crew) return [assignment.crew];
  return defaultCrew ? [defaultCrew] : [];
}

function dayFields(
  scheduledDate: number | null,
  assignment: JobAssignment
): Pick<ScheduleJob, "dayIndex" | "days" | "dayLabel" | "scheduledDay"> {
  const baseIndex =
    assignment.dayOverride ??
    (scheduledDate !== null ? new Date(scheduledDate).getUTCDay() : null);
  const days = Math.max(1, assignment.daysCount ?? 1);
  if (baseIndex === null) {
    return { dayIndex: null, days, dayLabel: null, scheduledDay: null };
  }
  const end = Math.min(baseIndex + days - 1, 6);
  const dayLabel = days > 1 ? `${WD3[baseIndex]}–${WD3[end]}` : WD3[baseIndex]!;
  return { dayIndex: baseIndex, days, dayLabel, scheduledDay: WEEKDAYS[baseIndex]! };
}

export class ScheduleService {
  constructor(
    private readonly provider: ProjectProvider,
    private readonly store: ScheduleStore,
    private readonly coverage: CoverageConfig,
    private readonly fields: CustomFieldNames,
    private readonly weekStartDay: number,
    private readonly now: () => number = () => Date.now(),
    private readonly workOrders?: WorkOrderStore,
    private readonly pipelineStore?: { getJobFacts(): Promise<Record<string, JobFacts>> }
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
    assignments: Record<string, JobAssignment>,
    jobFacts: Record<string, JobFacts> = {}
  ): ScheduleJob {
    const jobNumber =
      str(readCustomField(p, this.fields.jobNumber)) ??
      str(p.jobNumber) ??
      str(p.projectId) ??
      str(p.opportunityId) ??
      `job-${index}`;
    const id = jobNumber;
    const assignment = assignments[id] ?? {};
    // Fall back to the accumulated job history (earlier pipeline uploads,
    // the sqft backfill) when the current export's row is blank.
    const facts = jobFacts[jobKey(jobNumber)];

    const bpSqft = toNumber(readCustomField(p, this.fields.sqft));
    const sqft = assignment.sqftOverride ?? bpSqft ?? facts?.sqft ?? null;

    const bpColorRaw = str(readCustomField(p, this.fields.color));
    const effectiveColorRaw =
      assignment.colorOverride ?? bpColorRaw ?? facts?.color ?? null;
    const normalized = normalizeColor(effectiveColorRaw);

    const projectType =
      str(readCustomField(p, this.fields.projectType)) ??
      str(p.projectStatusDescription) ??
      "—";
    const effectiveType =
      assignment.coating === "rubber"
        ? "Rubber"
        : assignment.coating === "flake"
        ? "Flake"
        : projectType;

    const defaultCrew = str(readCustomField(p, this.fields.crew));
    const scheduledDate = p.estimatedStartDate ?? null;
    const material = computeMaterials(
      sqft,
      effectiveType,
      { name: normalized?.name ?? null, flakeProduct: normalized?.flakeProduct ?? null },
      this.coverage
    );

    const crewMembers = crewList(assignment, defaultCrew);
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
      description: str(p.description),
      contractValue: p.estimatedValue ?? null,
      sqft,
      color: normalized?.name ?? null,
      colorRecognized: normalized?.recognized ?? false,
      baseColor: assignment.baseColor ?? null,
      crewMembers,
      crew: crewMembers.join(" / "),
      scheduledDate,
      ...dayFields(scheduledDate, assignment),
      material,
      isWorkOrder: false,
      urgency: null,
      status: null,
      edited: {
        color: assignment.colorOverride !== undefined,
        sqft: assignment.sqftOverride !== undefined,
      },
    };
  }

  private buildWorkOrderJob(
    wo: WorkOrder,
    assignments: Record<string, JobAssignment>
  ): ScheduleJob {
    const assignment = assignments[wo.id] ?? {};
    const sqft = assignment.sqftOverride ?? null;
    const normalized = normalizeColor(assignment.colorOverride ?? null);
    const closed = isClosedStatus(wo.status);

    // Warranty repairs stage material once the PM sets sqft + color; the
    // coating toggle decides flake vs rubber rates. Closed WOs stage nothing.
    const effectiveType = closed
      ? "Warranty"
      : assignment.coating === "rubber"
      ? "Rubber Repair"
      : "Repair (flake)";
    const material = computeMaterials(
      sqft,
      effectiveType,
      { name: normalized?.name ?? null, flakeProduct: normalized?.flakeProduct ?? null },
      this.coverage
    );

    const crewMembers = crewList(assignment, null);
    const descBits = [wo.address, wo.city].filter(Boolean).join(", ");
    return {
      id: wo.id,
      jobNumber: `WO ${wo.woNumber}`,
      customer: wo.client,
      projectType: wo.type,
      className: wo.className,
      city: wo.city ?? "",
      description: descBits || null,
      contractValue: null,
      sqft,
      color: normalized?.name ?? null,
      colorRecognized: normalized?.recognized ?? false,
      baseColor: assignment.baseColor ?? null,
      crewMembers,
      crew: crewMembers.join(" / "),
      scheduledDate: wo.startDate,
      ...dayFields(wo.startDate, assignment),
      material,
      isWorkOrder: true,
      urgency: wo.urgency,
      status: wo.status,
      edited: {
        color: assignment.colorOverride !== undefined,
        sqft: assignment.sqftOverride !== undefined,
      },
    };
  }

  /** Build the weekly schedule (jobs + work orders) grouped by class. */
  async getSchedule(weekStart?: string): Promise<WeeklySchedule> {
    const week = this.resolveWeek(weekStart);
    const [projects, assignments, storedWos, jobFacts] = await Promise.all([
      this.provider.listAllProjects({}),
      this.store.getWeek(week.weekStart),
      this.workOrders?.get(),
      this.pipelineStore?.getJobFacts() ?? Promise.resolve({}),
    ]);

    const jobs = projects
      .filter((p) => !p.projectStatusIsCancelled)
      .filter((p) => isWithinWeek(p.estimatedStartDate, week))
      .map((p, i) => this.buildJob(p, i, assignments, jobFacts));

    const weekWos = (storedWos ? [...storedWos.uploaded, ...storedWos.manual] : []).filter(
      (wo) => isWithinWeek(wo.startDate ?? undefined, week)
    );
    const woJobs = weekWos.map((wo) => this.buildWorkOrderJob(wo, assignments));

    // Group by class, preserving a stable, readable order.
    const groups = new Map<string, ScheduleJob[]>();
    for (const job of [...jobs, ...woJobs]) {
      const bucket = groups.get(job.className) ?? [];
      bucket.push(job);
      groups.set(job.className, bucket);
    }

    const classes: ScheduleClassGroup[] = [...groups.entries()]
      .map(([className, list]) => ({
        className,
        jobs: list.sort(
          (a, b) =>
            (a.dayIndex ?? 7) - (b.dayIndex ?? 7) ||
            (a.scheduledDate ?? 0) - (b.scheduledDate ?? 0) ||
            a.customer.localeCompare(b.customer)
        ),
      }))
      .sort((a, b) => a.className.localeCompare(b.className));

    return {
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      usingSampleData: this.provider.isSample,
      classes,
      jobCount: jobs.length + woJobs.length,
      workOrderCount: woJobs.length,
    };
  }

  /** Persist a crew/day/color/sqft/coating/base edit for a job or work order. */
  async assignJob(
    weekStart: string | undefined,
    jobId: string,
    assignment: JobAssignment
  ): Promise<JobAssignment> {
    const week = this.resolveWeek(weekStart);
    return this.store.setJob(week.weekStart, jobId, assignment);
  }
}
