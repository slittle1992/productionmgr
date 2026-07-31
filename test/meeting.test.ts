import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { parseUnpaidInvoices, syncFollowUps, type FollowUp } from "../src/domain/pastDue.js";
import { parseCompletedProjects } from "../src/domain/completedProjects.js";
import { summarisePayrollWorkbook } from "../src/domain/payroll.js";
import {
  buildLaborRates,
  buildPipelineChecks,
  buildWorkOrderReview,
  laborRate,
} from "../src/domain/meeting.js";
import { getReportingWeekFromStart } from "../src/domain/week.js";
import type { WorkOrder } from "../src/domain/workOrders.js";
import { MemoryMeetingStore } from "../src/storage/meetingStore.js";
import { MemoryWorkOrderStore } from "../src/storage/workOrderStore.js";
import type { BuilderPrimeProject } from "../src/builderPrime/types.js";

// Meeting week used throughout: Sun 2026-07-26 … Sat 2026-08-01.
const WEEK = "2026-07-26";
const NOW = Date.parse("2026-07-31T12:00:00Z");

const UNPAID_GRID = [
  ["unpaid-invoices-20260730"],
  ["Date as of 7/30/26 @ 11:19 pm"],
  ["Client", "Inv #", "Project Name", "Project Status", "Amount", "Balance", "Class", "Due Date", "Age"],
  ["Wayne Nowotny", "188439", "[#201865] Pool deck", "No Installation Date", "$20,240.15", "$20,240.15", "Deluxe Garages - Corpus Christi, TX", "2026-07-27", "3"],
  ["Crosby Peck", "155611", "Pool deck", "Project Scheduled", "$19,925.00", "$9,925.00", "Deluxe Garages - Austin, TX", "2026-08-01", ""],
];

describe("unpaid invoices parsing + follow-up sync", () => {
  it("parses the export and cleans class names", () => {
    const { invoices, sourceLabel } = parseUnpaidInvoices(UNPAID_GRID);
    expect(invoices).toHaveLength(2);
    expect(invoices[0]).toMatchObject({
      invoiceNumber: "188439",
      client: "Wayne Nowotny",
      balance: 20240.15,
      className: "Corpus Christi",
    });
    expect(sourceLabel).toContain("as of");
  });

  it("keeps reasons/owners across uploads and flags missing invoices", () => {
    const { invoices } = parseUnpaidInvoices(UNPAID_GRID);
    const nowIso = new Date(NOW).toISOString();
    const first = syncFollowUps({}, invoices, "2026-07-19", nowIso);
    expect(first.newCount).toBe(2);

    // The meeting fills in reason + owner.
    first.followUps["188439"]!.reason = "Waiting on financing";
    first.followUps["188439"]!.owner = "Jessica";

    // Next week's export no longer contains invoice 155611 (it got paid).
    const second = syncFollowUps(
      first.followUps,
      invoices.filter((i) => i.invoiceNumber === "188439"),
      WEEK,
      nowIso
    );
    expect(second.newCount).toBe(0);
    expect(second.missingCount).toBe(1);
    expect(second.followUps["188439"]!.reason).toBe("Waiting on financing");
    expect(second.followUps["188439"]!.firstSeenWeek).toBe("2026-07-19");
    expect(second.followUps["155611"]!.inLatestExport).toBe(false);
  });

  it("re-opens a resolved follow-up that shows up unpaid again", () => {
    const { invoices } = parseUnpaidInvoices(UNPAID_GRID);
    const nowIso = new Date(NOW).toISOString();
    const first = syncFollowUps({}, invoices, "2026-07-19", nowIso);
    const fu = first.followUps["188439"]!;
    fu.status = "resolved";
    fu.resolvedWeek = "2026-07-19";

    const second = syncFollowUps(first.followUps, invoices, WEEK, nowIso);
    expect(second.followUps["188439"]!.status).toBe("open");
    expect(second.followUps["188439"]!.updates.at(-1)!.note).toMatch(/re-opened/i);
  });
});

