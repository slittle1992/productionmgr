import { beforeEach, describe, expect, it } from "vitest";
import { ReportService } from "../src/services/reportService.js";
import { ProjectsService } from "../src/services/projectsService.js";
import type { ProjectProvider } from "../src/builderPrime/provider.js";
import type { BuilderPrimeProject } from "../src/builderPrime/types.js";
import type { StoredReport } from "../src/domain/weeklyReport.js";
import type { ReportRepository } from "../src/storage/repository.js";
import { emptyManualFields } from "../src/domain/weeklyReport.js";

class MemoryRepo implements ReportRepository {
  private store = new Map<string, StoredReport>();
  async get(weekStart: string) {
    return this.store.get(weekStart) ?? null;
  }
  async save(r: StoredReport) {
    this.store.set(r.weekStart, structuredClone(r));
  }
  async listAll() {
    return [...this.store.values()].sort((a, b) =>
      a.weekStart < b.weekStart ? 1 : -1
    );
  }
  async listByQuarter(q: string) {
    return (await this.listAll()).filter((r) => r.quarter === q);
  }
}

function providerWith(projects: BuilderPrimeProject[]): ProjectProvider {
  return { isSample: false, listAllProjects: async () => projects };
}

const inWeek = (weekStart: string) =>
  Date.parse(`${weekStart}T12:00:00Z`) + 2 * 24 * 3600 * 1000;

function makeService(projects: BuilderPrimeProject[], repo: ReportRepository) {
  const projectsService = new ProjectsService(providerWith(projects), null);
  // Fixed clock inside the week of 2026-06-28.
  const now = () => Date.parse("2026-06-30T12:00:00Z");
  return new ReportService(projectsService, repo, 1.2, 0, now);
}

describe("ReportService", () => {
  let repo: MemoryRepo;
  beforeEach(() => {
    repo = new MemoryRepo();
  });

  it("pre-fills auto fields from Builder Prime on open", async () => {
    const service = makeService(
      [
        { estimatedValue: 4000, laborCost: 1000, estimatedStartDate: inWeek("2026-06-28") },
        {
          estimatedValue: 9000,
          projectStatusIsComplete: true,
          completionDateTime: inWeek("2026-06-28"),
        },
      ],
      repo
    );
    const report = await service.getReport();
    expect(report.weekStart).toBe("2026-06-28");
    expect(report.auto.projectedJobSchedule).toBe(4000);
    expect(report.auto.projectedLabor).toBe(1000);
    expect(report.auto.completedJobsRevenue).toBe(9000);
    expect(report.status).toBe("draft");
  });

  it("saves manual entries and recomputes derived fields", async () => {
    const service = makeService([], repo);
    const report = await service.saveReport(
      undefined,
      {
        overrides: { completedJobsRevenue: 10000 },
        manual: { ...emptyManualFields(), actualLaborRaw: 2000, totalSundriesCost: 2000 },
      },
      false
    );
    expect(report.derived.actualLabor).toBe(2400); // 2000 * 1.2
    expect(report.derived.installedRevenue).toBe(10000);
    expect(report.derived.sundriesRatio).toBe(0.2);
    expect(report.status).toBe("draft");
  });

  it("persists overrides and manual values across reloads", async () => {
    const service = makeService(
      [{ estimatedValue: 4000, estimatedStartDate: inWeek("2026-06-28") }],
      repo
    );
    await service.saveReport(
      undefined,
      {
        overrides: { projectedJobSchedule: 12345 },
        manual: { ...emptyManualFields(), leadsThisWeek: 7 },
      },
      false
    );
    const reloaded = await service.getReport();
    expect(reloaded.auto.projectedJobSchedule).toBe(12345); // override wins
    expect(reloaded.autoSource.projectedJobSchedule).toBe(4000); // source still 4000
    expect(reloaded.manual.leadsThisWeek).toBe(7);
  });

  it("marks a submitted report and freezes its Builder Prime snapshot", async () => {
    const projects: BuilderPrimeProject[] = [
      { estimatedValue: 4000, estimatedStartDate: inWeek("2026-06-28") },
    ];
    const projectsService = new ProjectsService(
      { isSample: false, listAllProjects: async () => projects },
      null
    );
    const now = () => Date.parse("2026-06-30T12:00:00Z");
    const service = new ReportService(projectsService, repo, 1.2, 0, now);

    const submitted = await service.saveReport(
      undefined,
      { overrides: {}, manual: emptyManualFields() },
      true
    );
    expect(submitted.status).toBe("submitted");
    expect(submitted.submittedAt).not.toBeNull();

    // Even if projects change, a submitted report keeps its snapshot value.
    projects[0]!.estimatedValue = 99999;
    const reloaded = await service.getReport();
    expect(reloaded.autoSource.projectedJobSchedule).toBe(4000);
  });

  it("rolls warranties + leads forward to QTD from prior weeks", async () => {
    const service = makeService([], repo);

    // Two prior weeks in the same quarter, then the current week.
    await service.saveReport(
      "2026-06-14",
      { overrides: {}, manual: { ...emptyManualFields(), warrantiesOpenedThisWeek: 2, leadsThisWeek: 4 } },
      true
    );
    await service.saveReport(
      "2026-06-21",
      { overrides: {}, manual: { ...emptyManualFields(), warrantiesOpenedThisWeek: 1, leadsThisWeek: 3 } },
      true
    );
    const current = await service.saveReport(
      "2026-06-28",
      { overrides: {}, manual: { ...emptyManualFields(), warrantiesOpenedThisWeek: 5, leadsThisWeek: 10 } },
      false
    );
    expect(current.derived.totalWarrantiesQTD).toBe(8); // 2 + 1 + 5
    expect(current.derived.totalLeadsQTD).toBe(17); // 4 + 3 + 10
  });
});
