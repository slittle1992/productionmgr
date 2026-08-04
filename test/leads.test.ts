import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  buildLeadsAnalysis,
  categorize,
  parseClientsExport,
  type CompactLead,
} from "../src/domain/leads.js";
import { MemoryLeadsStore } from "../src/storage/leadsStore.js";
import { MemoryMeetingStore } from "../src/storage/meetingStore.js";
import { MemoryWorkOrderStore } from "../src/storage/workOrderStore.js";
import { MemoryInventoryStore } from "../src/storage/inventoryStore.js";
import { MemoryPipelineStore } from "../src/storage/pipelineStore.js";
import { MemoryScheduleStore } from "../src/storage/scheduleStore.js";

const NOW = Date.parse("2026-08-04T12:00:00Z");
const DAY = 86_400_000;

const GRID = [
  ["Clients List Export"],
  ["Data as of 8/4/2026 @ 12:40 pm"],
  ["", "Name", "Mobile", "Home Phone", "State", "City", "Zip", "Next Appointment", "Class", "Created", "Lead Status"],
  ["", "A One", "", "", "TX", "Dallas", "75201", "", "Deluxe Garages - Dallas, TX", "2026-08-01 09:00", "LIGHTFIRE"],
  ["", "B Two", "", "", "TX", "Dallas", "75201", "", "Deluxe Garages - Dallas, TX", "2026-07-30 09:00", "JOB SOLD"],
  ["", "C Three", "", "", "TX", "Fort Worth", "76102", "", "Deluxe Garages - Dallas, TX", "2026-07-10 09:00", "NOT INTERESTED"],
  ["", "D Four", "", "", "TX", "Godley", "", "", "Deluxe Garages - Dallas, TX", "2026-08-02 09:00", "REHASH"],
];

describe("leads parsing + categorisation", () => {
  it("parses the clients export into compact leads", () => {
    const { leads, sourceLabel } = parseClientsExport(GRID);
    expect(leads).toHaveLength(4);
    expect(leads[0]).toMatchObject({
      zip: "75201",
      className: "Dallas",
      city: "Dallas",
      cat: "open",
    });
    expect(leads[1]!.cat).toBe("sold");
    expect(leads[2]!.cat).toBe("dead");
    expect(leads[3]!.zip).toBe("?");
    expect(sourceLabel).toContain("as of");
  });

  it("categorises lead statuses", () => {
    expect(categorize("JOB SOLD & FINANCE REJECTED")).toBe("sold");
    expect(categorize("COMPLETED")).toBe("sold");
    expect(categorize("JOB IN PROGRESS")).toBe("sold");
    expect(categorize("BAD LEAD / WRONG #")).toBe("dead");
    expect(categorize("LIGHTFIRE")).toBe("open");
    expect(categorize(null)).toBe("open");
  });
});

describe("leads analysis", () => {
  const lead = (
    zip: string,
    daysAgo: number,
    cat: CompactLead["cat"] = "open",
    city = "Dallas"
  ): CompactLead => ({
    zip,
    className: "Dallas",
    city,
    created: NOW - daysAgo * DAY,
    cat,
  });

  it("clusters by zip3 and measures share movement between windows", () => {
    const leads = [
      // Current week: 3 Dallas-area (752), 1 Fort Worth (761).
      lead("75201", 1),
      lead("75204", 2),
      lead("75220", 3),
      lead("76102", 4, "open", "Fort Worth"),
      // Previous week: 1 Dallas-area, 3 Fort Worth — shift TOWARD 752.
      lead("75201", 9),
      lead("76102", 10, "open", "Fort Worth"),
      lead("76104", 11, "open", "Fort Worth"),
      lead("76110", 12, "open", "Fort Worth"),
    ];
    const a = buildLeadsAnalysis(leads, NOW, 7);
    const dallas = a.classes.find((c) => c.className === "Dallas")!;
    expect(dallas.current).toBe(4);
    expect(dallas.previous).toBe(4);

    const c752 = dallas.clusters.find((c) => c.cluster === "752")!;
    const c761 = dallas.clusters.find((c) => c.cluster === "761")!;
    expect(c752.current).toBe(3);
    expect(c752.previous).toBe(1);
    expect(c752.shareShiftPts).toBeCloseTo(50, 0); // 75% now vs 25% before
    expect(c761.shareShiftPts).toBeCloseTo(-50, 0);
    expect(dallas.gaining[0]!.cluster).toBe("752");
    expect(dallas.fading[0]!.cluster).toBe("761");
    expect(c761.cities).toContain("Fort Worth");
  });

  it("flags zips with volume but zero sales ever", () => {
    const leads: CompactLead[] = [];
    for (let i = 0; i < 12; i++) leads.push(lead("76044", 100 + i, "dead", "Godley"));
    for (let i = 0; i < 12; i++) leads.push(lead("75201", 100 + i, i < 3 ? "sold" : "open"));
    const a = buildLeadsAnalysis(leads, NOW, 28);
    const dallas = a.classes[0]!;
    expect(dallas.neverSells).toHaveLength(1);
    expect(dallas.neverSells[0]).toMatchObject({ zip: "76044", allTime: 12 });
    const c752 = dallas.clusters.find((c) => c.cluster === "752")!;
    expect(c752.conversion).toBeCloseTo(0.25, 2);
  });
});

describe("leads API", () => {
  it("uploads the export and serves the analysis", async () => {
    const config = loadConfig({ ALLOW_SAMPLE_DATA: "false" } as NodeJS.ProcessEnv);
    const app = buildApp({
      config,
      meetingStore: new MemoryMeetingStore(),
      workOrderStore: new MemoryWorkOrderStore(),
      inventoryStore: new MemoryInventoryStore(),
      pipelineStore: new MemoryPipelineStore(),
      scheduleStore: new MemoryScheduleStore(),
      leadsStore: new MemoryLeadsStore(),
      now: () => NOW,
    }).app;

    await request(app)
      .post("/api/leads")
      .send({ filename: "clients.xlsx", rows: GRID })
      .expect(200);

    const res = await request(app).get("/api/leads?days=7");
    expect(res.status).toBe(200);
    expect(res.body.meta.count).toBe(4);
    const dallas = res.body.analysis.classes.find(
      (c: { className: string }) => c.className === "Dallas"
    );
    expect(dallas.current).toBe(3); // 8/1, 8/2, 7/30 within 7 days of 8/4
    expect(dallas.soldCurrentCohort).toBe(1);

    // The meeting view reports the upload and the leads section auto-status.
    const meeting = await request(app).get("/api/meeting?week=2026-08-02");
    expect(meeting.body.leads.count).toBe(4);
    expect(meeting.body.sectionCount).toBe(8);
    const leadsSection = meeting.body.sections.find(
      (s: { key: string }) => s.key === "leads"
    );
    expect(leadsSection.autoDone).toBe(true);
  });
});