const COMPLETED_GRID = [
  ["Completed Projects Report"],
  ["Date as of 7/30/26"],
  ["Completed", "Client", "Job #", "Sold Amount", "Paid Amount", "Class", "Type", "Foreman", "Total Contract Price"],
  ["2026-07-28 12:00", "Mark Tatum", "224930", "$8,000.00", "$8,000.00", "Deluxe Garages - Dallas, TX", "Rubber Coating", "Dan Lead", "8000"],
  ["2026-07-29 12:00", "Glen Klee", "227478", "$17,139.20", "$17,139.20", "Deluxe Garages - Dallas, TX", "Concrete Coating", "", "17139.20"],
  ["2026-07-10 12:00", "Old Job", "111111", "$5,000.00", "$5,000.00", "Deluxe Garages - Austin, TX", "Concrete Coating", "", "5000"],
];

describe("labor rates", () => {
  it("computes revenue ÷ (payroll × 1.2) per location for the week", () => {
    const { jobs } = parseCompletedProjects(COMPLETED_GRID);
    expect(jobs).toHaveLength(3);
    const week = getReportingWeekFromStart(WEEK);
    const rows = buildLaborRates(
      jobs,
      week,
      { Dallas: { productionPayroll: 10000, revenueOverride: null, sheetName: null, by: null } },
      1.2
    );
    // Only the two Dallas jobs completed inside the week count.
    expect(rows).toHaveLength(1);
    const dallas = rows[0]!;
    expect(dallas.className).toBe("Dallas");
    expect(dallas.completedRevenue).toBeCloseTo(25139.2, 1);
    expect(dallas.rate).toBeCloseTo(25139.2 / (10000 * 1.2), 4);
  });

  it("labor rate is null until payroll is entered", () => {
    expect(laborRate(1000, null, 1.2)).toBeNull();
    expect(laborRate(1000, 0, 1.2)).toBeNull();
    expect(laborRate(12000, 10000, 1.2)).toBeCloseTo(1, 5);
  });
});

