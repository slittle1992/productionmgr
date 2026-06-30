import { describe, expect, it } from "vitest";
import { MemoryKvClient } from "../src/storage/kv/kvClient.js";
import { KvReportRepository } from "../src/storage/kvReportRepository.js";
import { KvScheduleStore } from "../src/storage/kvScheduleStore.js";
import { ReportService } from "../src/services/reportService.js";
import { ProjectsService } from "../src/services/projectsService.js";
import { ScheduleService } from "../src/services/scheduleService.js";
import type { ProjectProvider } from "../src/builderPrime/provider.js";
import type { StoredReport } from "../src/domain/weeklyReport.js";
import { emptyAutoFields, emptyManualFields } from "../src/domain/weeklyReport.js";
import type { CoverageRates, CustomFieldNames } from "../src/config.js";
import type { BuilderPrimeProject } from "../src/builderPrime/types.js";

function storedReport(weekStart: string, quarter: string): StoredReport {
  return {
    weekStart,
    weekEnd: weekStart,
    quarter,
    status: "submitted",
    autoSource: emptyAutoFields(),
    overrides: {},
    manual: { ...emptyManualFields(), warrantiesOpenedThisWeek: 1, leadsThisWeek: 2 },
    updatedAt: "2026-06-30T00:00:00.000Z",
    submittedAt: "2026-06-30T00:00:00.000Z",
    usingSampleData: false,
  };
}

describe("KvReportRepository", () => {
  it("saves, gets, and lists reports by quarter", async () => {
    const repo = new KvReportRepository(new MemoryKvClient());
    await repo.save(storedReport("2026-06-28", "2026-Q2"));
    await repo.save(storedReport("2026-03-29", "2026-Q1"));

    expect((await repo.get("2026-06-28"))?.quarter).toBe("2026-Q2");
    expect(await repo.get("2026-01-04")).toBeNull();

    const q2 = await repo.listByQuarter("2026-Q2");
    expect(q2.map((r) => r.weekStart)).toEqual(["2026-06-28"]);
    expect((await repo.listAll()).length).toBe(2);
  });

  it("rejects an invalid week id", async () => {
    const repo = new KvReportRepository(new MemoryKvClient());
    await expect(repo.get("not-a-date")).rejects.toThrow();
  });
});

describe("KvScheduleStore", () => {
  it("sets and merges per-job assignments without clobbering", async () => {
    const store = new KvScheduleStore(new MemoryKvClient());
    await store.setJob("2026-06-28", "100", { crew: "Thomas" });
    await store.setJob("2026-06-28", "100", { colorOverride: "Domino" });
    await store.setJob("2026-06-28", "200", { sqftOverride: 400 });

    const week = await store.getWeek("2026-06-28");
    expect(week["100"]).toEqual({ crew: "Thomas", colorOverride: "Domino" });
    expect(week["200"]).toEqual({ sqftOverride: 400 });
  });

  it("clears an emptied crew value", async () => {
    const store = new KvScheduleStore(new MemoryKvClient());
    await store.setJob("2026-06-28", "100", { crew: "Thomas" });
    await store.setJob("2026-06-28", "100", { crew: "" });
    const week = await store.getWeek("2026-06-28");
    expect(week["100"]?.crew).toBeUndefined();
  });
});

describe("services on KV storage", () => {
  const now = () => Date.parse("2026-06-30T12:00:00Z");

  it("rolls QTD forward through the KV report repository", async () => {
    const repo = new KvReportRepository(new MemoryKvClient());
    const provider: ProjectProvider = { isSample: false, listAllProjects: async () => [] };
    const projects = new ProjectsService(provider, null);
    const service = new ReportService(projects, repo, 1.2, 0, now);

    await service.saveReport(
      "2026-06-21",
      { overrides: {}, manual: { ...emptyManualFields(), warrantiesOpenedThisWeek: 3 } },
      true
    );
    const current = await service.saveReport(
      "2026-06-28",
      { overrides: {}, manual: { ...emptyManualFields(), warrantiesOpenedThisWeek: 2 } },
      false
    );
    expect(current.derived.totalWarrantiesQTD).toBe(5);
  });

  it("persists schedule crew via the KV schedule store", async () => {
    const rates: CoverageRates = {
      basecoatADivisor: 315,
      basecoatBDivisor: 630,
      topcoatADivisor: 330,
      topcoatBDivisor: 330,
      flakeLbsPerSqft: 0.125,
    };
    const fields: CustomFieldNames = {
      sqft: ["SQFT"],
      color: ["Flake Color"],
      projectType: ["Project Type"],
      jobNumber: ["Job Number"],
    };
    const job: BuilderPrimeProject = {
      jobNumber: 100,
      className: "Austin",
      estimatedStartDate: Date.parse("2026-06-29T12:00:00Z"),
      clientFirstName: "Dana",
      clientLastName: "Reyes",
      customFields: { SQFT: 630, "Flake Color": "Wombat", "Project Type": "Flake" },
    };
    const provider: ProjectProvider = { isSample: false, listAllProjects: async () => [job] };
    const store = new KvScheduleStore(new MemoryKvClient());
    const service = new ScheduleService(provider, store, rates, fields, 0, now);

    await service.assignJob(undefined, "100", { crew: "Thomas/Jovannie" });
    const sched = await service.getSchedule();
    expect(sched.classes[0]!.jobs[0]!.crew).toBe("Thomas/Jovannie");
  });
});
