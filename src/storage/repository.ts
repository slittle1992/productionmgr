import type { StoredReport } from "../domain/weeklyReport.js";

/**
 * Persistence boundary for weekly reports. A small backing store is recommended
 * by §8.5 so QTD math rolls forward automatically. The JSON implementation is
 * the default; swapping in a real database only means implementing this.
 */
export interface ReportRepository {
  get(weekStart: string): Promise<StoredReport | null>;
  save(report: StoredReport): Promise<void>;
  /** Reports for a quarter (e.g. "2026-Q2"), used for QTD rollups. */
  listByQuarter(quarter: string): Promise<StoredReport[]>;
  /** Most-recent-first list for the history/archive view. */
  listAll(): Promise<StoredReport[]>;
}
