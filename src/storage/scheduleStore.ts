import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Per-job edits the manager makes on the schedule: crew assignment (which isn't
 * in Builder Prime) plus optional corrections to the auto-pulled color or sqft.
 * Stored one JSON file per week so the weekly schedule is reproducible.
 */
export interface JobAssignment {
  crew?: string;
  colorOverride?: string;
  sqftOverride?: number;
}

export type WeekAssignments = Record<string, JobAssignment>;

export interface ScheduleStore {
  getWeek(weekStart: string): Promise<WeekAssignments>;
  setJob(weekStart: string, jobId: string, assignment: JobAssignment): Promise<JobAssignment>;
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
      // Drop empty values so the file stays clean.
      if (!next.crew) delete next.crew;
      if (!next.colorOverride) delete next.colorOverride;
      if (next.sqftOverride === undefined || next.sqftOverride === null)
        delete next.sqftOverride;
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
}

/** In-memory store for tests. */
export class MemoryScheduleStore implements ScheduleStore {
  private weeks = new Map<string, WeekAssignments>();
  async getWeek(weekStart: string): Promise<WeekAssignments> {
    return structuredClone(this.weeks.get(weekStart) ?? {});
  }
  async setJob(weekStart: string, jobId: string, assignment: JobAssignment) {
    const week = this.weeks.get(weekStart) ?? {};
    week[jobId] = { ...week[jobId], ...assignment };
    this.weeks.set(weekStart, week);
    return structuredClone(week[jobId]!);
  }
}
