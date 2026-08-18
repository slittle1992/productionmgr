import { describe, expect, it } from "vitest";
import {
  computeDailyLeadFlow,
  computeRepScorecard,
  computeWeeklyFlow,
  parseLeadPerformance,
  parseSoldContracts,
  salesByCluster,
} from "../src/domain/sales.js";
import { PipelineFormatError } from "../src/domain/pipeline.js";
import type { CompactLead } from "../src/domain/leads.js";

const SOLD_GRID: unknown[][] = [
  ["Total Sales (Contracts) Between 08/16/2026 and 08/18/2026"],
  ["ReVamp - Data as of 8/18/26 @ 12:51 pm"],
  ["Sales Person", "Sales Person 2", "Contract #", "Lead Setter", "Lead Source", "Project Type", "Job #", "Client", "Document Type", "Project Status", "Sale Date", "Amount", "Discount Amount", "Sale Amount", "Contract Cost", "Gross Profit"],
  // Sale Date as Excel serial: 46243 = 2026-08-09.
  ["Adam Asrar", null, 198544, "Levi", "Organic", "Concrete Coating", 146909, "Corbin Gerald", "Contract", "Installed / Complete / Paid In Full", 46243, 4672.45, 700.87, 3971.58, 1455.95, 2396.48],
  ["Adam Asrar", null, 198545, null, "Website", "Rubber Coating", 146910, "Jane Poole", "Contract", "Sold", 46244, 3000, 0, 3000, 0, 3000],
  ["Angel Nunez", null, 198546, null, null, "Concrete Coating", 146911, "Max Voss", "Contract", "Cancelled", 46244, 9999, 0, 9999, 0, 9999],
];

const PERF_GRID: unknown[][] = [
  ["lead-performance-summary"],
  ["ReVamp - From 08/09/2026 To 08/15/2026 - Data as of 8/18/26"],
  ["Sales Person", "Opportunities Created", "Appointments Set", "Appointments Cancelled", "Leads Issued", "Resets", "No Demos", "Demos", "Demo / No Sales", "Jobs Sold", "Jobs Cancelled", "Finance Rejected"],
  ["Adam Asrar", 30, 26, 1, 20, 0, 2, 18, 12, 2, 0, 0],
  ["Angel Nunez", 40, 36, 0, 30, 0, 1, 29, 25, 3, 1, 0],
];

describe("sold contracts parsing", () => {
  it("reads rep, client, type, date, and net amount", () => {
    const { rows, sourceLabel } = parseSoldContracts(SOLD_GRID);
    expect(rows).toHaveLength(3);
    expect(sourceLabel).toMatch(/Between 08\/16/);
    expect(rows[0]).toMatchObject({
      rep: "Adam Asrar",
      clientKey: "corbin gerald",
      projectType: "Concrete Coating",
      saleAmount: 3971.58,
    });
    expect(new Date(rows[0]!.saleMs!).toISOString().slice(0, 10)).toBe("2026-08-09");
  });
});

