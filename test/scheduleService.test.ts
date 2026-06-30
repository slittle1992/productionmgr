import { beforeEach, describe, expect, it } from "vitest";
import { ScheduleService } from "../src/services/scheduleService.js";
import { MemoryScheduleStore } from "../src/storage/scheduleStore.js";
import type { ProjectProvider } from "../src/builderPrime/provider.js";
import type { BuilderPrimeProject } from "../src/builderPrime/types.js";
import type { CoverageRates, CustomFieldNames } from "../src/config.js";

const rates: CoverageRates = {
  basecoatADivisor: 315,
  basecoatBDivisor: 630,
  topcoatADivisor: 330,
  topcoatBDivisor: 330,
  flakeLbsPerSqft: 0.125,
};
const fields: CustomFieldNames = {
  sqft: ["SQFT", "Square Footage"],
  color: ["Flake Color", "Color"],
  projectType: ["Project Type", "Job Type"],
  jobNumber: ["Job Number"],
  crew: ["Crew"],
};

const now = () => Date.parse("2026-06-30T12:00:00Z"); // week of 2026-06-28
const inWeek = Date.parse("2026-06-29T12:00:00Z");
const outWeek = Date.parse("2026-07-20T12:00:00Z");

function provider(projects: BuilderPrimeProject[]): ProjectProvider {
  return { isSample: false, listAllProjects: async () => projects };
}

function makeService(projects: BuilderPrimeProject[], store = new MemoryScheduleStore()) {
  return {
    service: new ScheduleService(provider(projects), store, rates, fields, 0, now),
    store,
  };
}

describe("ScheduleService", () => {
  let projects: BuilderPrimeProject[];
  beforeEach(() => {
    projects = [
      {
        projectId: 1,
        jobNumber: 100,
        className: "Austin",
        estimatedStartDate: inWeek,
        clientFirstName: "Dana",
        clientLastName: "Reyes",
        customFields: { SQFT: 630, "Flake Color": "Caspain", "Project Type": "Flake" },
      },
      {
        projectId: 2,
        jobNumber: 200,
        className: "Dallas",
        estimatedStartDate: inWeek,
        clientCompanyName: "Acme",
        customFields: { "Square Footage": 400, Color: "Wombat", "Job Type": "Rubber" },
      },
      {
        projectId: 3,
        jobNumber: 300,
        className: "Austin",
        estimatedStartDate: outWeek, // excluded — not this week
        customFields: { SQFT: 999, "Flake Color": "Gray", "Project Type": "Flake" },
      },
    ];
  });

  it("groups this-week jobs by class and excludes out-of-week jobs", async () => {
    const { service } = makeService(projects);
    const sched = await service.getSchedule();
    expect(sched.weekStart).toBe("2026-06-28");
    expect(sched.jobCount).toBe(2);
    expect(sched.classes.map((c) => c.className)).toEqual(["Austin", "Dallas"]);
  });

  it("reads custom fields and normalises the color", async () => {
    const { service } = makeService(projects);
    const sched = await service.getSchedule();
    const austin = sched.classes.find((c) => c.className === "Austin")!.jobs[0]!;
    expect(austin.jobNumber).toBe("100");
    expect(austin.sqft).toBe(630);
    expect(austin.color).toBe("Caspian"); // typo fixed
    expect(austin.colorRecognized).toBe(true);
    expect(austin.projectType).toBe("Flake");
  });

  it("computes material from sqft", async () => {
    const { service } = makeService(projects);
    const sched = await service.getSchedule();
    const austin = sched.classes.find((c) => c.className === "Austin")!.jobs[0]!;
    expect(austin.material.basecoatAGallons).toBe(2); // 630/315
    expect(austin.material.flakePounds).toBe(78.75); // 630 * 0.125
  });

  it("persists a crew assignment and reflects it on reload", async () => {
    const { service } = makeService(projects);
    await service.assignJob(undefined, "100", { crew: "Thomas/Jovannie" });
    const sched = await service.getSchedule();
    const austin = sched.classes.find((c) => c.className === "Austin")!.jobs[0]!;
    expect(austin.crew).toBe("Thomas/Jovannie");
  });

  it("applies a color override and recomputes the flake", async () => {
    const { service } = makeService(projects);
    await service.assignJob(undefined, "200", { colorOverride: "Domino" });
    const sched = await service.getSchedule();
    const dallas = sched.classes.find((c) => c.className === "Dallas")!.jobs[0]!;
    expect(dallas.color).toBe("Domino");
    expect(dallas.edited.color).toBe(true);
  });

  it("applies a sqft override and recomputes material", async () => {
    const { service } = makeService(projects);
    await service.assignJob(undefined, "200", { sqftOverride: 315 });
    const sched = await service.getSchedule();
    const dallas = sched.classes.find((c) => c.className === "Dallas")!.jobs[0]!;
    expect(dallas.sqft).toBe(315);
    expect(dallas.material.basecoatAGallons).toBe(1);
  });
});
