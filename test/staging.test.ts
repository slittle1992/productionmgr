import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { buildStaging, itemLabel, neededByItem } from "../src/domain/staging.js";
import { computeMaterials } from "../src/domain/materials.js";
import type { ScheduleJob, WeeklySchedule } from "../src/services/scheduleService.js";
import { MemoryMeetingStore } from "../src/storage/meetingStore.js";
import { MemoryWorkOrderStore } from "../src/storage/workOrderStore.js";
import { MemoryInventoryStore } from "../src/storage/inventoryStore.js";
import { MemoryPipelineStore } from "../src/storage/pipelineStore.js";
import { MemoryScheduleStore } from "../src/storage/scheduleStore.js";

const config = loadConfig({ ALLOW_SAMPLE_DATA: "false" } as NodeJS.ProcessEnv);

function job(over: Partial<ScheduleJob> & { type?: string; sq?: number; col?: string }): ScheduleJob {
  const sqft = over.sq ?? 1000;
  const type = over.type ?? "Concrete Coating";
  const color = over.col ?? "Domino";
  return {
    id: over.id ?? "j1",
    jobNumber: over.jobNumber ?? "100",
    customer: "Client",
    projectType: type,
    className: over.className ?? "Austin",
    city: "",
    description: null,
    contractValue: 5000,
    sqft,
    color,
    colorRecognized: true,
    baseColor: null,
    crewMembers: [],
    crew: "",
    scheduledDate: null,
    dayIndex: 2,
    days: 1,
    dayLabel: "Tue",
    scheduledDay: "Tuesday",
    material: computeMaterials(sqft, type, { name: color, flakeProduct: color }, config.coverage),
    isWorkOrder: false,
    urgency: null,
    status: null,
    edited: { color: false, sqft: false },
    ...over,
  };
}

function week(jobs: ScheduleJob[]): WeeklySchedule {
  return {
    weekStart: "2026-08-02",
    weekEnd: "2026-08-08",
    usingSampleData: false,
    classes: [{ className: "Austin", jobs }],
    jobCount: jobs.length,
    workOrderCount: 0,
  };
}

describe("staging aggregation", () => {
  it("totals flake material per color and computes coats", () => {
    const staged = buildStaging(
      week([
        job({ id: "a", sq: 1000, col: "Domino" }),
        job({ id: "b", sq: 500, col: "Domino" }),
        job({ id: "c", sq: 300, col: "Tidal Wave" }),
      ])
    );
    const austin = staged.classes[0]!;
    expect(austin.colors).toHaveLength(2);
    const domino = austin.colors.find((c) => c.product === "Domino")!;
    // 1500 sqft × 0.15 = 225 lb = 5.63 boxes of 40 lb.
    expect(domino.flakePounds).toBeCloseTo(225, 1);
    expect(domino.flakeBoxes).toBeCloseTo(5.63, 2);
    // 1800 sqft total: polyurea 9 gal (6 A + 3 B), polyaspartic 13.85 total.
    expect(austin.totals.basecoatAGallons).toBeCloseTo(6, 1);
    expect(austin.totals.basecoatBGallons).toBeCloseTo(3, 1);
    expect(austin.totals.topcoatAGallons).toBeCloseTo(6.92, 1);
    expect(austin.missingInfoCount).toBe(0);
  });

  it("totals rubber separately and flags jobs missing sqft/color", () => {
    const staged = buildStaging(
      week([
        job({ id: "r", type: "Rubber Coating", sq: 600, col: "Black" }),
        job({ id: "m", sq: 0 }), // flake job with no sqft → can't stage
      ])
    );
    const austin = staged.classes[0]!;
    const rubber = austin.colors.find((c) => c.kind === "rubber")!;
    expect(rubber.rubberBags).toBeCloseTo(20, 1); // 600 / 30
    expect(austin.totals.binderBuckets).toBeCloseTo(3.75, 2); // 600 / 160
    expect(austin.missingInfoCount).toBe(1);

    const need = neededByItem(austin);
    expect(need["rubber:black"]).toBeCloseTo(20, 1);
    expect(need["binder"]).toBeCloseTo(3.75, 2);
    expect(itemLabel("rubber:black").label).toBe("Rubber — Black");
  });
});

describe("staging + inventory API", () => {
  const PIPELINE_GRID = [
    ["Production Pipeline Report"],
    ["Date as of 7/30/26"],
    ["Job #", "Description", "Labor Cost", "Material Cost", "Sold Amount", "Start", "Finish", "Project Manager", "Sales Person", "Type", "Class", "Project Sq Ft", "Total Contract Price"],
    ["101", "Garage - Domino", "", "", "5000", "2026-08-04 07:30", "2026-08-04 17:00", "Trailer 1", "Kyle", "Concrete Coating", "Deluxe Garages - Austin, TX", "1000", "5000"],
    ["102", "Patio - Domino", "", "", "3000", "2026-08-05 07:30", "", "", "Kyle", "Concrete Coating", "Deluxe Garages - Austin, TX", "500", "3000"],
  ];

  function makeApp() {
    return buildApp({
      config,
      meetingStore: new MemoryMeetingStore(),
      workOrderStore: new MemoryWorkOrderStore(),
      inventoryStore: new MemoryInventoryStore(),
      pipelineStore: new MemoryPipelineStore(),
      scheduleStore: new MemoryScheduleStore(),
      now: () => Date.parse("2026-07-31T12:00:00Z"),
    }).app;
  }

  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("builds the staging list from an uploaded pipeline", async () => {
    await request(app)
      .post("/api/pipeline")
      .send({ filename: "pipeline.xlsx", rows: PIPELINE_GRID })
      .expect(200);

    const res = await request(app).get("/api/staging?week=2026-08-02");
    expect(res.status).toBe(200);
    expect(res.body.weekStart).toBe("2026-08-02");
    const austin = res.body.classes.find(
      (c: { className: string }) => c.className === "Austin"
    );
    expect(austin.jobs).toHaveLength(2);
    const domino = austin.colors.find((c: { product: string }) => c.product === "Domino");
    expect(domino.sqft).toBe(1500);
    expect(domino.flakePounds).toBeCloseTo(225, 1);
  });

  it("compares inventory on-hand against staged needs", async () => {
    await request(app)
      .post("/api/pipeline")
      .send({ filename: "pipeline.xlsx", rows: PIPELINE_GRID })
      .expect(200);
    await request(app)
      .patch("/api/inventory")
      .send({ className: "Austin", key: "flake:domino", qty: 2, by: "PM" })
      .expect(200);

    const res = await request(app).get("/api/inventory?week=2026-08-02");
    const austin = res.body.classes.find(
      (c: { className: string }) => c.className === "Austin"
    );
    const domino = austin.items.find((i: { key: string }) => i.key === "flake:domino");
    // Need 5.63 boxes, have 2 → short 3.63.
    expect(domino.needed).toBeCloseTo(5.63, 2);
    expect(domino.onHand).toBe(2);
    expect(domino.short).toBeCloseTo(3.63, 2);
    expect(austin.by).toBe("PM");
    // Coats appear as needs with zero on hand.
    const basecoatA = austin.items.find((i: { key: string }) => i.key === "basecoatA");
    expect(basecoatA.short).toBe(basecoatA.needed);
  });
});
