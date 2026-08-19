import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Per-job edits the manager makes on the schedule: crew assignment (which isn't
 * in Builder Prime) plus optional corrections to the auto-pulled color or sqft,
 * day moves, multi-day stretches, and (for work orders) the coating type.
 * Stored one JSON file per week so the weekly schedule is reproducible.
 */
export interface JobAssignment {
  /** Legacy single-string crew (older saves); superseded by crewMembers. */
  crew?: string;
  /** Ordered crew list: [0]=First, [1]=Second, [2]=Third, plus extras. */
  crewMembers?: string[];
  colorOverride?: string;
  sqftOverride?: number;
  /** Move the job to another weekday (0=Sunday … 6=Saturday). */
  dayOverride?: number;
  /** How many days the job runs (default 1). */
  daysCount?: number;
  /** Coating override for work orders ("flake" | "rubber"). */
  coating?: string;
  /** Polyurea base color for flake jobs ("Grey" | "Tan" | "Black"). */
  baseColor?: string;
}

export type WeekAssignments = Record<string, JobAssignment>;

/** Drop empty values so stored records stay clean. */
export function cleanAssignment(a: JobAssignment): JobAssignment {
  if (!a.crew) delete a.crew;
  if (a.crewMembers) {
    a.crewMembers = a.crewMembers.map((m) => m.trim());
    while (a.crewMembers.length && !a.crewMembers[a.crewMembers.length - 1]) {
      a.crewMembers.pop(); // trailing blanks only — keep gaps so slots stay put
    }
    if (!a.crewMembers.length) delete a.crewMembers;
  }
  if (!a.colorOverride) delete a.colorOverride;
  if (a.sqftOverride === undefined || a.sqftOverride === null) delete a.sqftOverride;
  if (a.dayOverride === undefined || a.dayOverride === null) delete a.dayOverride;
  if (!a.daysCount || a.daysCount <= 1) delete a.daysCount;
  if (!a.coating) delete a.coating;
  if (!a.baseColor) delete a.baseColor;
  return a;
}

/** "Staged ✓" per crew per week — key is `${className}|${crew}`. */
export type StagedChecks = Record<string, { done: boolean; by: string | null; at: string }>;

export interface ScheduleStore {
  getWeek(weekStart: string): Promise<WeekAssignments>;
  setJob(weekStart: string, jobId: string, assignment: JobAssignment): Promise<JobAssignment>;
  getStagedChecks(weekStart: string): Promise<StagedChecks>;
  setStagedCheck(
    weekStart: string,
    key: string,
    done: boolean,
    by: string | null,
    at: string
  ): Promise<void>;
}

export class JsonScheduleStore implements ScheduleStore {
  private readonly dir: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.resolve(dataDir, "schedule");
  }

  private fileFor(weekStart: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      throw new Error(`Invalid week id: ${weekStart}`);
    }
    return path.join(this.dir, `${weekStart}.json`);
  }

  async getWeek(weekStart: string): Promise<WeekAssignments> {
    try {
      const raw = await fs.readFile(this.fileFor(weekStart), "utf8");
      return JSON.parse(raw) as WeekAssignments;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async setJob(
    weekStart: string,
    jobId: string,
    assignment: JobAssignment
  ): Promise<JobAssignment> {
    const run = async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const week = await this.getWeek(weekStart);
      const next: JobAssignment = { ...week[jobId], ...assignment };
      cleanAssignment(next);
      week[jobId] = next;
      const file = this.fileFor(weekStart);
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(week, null, 2), "utf8");
      await fs.rename(tmp, file);
      return next;
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain as Promise<JobAssignment>;
  }

  private stagedFile(weekStart: string): string {
    return this.fileFor(weekStart).replace(/\.json$/, ".staged.json");
  }
  async getStagedChecks(weekStart: string): Promise<StagedChecks> {
    try {
      return JSON.parse(await fs.readFile(this.stagedFile(weekStart), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }
  async setStagedCheck(
    weekStart: string,
    key: string,
    done: boolean,
    by: string | null,
    at: string
  ): Promise<void> {
    const run = async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const checks = await this.getStagedChecks(weekStart);
      checks[key] = { done, by, at };
      const file = this.stagedFile(weekStart);
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(checks), "utf8");
      await fs.rename(tmp, file);
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }
}

/** In-memory store for tests. */
export class MemoryScheduleStore implements ScheduleStore {
  private weeks = new Map<string, WeekAssignments>();
  async getWeek(weekStart: string): Promise<WeekAssignments> {
    return structuredClone(this.weeks.get(weekStart) ?? {});
  }
  async setJob(weekStart: string, jobId: string, assignment: JobAssignment) {
    const week = this.weeks.get(weekStart) ?? {};
    week[jobId] = cleanAssignment({ ...week[jobId], ...assignment });
    this.weeks.set(weekStart, week);
    return structuredClone(week[jobId]!);
  }
  private staged = new Map<string, StagedChecks>();
  async getStagedChecks(weekStart: string): Promise<StagedChecks> {
    return structuredClone(this.staged.get(weekStart) ?? {});
  }
  async setStagedCheck(
    weekStart: string,
    key: string,
    done: boolean,
    by: string | null,
    at: string
  ): Promise<void> {
    const checks = this.staged.get(weekStart) ?? {};
    checks[key] = { done, by, at };
    this.staged.set(weekStart, checks);
  }
}
