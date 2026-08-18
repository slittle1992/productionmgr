import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { parseMeetingsExport } from "../src/domain/appointments.js";
import { PipelineFormatError } from "../src/domain/pipeline.js";
import { MemoryLeadsStore } from "../src/storage/leadsStore.js";
import { MemoryMeetingStore } from "../src/storage/meetingStore.js";
import { MemoryWorkOrderStore } from "../src/storage/workOrderStore.js";
import { MemoryInventoryStore } from "../src/storage/inventoryStore.js";
import { MemoryPipelineStore } from "../src/storage/pipelineStore.js";
import { MemoryScheduleStore } from "../src/storage/scheduleStore.js";

const NOW = Date.UTC(2026, 7, 18, 12); // Tue 8/18/2026

const HEADER = [
  "Title", "Client", "Type", "Start", "Finish", "Employee", "Location",
  "Phone", "Project Type", "Source", "Status", "Set By", "Meeting Result",
  "Result Notes", "Meeting Status",
];
const row = (
  client: string | "",
  type: string,
  employee: string,
  mStatus = "",
  status = "",
  phone = ""
) => [
  client ? `${client} 76001` : "🚫OFF🚫", client, type, "08/15/26 @ 5:00 pm",
  "08/15/26 @ 6:00 pm", employee, "", phone, "", "", status, "", "", "", mStatus,
];

const GRID = [
  ["Meetings Between 08/09/2026 and 08/15/2026"],
  ["Data as of 8/18/26 @ 2:09 pm"],
  HEADER,
  row("", "OFF", "Sean Grady"), // blocker: no client
  row("", "Sales Meeting", "Will Haws"), // blocker written as a meeting
  row("Ann Ames", "Sales Meeting", "Kyle Cook"),
  row("Bob Best", "Sales Meeting", "Kyle Cook", "Cancelled"),
  row("Cal Cole", "Sales Meeting", "Sean Grady"),
  row("Dee Dean", "Be Back", "Sean Grady", "Cancelled"),
  row("Eve East", "TRAINING", "Sean Grady"), // blocker type, client anyway
  row("Fay Farr", "Sales Meeting", "Kyle Cook", "", "DEMO NO SALE", "(555) 111-2222"),
];

describe("meetings (appointments) parsing", () => {
  it("counts client appointments and cancellations per rep", () => {
    const r = parseMeetingsExport(GRID);
    expect(r.fromMs).toBe(Date.UTC(2026, 7, 9));
    expect(r.toMs).toBe(Date.UTC(2026, 7, 15));
    expect(r.sourceLabel).toContain("Meetings Between");
    expect(r.total).toBe(5); // blockers + TRAINING skipped
    expect(r.cancelled).toBe(2);
    expect(r.byRep).toEqual([
      { rep: "Kyle Cook", total: 3, cancelled: 1 },
      { rep: "Sean Grady", total: 2, cancelled: 1 },
    ]);
    // Zips come from the title; no-sales become the rehash call list.
    expect(r.byZip3).toEqual({ "760": { t: 5, c: 2 } });
    // Per-day counts (all fixture meetings start 08/15) with rep splits.
    expect(Object.keys(r.days)).toEqual(["2026-08-15"]);
    const day = r.days["2026-08-15"]!;
    expect(day).toMatchObject({ t: 5, c: 2 });
    expect(day.byRep["Kyle Cook"]).toMatchObject({ t: 3, c: 1 });
    expect(day.byZip3["760"]).toMatchObject({ t: 5, c: 2 });
    expect(r.noSales).toEqual([
      {
        client: "Fay Farr",
        phone: "(555) 111-2222",
        rep: "Kyle Cook",
        status: "DEMO NO SALE",
        projectType: null,
      },
    ]);
  });

  it("rejects a file without the meetings columns", () => {
    expect(() => parseMeetingsExport([["Week"], ["A", "B"]])).toThrow(
      PipelineFormatError
    );
  });
});

describe("meetings API", () => {
  function makeApp() {
    const config = loadConfig({ ALLOW_SAMPLE_DATA: "false" } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      meetingStore: new MemoryMeetingStore(),
      workOrderStore: new MemoryWorkOrderStore(),
      inventoryStore: new MemoryInventoryStore(),
      pipelineStore: new MemoryPipelineStore(),
      scheduleStore: new MemoryScheduleStore(),
      leadsStore: new MemoryLeadsStore(),
      now: () => NOW,
    }).app;
  }

  it("stores a week keyed by the title's range and serves it back", async () => {
    const app = makeApp();
    const up = await request(app)
      .post("/api/leads/meetings")
      .send({ filename: "meetings.xlsx", rows: GRID });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ weekStart: "2026-08-09", total: 5, cancelled: 2 });

    // Appointments come back even with no leads uploaded.
    const res = await request(app).get("/api/leads");
    expect(res.status).toBe(200);
    expect(res.body.meta).toBeNull();
    expect(res.body.appointments.weeks).toHaveLength(1);
    const wk = res.body.appointments.weeks[0];
    expect(wk.weekStart).toBe("2026-08-09");
    expect(wk.cancelRate).toBeCloseTo(0.4);
    expect(wk.byRep[0].rep).toBe("Kyle Cook");
    // With no leads to join zips to, appointments fall to Unassigned.
    expect(wk.byClass).toEqual([
      { className: "Unassigned", total: 5, cancelled: 2 },
    ]);
    // Per-day series for the appointments chart.
    expect(res.body.appointments.days).toHaveLength(1);
    expect(res.body.appointments.days[0]).toMatchObject({
      date: "2026-08-15",
      t: 5,
      c: 2,
    });
    expect(res.body.appointments.days[0].byClass.Unassigned.t).toBe(5);
    // The rehash call list rides along for the daily tasks.
    expect(res.body.dailyTasks.rehash).toHaveLength(1);
    expect(res.body.dailyTasks.rehash[0].client).toBe("Fay Farr");

    // Daily task checks round-trip.
    await request(app)
      .post("/api/leads/daily-check")
      .send({ key: "rehash", done: true })
      .expect(200);
    const after = await request(app).get("/api/leads");
    expect(after.body.dailyTasks.checks.rehash.done).toBe(true);

    // Re-uploading the same week replaces it, not duplicates it.
    await request(app)
      .post("/api/leads/meetings")
      .send({ rows: GRID })
      .expect(200);
    const again = await request(app).get("/api/leads");
    expect(again.body.appointments.weeks).toHaveLength(1);
  });

  it("400s when the title doesn't pin the week", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/leads/meetings")
      .send({ rows: [["Some export"], HEADER, row("Ann Ames", "Sales Meeting", "Kyle Cook")] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/week/i);
  });
});
