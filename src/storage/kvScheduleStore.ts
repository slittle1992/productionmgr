import {
  cleanAssignment,
  type JobAssignment,
  type ScheduleStore,
  type StagedChecks,
  type WeekAssignments,
} from "./scheduleStore.js";
import type { KvClient } from "./kv/kvClient.js";

/**
 * Durable schedule-assignment store backed by a KvClient (Redis / Vercel KV).
 * Each week is a Redis hash `schedule:<weekStart>` whose fields are job ids.
 * Using a hash means setting one job's crew/color/sqft is an atomic per-field
 * write — no read-modify-write race across concurrent serverless invocations.
 */
export class KvScheduleStore implements ScheduleStore {
  constructor(private readonly kv: KvClient) {}

  private key(weekStart: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      throw new Error(`Invalid week id: ${weekStart}`);
    }
    return `schedule:${weekStart}`;
  }

  async getWeek(weekStart: string): Promise<WeekAssignments> {
    return this.kv.hgetall<JobAssignment>(this.key(weekStart));
  }

  async setJob(
    weekStart: string,
    jobId: string,
    assignment: JobAssignment
  ): Promise<JobAssignment> {
    const key = this.key(weekStart);
    const existing = (await this.kv.hgetall<JobAssignment>(key))[jobId] ?? {};
    const next = cleanAssignment({ ...existing, ...assignment });

    await this.kv.hset(key, jobId, next);
    return next;
  }

  async getStagedChecks(weekStart: string): Promise<StagedChecks> {
    return this.kv.hgetall<StagedChecks[string]>(`${this.key(weekStart)}:staged`);
  }
  async setStagedCheck(
    weekStart: string,
    key: string,
    done: boolean,
    by: string | null,
    at: string
  ): Promise<void> {
    await this.kv.hset(`${this.key(weekStart)}:staged`, key, { done, by, at });
  }
}
