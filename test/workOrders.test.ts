import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isClosedStatus, parseWorkOrders } from "../src/domain/workOrders.js";
import { ScheduleService } from "../src/services/scheduleService.js";
import { MemoryScheduleStore } from "../src/storage/scheduleStore.js";
import { MemoryWorkOrderStore } from "../src/storage/workOrderStore.js";
import type { ProjectProvider } from "../src/builderPrime/provider.js";
import type { CoverageConfig, CustomFieldNames } from "../src/config.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/workOrdersSample.json", import.meta.url)), "utf8")
) as unknown[][];

const rates: CoverageConfig = {
  flake: {
    flakeLbsPerSqft: 0.15,
    flakeBoxLbs: 40,
    polyureaSqftPerGallon: 200,
    polyureaPartsA: 2,
    polyureaPartsB: 1,
    polyasparticSqftPerGallon: 130,
  },
  rubber: { sqftPerBag: 30, sqftPerBinderBucket: 160, sqftPerPrimerBucket: 700 },
};
const fields: CustomFieldNames = {
  sqft: ["SQFT"],
  color: ["Flake Color"],
  projectType: ["Project Type"],
  jobNumber: ["Job Number"],
  crew: ["Crew"],
};
const emptyProvider: ProjectProvider = { isSample: false, listAllProjects: async () => [] };

describe("parseWorkOrders (real export fixture)", () => {
  it("maps WO rows with class cleaning and dates", () => {
    const { workOrders } = parseWorkOrders(fixture);
    expect(workOrders.length).toBeGreaterThan(5);
    const wo = workOrders.find((w) => w.woNumber === "17066")!;
    expect(wo).toBeTruthy();
    expect(wo.client).toBe("Julie Helland");
    expect(wo.className).toBe("Austin"); // cleaned from "Deluxe Garages - Austin, TX"
    expect(wo.type).toBe("Warranty Repair");
    expect(wo.status).toBe("COMPLETE");
    expect(wo.startDate).toBeGreaterThan(0);
  });

  it("throws a helpful error for non-WO files", () => {
    expect(() => parseWorkOrders([["nope"], ["a", "b"]])).toThrow(/WO#/);
  });
});

describe("isClosedStatus", () => {
  it("treats complete/paid as closed, open/scheduled as active", () => {
    expect(isClosedStatus("COMPLETE")).toBe(true);
    expect(isClosedStatus("PAID")).toBe(true);
    expect(isClosedStatus("OPEN")).toBe(false);
    expect(isClosedStatus(null)).toBe(false);
  });
});

describe("work orders on the schedule", () => {
  const now = () => Date.parse("2026-06-30T12:00:00Z"); // week of 2026-06-28

  function makeService(woStore: MemoryWorkOrderStore, store = new MemoryScheduleStore()) {
    return {
      service: new ScheduleService(emptyProvider, store, rates, fields, 0, now, woStore),
      store,
    };
  }

  const openWo = {
    id: "wo-999",
    woNumber: "999",
    client: "Jane Doe",
    address: "1 Main St",
    city: "Austin",
    type: "Warranty Repair",
    startDate: Date.parse("2026-06-29T12:00:00Z"),
    className: "Austin",
    urgency: "NORMAL",
    status: "OPEN",
    createdDate: null,
  };

  it("shows open WOs in their week and computes material once sqft+color set", async () => {
    const woStore = new MemoryWorkOrderStore();
    await woStore.setUploaded([openWo], { uploadedAt: "x", filename: null, sourceLabel: null });
    const { service } = makeService(woStore);

    let sched = await service.getSchedule();
    expect(sched.workOrderCount).toBe(1);
    let job = sched.classes[0]!.jobs[0]!;
    expect(job.isWorkOrder).toBe(true);
    expect(job.jobNumber).toBe("WO 999");
    expect(job.material.flakePounds).toBe(0); // no sqft yet

    // PM fills sqft + color — flake material auto-computes.
    await service.assignJob(undefined, "wo-999", {
      sqftOverride: 200,
      colorOverride: "Claystone",
      baseColor: "Grey",
    });
    sched = await service.getSchedule();
    job = sched.classes[0]!.jobs[0]!;
    expect(job.material.kind).toBe("flake");
    expect(job.material.flakePounds).toBe(30); // 200 * 0.15
    expect(job.material.flake).toBe("Claystone");
    expect(job.baseColor).toBe("Grey");
  });

  it("uses rubber rates when the PM flips the coating", async () => {
    const woStore = new MemoryWorkOrderStore();
    await woStore.setUploaded([openWo], { uploadedAt: "x", filename: null, sourceLabel: null });
    const { service } = makeService(woStore);
    await service.assignJob(undefined, "wo-999", {
      sqftOverride: 300,
      colorOverride: "Sterling",
      coating: "rubber",
    });
    const sched = await service.getSchedule();
    const job = sched.classes[0]!.jobs[0]!;
    expect(job.material.kind).toBe("rubber");
    expect(job.material.rubberBags).toBe(10); // 300/30
  });

  it("stages nothing for closed WOs", async () => {
    const woStore = new MemoryWorkOrderStore();
    await woStore.setUploaded([{ ...openWo, status: "COMPLETE" }], {
      uploadedAt: "x",
      filename: null,
      sourceLabel: null,
    });
    const { service } = makeService(woStore);
    await service.assignJob(undefined, "wo-999", { sqftOverride: 200, colorOverride: "Gray" });
    const sched = await service.getSchedule();
    expect(sched.classes[0]!.jobs[0]!.material.kind).toBe("none");
  });

  it("supports manual WOs, crew slots, day moves, and multi-day", async () => {
    const woStore = new MemoryWorkOrderStore();
    await woStore.addManual({ ...openWo, id: "wo-m1", woNumber: "M-1", manual: true });
    const { service } = makeService(woStore);

    await service.assignJob(undefined, "wo-m1", {
      crewMembers: ["Alice", "Bob", "Carl", "Dan"],
      dayOverride: 3, // Wednesday
      daysCount: 2,
    });
    const sched = await service.getSchedule();
    const job = sched.classes[0]!.jobs[0]!;
    expect(job.crewMembers).toEqual(["Alice", "Bob", "Carl", "Dan"]);
    expect(job.crew).toBe("Alice / Bob / Carl / Dan");
    expect(job.dayIndex).toBe(3);
    expect(job.days).toBe(2);
    expect(job.dayLabel).toBe("Wed–Thu");
  });
});
