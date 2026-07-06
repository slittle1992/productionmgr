import { promises as fs } from "node:fs";
import path from "node:path";
import type { StoredReport } from "../domain/weeklyReport.js";
import { classSlug, type ReportRepository } from "./repository.js";

/**
 * File-backed report store. Each (week, class) report is one JSON file named
 * `<weekStart>__<class-slug>.json` (e.g. data/reports/2026-07-05__austin.json).
 * Simple, dependency-free, and good enough for a weekly cadence. Writes are
 * serialised through a per-store promise chain to avoid interleaving.
 */
export class JsonReportRepository implements ReportRepository {
  private readonly dir: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.resolve(dataDir, "reports");
  }

  private fileFor(weekStart: string, className: string): string {
    // weekStart is a validated ISO date; guard against path traversal anyway.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      throw new Error(`Invalid week id: ${weekStart}`);
    }
    return path.join(this.dir, `${weekStart}__${classSlug(className)}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private async readFile(file: string): Promise<StoredReport | null> {
    try {
      const raw = await fs.readFile(file, "utf8");
      const report = JSON.parse(raw) as StoredReport;
      report.className ??= "All"; // reports saved before per-class support
      return report;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async get(weekStart: string, className: string): Promise<StoredReport | null> {
    return this.readFile(this.fileFor(weekStart, className));
  }

  async save(report: StoredReport): Promise<void> {
    const run = async () => {
      await this.ensureDir();
      const file = this.fileFor(report.weekStart, report.className);
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(report, null, 2), "utf8");
      await fs.rename(tmp, file); // atomic replace
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }

  async listAll(): Promise<StoredReport[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const reports = await Promise.all(
      names
        .filter((n) => n.endsWith(".json"))
        .map((n) => this.readFile(path.join(this.dir, n)))
    );
    return reports
      .filter((r): r is StoredReport => r !== null)
      .sort(
        (a, b) =>
          (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0) ||
          a.className.localeCompare(b.className)
      );
  }

  async listByQuarter(quarter: string): Promise<StoredReport[]> {
    const all = await this.listAll();
    return all.filter((r) => r.quarter === quarter);
  }
}
