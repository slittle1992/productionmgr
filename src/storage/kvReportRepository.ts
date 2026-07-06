import type { StoredReport } from "../domain/weeklyReport.js";
import { classSlug, type ReportRepository } from "./repository.js";
import type { KvClient } from "./kv/kvClient.js";

/**
 * Durable weekly-report store backed by a KvClient (Redis / Vercel KV).
 * One key per (week, class): `report:<weekStart>:<class-slug>`. Quarter and
 * full-list queries enumerate the small set of report keys.
 */
export class KvReportRepository implements ReportRepository {
  private static readonly PREFIX = "report:";

  constructor(private readonly kv: KvClient) {}

  private key(weekStart: string, className: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      throw new Error(`Invalid week id: ${weekStart}`);
    }
    return `${KvReportRepository.PREFIX}${weekStart}:${classSlug(className)}`;
  }

  async get(weekStart: string, className: string): Promise<StoredReport | null> {
    const report = await this.kv.get<StoredReport>(this.key(weekStart, className));
    if (report) report.className ??= "All"; // pre-per-class reports
    return report;
  }

  async save(report: StoredReport): Promise<void> {
    await this.kv.set(this.key(report.weekStart, report.className), report);
  }

  async listAll(): Promise<StoredReport[]> {
    const keys = await this.kv.keys(`${KvReportRepository.PREFIX}*`);
    const reports = await Promise.all(keys.map((k) => this.kv.get<StoredReport>(k)));
    return reports
      .filter((r): r is StoredReport => r !== null)
      .map((r) => ({ ...r, className: r.className ?? "All" }))
      .sort(
        (a, b) =>
          (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0) ||
          a.className.localeCompare(b.className)
      );
  }

  async listByQuarter(quarter: string): Promise<StoredReport[]> {
    return (await this.listAll()).filter((r) => r.quarter === quarter);
  }
}