describe("payroll workbook parsing", () => {
  it("sums the Production department per sheet and prefers the matching week", () => {
    const sheet = (name: string, start: string, end: string, pay: number) => ({
      name,
      rows: [
        ["", "x", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Pay period start date:", start],
        ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Pay period end date:", end],
        ["", "Department", "Last Name", "First Name", "Salary", "Pay Rate", "Regular Hours", "OT Hours", "PTO Hours", "Holiday Hours", "Monthly Bonus", "Commission", "Contract labor", "Total Gross Pay"],
        ["", "Sales", "Butler", "Haleigh", 375, "", "", "", "", "", "", 0, "", 375],
        ["", "Production", "Smith", "Alan", "", 24, 40, 0, "", "", "", "", "", pay / 2],
        ["", "Production", "Jones", "Bo", "", 22, 40, 0, "", "", "", "", "", pay / 2],
      ],
    });
    const sheets = summarisePayrollWorkbook(
      [
        { name: "Instructions", rows: [["Read me"]] },
        sheet("712-718", "2026-07-12", "2026-07-18", 15000),
        sheet("726-81", "2026-07-26", "2026-08-01", 17400.85),
      ],
      WEEK,
      "2026-08-01"
    );
    expect(sheets).toHaveLength(2);
    expect(sheets[0]!.sheetName).toBe("726-81");
    expect(sheets[0]!.productionTotal).toBeCloseTo(17400.85, 2);
    expect(sheets[0]!.employeeCount).toBe(2);
    expect(sheets[0]!.periodStart).toBe("2026-07-26");
  });
});

describe("work-order review", () => {
  const wo = (over: Partial<WorkOrder>): WorkOrder => ({
    id: `wo-${over.woNumber}`,
    woNumber: "1",
    client: "C",
    address: null,
    city: null,
    type: "Warranty Repair",
    startDate: null,
    className: "Austin",
    urgency: null,
    status: "SCHEDULED",
    createdDate: NOW,
    ...over,
  });

  it("splits open/completed and rolls warranties up by tagged lead", () => {
    const review = buildWorkOrderReview(
      [
        wo({ woNumber: "1", type: "Warranty Repair", status: "SCHEDULED" }),
        wo({ woNumber: "2", type: "Craftsmanship Call Back", status: "COMPLETE" }),
        wo({ woNumber: "3", type: "Inspection", status: "SCHEDULED" }),
        wo({ woNumber: "4", type: "Full Redo", status: "UNSCHEDULED", className: "Dallas" }),
      ],
      {
        "wo-1": { woId: "wo-1", lead: "Dan", cause: "Edges lifted", by: null, at: "" },
        "wo-4": { woId: "wo-4", lead: "Dan", cause: "Bad prep", by: null, at: "" },
      }
    );
    expect(review.totalOpen).toBe(3);
    expect(review.totalCompleted).toBe(1);
    // Inspection is not a warranty type.
    expect(review.warranties).toHaveLength(3);
    expect(review.byLead).toEqual([
      { lead: "Dan", count: 2, causes: ["Edges lifted", "Bad prep"] },
    ]);
    expect(review.untaggedWarranties).toBe(1);
    const austin = review.classes.find((c) => c.className === "Austin")!;
    expect(austin.open).toBe(2);
    expect(austin.openWarranties).toBe(1);
  });
});

describe("pipeline checks", () => {
  const project = (over: Partial<BuilderPrimeProject>): BuilderPrimeProject => ({
    projectId: "p",
    jobNumber: "100",
    className: "Austin",
    estimatedValue: 5000,
    customFields: {},
    ...over,
  });

  it("flags missing start dates, missing crews, and day load", () => {
    const week = getReportingWeekFromStart(WEEK);
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const checks = buildPipelineChecks(
      [
        project({ jobNumber: "1" }), // no start date
        project({
          jobNumber: "2",
          estimatedStartDate: Date.parse("2026-07-28T12:00:00Z"),
        }), // this week, no crew
        project({
          jobNumber: "3",
          estimatedStartDate: Date.parse("2026-07-28T12:00:00Z"),
          customFields: { Crew: "Trailer 1" },
          estimatedValue: 9000,
        }),
        project({
          jobNumber: "4",
          estimatedStartDate: Date.parse("2026-09-10T12:00:00Z"),
        }), // future, no crew
      ],
      week,
      config.customFields
    );
    expect(checks.noStartDate.map((j) => j.jobNumber)).toEqual(["1"]);
    expect(checks.noCrew.map((j) => j.jobNumber)).toEqual(["2", "4"]);
    expect(checks.noCrew[0]!.thisWeek).toBe(true);

    const austin = checks.week.find((w) => w.className === "Austin")!;
    expect(austin.jobsThisWeek).toBe(2);
    expect(austin.totalThisWeek).toBe(14000);
    const tue = austin.days.find((d) => d.date === "2026-07-28")!;
    expect(tue.jobs).toBe(2);
    const wed = austin.days.find((d) => d.date === "2026-07-29")!;
    expect(wed.load).toBe("empty");
    // Sunday is not a working day.
    expect(austin.days.some((d) => d.date === "2026-07-26")).toBe(false);
  });
});

describe("meeting API", () => {
  function makeApp() {
    const config = loadConfig({ ALLOW_SAMPLE_DATA: "false" } as NodeJS.ProcessEnv);
    const now = () => NOW;
    return buildApp({
      config,
      meetingStore: new MemoryMeetingStore(),
      workOrderStore: new MemoryWorkOrderStore(),
      now,
    }).app;
  }

  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("runs the past-due flow: upload → reason/owner → carryover next week", async () => {
    const up = await request(app)
      .post("/api/meeting/pastdue")
      .send({ filename: "unpaid.xlsx", week: WEEK, rows: UNPAID_GRID });
    expect(up.status).toBe(200);
    expect(up.body.count).toBe(2);
    expect(up.body.newCount).toBe(2);

    const patch = await request(app)
      .patch("/api/meeting/followups/188439")
      .send({
        week: WEEK,
        reason: "No install date yet",
        owner: "Jessica",
        ownerEmail: "jessica@deluxegarages.com",
        actionDate: "2026-08-05",
      });
    expect(patch.status).toBe(200);
    expect(patch.body.followUp.owner).toBe("Jessica");

    const view = await request(app).get(`/api/meeting?week=${WEEK}`);
    expect(view.status).toBe(200);
    expect(view.body.pastDue.openCount).toBe(2);
    expect(view.body.pastDue.needsInfoCount).toBe(1); // 155611 still blank
    const corpus = view.body.pastDue.classes.find(
      (c: { className: string }) => c.className === "Corpus Christi"
    );
    expect(corpus.items[0].actionDate).toBe("2026-08-05");

    // Next week the item carries over and demands an update.
    const nextWeek = await request(app).get("/api/meeting?week=2026-08-02");
    const carried = nextWeek.body.pastDue.classes
      .flatMap((c: { items: FollowUp[] }) => c.items)
      .find((i: { invoiceNumber: string }) => i.invoiceNumber === "188439");
    expect(carried.carriedOver).toBe(true);
    expect(carried.updatedThisWeek).toBe(false);

    const note = await request(app)
      .patch("/api/meeting/followups/188439")
      .send({ week: "2026-08-02", note: "Install booked for Tuesday", by: "Jessica" });
    expect(note.status).toBe(200);
    expect(note.body.followUp.updates).toHaveLength(1);
  });

  it("tracks dashboard checks and manual sign-offs into progress", async () => {
    await request(app)
      .patch("/api/meeting/check")
      .send({ week: WEEK, key: "lytx", status: "done", notes: "2 events", by: "Spencer" })
      .expect(200);
    await request(app)
      .patch("/api/meeting/section")
      .send({ week: WEEK, key: "pipeline", done: true, by: "Spencer" })
      .expect(200);

    const view = await request(app).get(`/api/meeting?week=${WEEK}`);
    expect(view.body.checks.lytx.status).toBe("done");
    expect(view.body.checks.lytx.by).toBe("Spencer");
    const sections = Object.fromEntries(
      view.body.sections.map((s: { key: string; done: boolean }) => [s.key, s.done])
    );
    expect(sections.lytx).toBe(true);
    expect(sections.pipeline).toBe(true);
    expect(view.body.doneCount).toBe(2);
  });

  it("computes labor rates for the PREVIOUS week from the completed upload", async () => {
    // Meeting the week after the jobs completed: labor rates look back one week.
    const meetingWeek = "2026-08-02";
    await request(app)
      .post("/api/meeting/completed")
      .send({ filename: "completed.xlsx", rows: COMPLETED_GRID })
      .expect(200);
    await request(app)
      .patch("/api/meeting/labor")
      .send({ week: meetingWeek, className: "Dallas", productionPayroll: 10000, by: "PM" })
      .expect(200);

    const view = await request(app).get(`/api/meeting?week=${meetingWeek}`);
    expect(view.body.labor.weekStart).toBe(WEEK); // covers 7/26–8/1
    const dallas = view.body.labor.rows.find(
      (r: { className: string }) => r.className === "Dallas"
    );
    expect(dallas.completedRevenue).toBeCloseTo(25139.2, 1);
    expect(dallas.rate).toBeCloseTo(25139.2 / 12000, 3);
  });

  it("tags warranty work orders with lead + cause", async () => {
    const WO_GRID = [
      ["Export data"],
      ["Date as of 7/30/26"],
      ["WO#", "Client", "Address", "City", "Type", "Start", "Class", "Urgency", "Created", "Modified", "Status"],
      ["17066", "Julie H", "", "Austin", "Warranty Repair", "2026-07-28 09:00", "Deluxe Garages - Austin, TX", "NORMAL", "2026-07-20 10:00", "", "SCHEDULED"],
    ];
    await request(app)
      .post("/api/workorders")
      .send({ filename: "wo.xlsx", rows: WO_GRID })
      .expect(200);
    await request(app)
      .patch("/api/meeting/wonote")
      .send({ woId: "wo-17066", lead: "Dan", cause: "Topcoat bubbled", by: "PM" })
      .expect(200);

    const view = await request(app).get(`/api/meeting?week=${WEEK}`);
    expect(view.body.workOrders.warranties[0].lead).toBe("Dan");
    expect(view.body.workOrders.byLead[0]).toMatchObject({ lead: "Dan", count: 1 });
  });

  it("rejects a wrong file with a helpful message", async () => {
    const res = await request(app)
      .post("/api/meeting/pastdue")
      .send({ rows: [["Totally"], ["Wrong", "File"]] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unpaid invoices/i);
  });
});
