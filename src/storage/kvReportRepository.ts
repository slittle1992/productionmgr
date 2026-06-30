import type { StoredReport } from "../domain/weeklyReport.js";
import type { ReportRepository } from "./repository.js";
import type { KvClient } from "./kv/kvClient.js";

/**
 * Durable weekly-report store backed by a KvClient (Redis / Vercel KV).
 * One key per week: `report:<weekStart>`. Quarter and full-list queries
 * enumerate the small set of report keys.
 */
export class KvReportRepository implements ReportRepository {
  private static readonly PREFIX = "report:";

  constructor(private readonly kv: KvClient) {}

  private key(weekStart: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      throw new Error(`Invalid week id: ${weekStart}`);
    }
    return `${KvReportRepository.PREFIX}${weekStart}`;
  }

  async get(weekStart: string): Promise<StoredReport | null> {
    return this.kv.get<StoredReport>(this.key(weekStart));
  }

  async save(report: StoredReport): Promise<void> {
    await this.kv.set(this.key(report.weekStart), report);
  }

  async listAll(): Promise<StoredReport[]> {
    const keys = await this.kv.keys(`${KvReportRepository.PREFIX}*`);
    const reports = await Promise.all(keys.map((k) => this.kv.get<StoredReport>(k)));
    return reports
      .filter((r): r is StoredReport => r !== null)
      .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
  }

  async listByQuarter(quarter: string): Promise<StoredReport[]> {
    return (await this.listAll()).filter((r) => r.quarter === quarter);
  }
}