describe("lead performance parsing", () => {
  it("reads the rep funnel and the report range", () => {
    const perf = parseLeadPerformance(PERF_GRID);
    expect(perf.byRep).toHaveLength(2);
    expect(perf.byRep[0]).toMatchObject({ rep: "Adam Asrar", issued: 20, sold: 2 });
    expect(new Date(perf.fromMs!).toISOString().slice(0, 10)).toBe("2026-08-09");
    expect(new Date(perf.toMs!).toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("rejects the by-Lead-Source variant with guidance", () => {
    const bySource = [
      ["title"],
      ["Lead Source", "Opportunities Created", "Leads Issued", "Jobs Sold"],
      ["Website", 10, 9, 3],
    ];
    expect(() => parseLeadPerformance(bySource)).toThrow(/Sales Person/);
  });
});

describe("rep scorecard", () => {
  it("computes close rate and NSLI, excluding cancelled contracts", () => {
    const perf = parseLeadPerformance(PERF_GRID);
    const { rows } = parseSoldContracts(SOLD_GRID);
    const cards = computeRepScorecard(perf, rows);
    const adam = cards.find((c) => c.rep === "Adam Asrar")!;
    expect(adam.closeRate).toBeCloseTo(0.1);
    expect(adam.net).toBeCloseTo(6971.58);
    expect(adam.nsli).toBeCloseTo(348.58, 1);
    // Angel's only contract is cancelled → $0 net.
    const angel = cards.find((c) => c.rep === "Angel Nunez")!;
    expect(angel.net).toBe(0);
  });
});

describe("weekly flow", () => {
  it("counts leads per week with the same week last year and sold mix", () => {
    const wk = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
    const leads = [
      { zip: "78701", className: "Austin", city: null, created: wk("2026-08-10"), cat: "open" as const, name: "a b" },
      { zip: "78701", className: "Austin", city: null, created: wk("2026-08-11"), cat: "open" as const, name: "c d" },
      // 52 weeks earlier.
      { zip: "78701", className: "Austin", city: null, created: wk("2025-08-11"), cat: "open" as const, name: "e f" },
    ];
    const { rows: sold } = parseSoldContracts(SOLD_GRID);
    const flow = computeWeeklyFlow(leads, sold, 0, wk("2026-08-12"), 2);
    const thisWeek = flow[flow.length - 1]!;
    expect(thisWeek.weekStart).toBe("2026-08-09");
    expect(thisWeek.leads).toBe(2);
    expect(thisWeek.leadsLastYear).toBe(1);
    // 3971.58 flake + 3000 rubber; cancelled excluded.
    expect(thisWeek.soldNet).toBeCloseTo(6971.58);
    expect(thisWeek.rubberNet).toBe(3000);
    expect(thisWeek.flakeNet).toBeCloseTo(3971.58);
  });
});

describe("sales by area (name join)", () => {
  it("joins sold contracts to lead zips by client name", () => {
    const leads = [
      { zip: "78701", className: "Austin", city: "Austin", created: 1, cat: "sold" as const, name: "corbin gerald" },
      { zip: "75001", className: "Dallas", city: null, created: 1, cat: "sold" as const, name: "jane poole" },
    ];
    const { rows: sold } = parseSoldContracts(SOLD_GRID);
    const area = salesByCluster(leads, sold, 0, Date.parse("2027-01-01"));
    expect(area.total).toBe(2); // cancelled excluded
    expect(area.joined).toBe(2);
    expect(area.clusters["Austin|787"]).toMatchObject({ net: 3971.58, soldCount: 1 });
    expect(area.clusters["Dallas|750"]).toMatchObject({ net: 3000, soldCount: 1 });
  });
});

describe("daily lead flow + goal pacing", () => {
  // Tue Aug 18 2026, noon UTC — day 18 of a 31-day month.
  const NOW = Date.UTC(2026, 7, 18, 12);
  const DAY = 86_400_000;
  const lead = (daysAgo: number, pt: "rubber" | "flake" | null): CompactLead => ({
    zip: "76001",
    className: "Dallas",
    city: null,
    created: NOW - daysAgo * DAY,
    cat: "open",
    pt,
  });

  it("buckets leads per day split by project type", () => {
    const leads = [lead(0, "flake"), lead(0, "rubber"), lead(1, "flake"), lead(1, null)];
    const d = computeDailyLeadFlow(leads, { flakeMonthly: null, rubberMonthly: null }, NOW);
    expect(d.days).toHaveLength(14);
    expect(d.days[0]).toMatchObject({ date: "2026-08-18", flake: 1, rubber: 1, total: 2 });
    expect(d.days[1]).toMatchObject({ date: "2026-08-17", flake: 1, other: 1, total: 2 });
    expect(d.hasType).toBe(true);
    expect(d.dataThroughMs).toBe(NOW);
    expect(d.month).toMatchObject({ label: "August", day: 18, daysInMonth: 31 });
  });

  it("computes pace vs the monthly goal and the needed run rate", () => {
    // 36 flake leads MTD (2/day for 18 days), goal 62 (2/day pace).
    const leads: CompactLead[] = [];
    for (let i = 0; i < 18; i++) leads.push(lead(i, "flake"), lead(i, "flake"));
    const d = computeDailyLeadFlow(leads, { flakeMonthly: 62, rubberMonthly: null }, NOW);
    const flake = d.pace.find((p) => p.type === "flake")!;
    expect(flake.mtd).toBe(36);
    expect(flake.expectedToDate).toBe(36); // 62 × 18/31
    expect(flake.delta).toBe(0);
    expect(flake.neededPerDay).toBe(2); // (62−36)/13
    expect(flake.last7PerDay).toBe(2);
    expect(flake.projected).toBe(62);
    expect(flake.onTrack).toBe(true);
    // Total pace mirrors the only set goal.
    const total = d.pace.find((p) => p.type === "total")!;
    expect(total.goal).toBe(62);
  });

  it("flags off-track when the trailing rate can't reach the goal", () => {
    const leads = [lead(0, "rubber")]; // 1 MTD vs a 100 goal
    const d = computeDailyLeadFlow(leads, { flakeMonthly: null, rubberMonthly: 100 }, NOW);
    const rubber = d.pace.find((p) => p.type === "rubber")!;
    expect(rubber.onTrack).toBe(false);
    expect(rubber.delta).toBeLessThan(0);
  });
});
