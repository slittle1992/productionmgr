import type { StoredReport } from "../domain/weeklyReport.js";

/**
 * Persistence boundary for weekly reports. Reports are keyed by
 * (weekStart, className) — each class (e.g. Austin, Dallas) submits its own
 * weekly report, and QTD rollups run within a class. "All" is the
 * company-wide report. A small backing store is recommended by §8.5 so QTD
 * math rolls forward automatically.
 */
export interface ReportRepository {
  get(weekStart: string, className: string): Promise<StoredReport | null>;
  save(report: StoredReport): Promise<void>;
  /** Reports for a quarter (e.g. "2026-Q2") across all classes. */
  listByQuarter(quarter: string): Promise<StoredReport[]>;
  /** Most-recent-first list for the history/archive view. */
  listAll(): Promise<StoredReport[]>;
}

/** Filesystem/key-safe slug for a class name ("San Antonio" → "san-antonio"). */
export function classSlug(className: string): string {
  const slug = className
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "all";
}
