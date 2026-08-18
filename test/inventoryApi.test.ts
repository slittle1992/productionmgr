import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SampleProjectProvider } from "../src/builderPrime/sampleData.js";
import { MemoryInventoryCountsStore } from "../src/storage/inventoryCountsStore.js";

// Fixed clock: Tuesday 2026-08-18 → reporting week 2026-08-16..2026-08-22.
const NOW = Date.parse("2026-08-18T12:00:00Z");

function makeApp() {
  const config = loadConfig({ ALLOW_SAMPLE_DATA: "true" } as NodeJS.ProcessEnv);
  return buildApp({
    config,
    provider: new SampleProjectProvider(NOW),
    inventoryCountsStore: new MemoryInventoryCountsStore(),
    now: () => NOW,
  }).app;
}

const week1Rows = [
  ["FLAKE COLOR", "Count"],
  ["Claystone", 17],
  ["Autumn Brown", 36],
  ["Glacier", 40],
  ["RUBBER BINDER & RESIN", "Count"],
  ["FUMED SILICA", 18],
];
const week2Rows = [
  ["Submitted 8/17/2026, 7:59:59 AM · by John Blake · 4 trailers"],
  ["FLAKE COLOR", "Count"],
  ["Claystone", 7],
  ["Autumn Brown", 36],
  ["Glacier", 44],
  ["RUBBER BINDER & RESIN", "Count"],
  ["FUMED SILICA", 14],
];

describe("inventory API", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("returns an empty summary before any upload", async () => {
    const res = await request(app).get("/api/inventory-counts");
    expect(res.status).toBe(200);
    expect(res.body.week.weekStart).toBe("2026-08-16");
    expect(res.body.current).toBeNull();
    expect(res.body.usage).toBeNull();
  });

  it("stores counts per week and computes usage + cost against the prior week", async () => {
    const up1 = await request(app)
      .post("/api/inventory-counts?week=2026-08-09")
      .send({ filename: "counts1.xlsx", rows: week1Rows });
    expect(up1.status).toBe(200);
    expect(up1.body.current.itemCount).toBe(4);
    expect(up1.body.previous).toBeNull();

    const up2 = await request(app).post("/api/inventory-counts").send({ rows: week2Rows });
    expect(up2.status).toBe(200);
    expect(up2.body.week.weekStart).toBe("2026-08-16");
    expect(up2.body.previous.weekStart).toBe("2026-08-09");
    expect(up2.body.current.sourceLabel).toMatch(/^Submitted 8\/17\/2026/);

    // Claystone is priced from the PO defaults (10 used × $82.40); Fumed
    // Silica has no default and is flagged so the total isn't silently low.
    expect(up2.body.usage.usedCount).toBe(2);
    expect(up2.body.usage.totalCost).toBe(824);
    expect(up2.body.usage.unpricedItems).toEqual(["FUMED SILICA"]);

    // Override the default and price the silica.
    const priced = await request(app)
      .post("/api/inventory-counts/prices")
      .send({ prices: { Claystone: 84.2, "FUMED SILICA": 100 } });
    expect(priced.status).toBe(200);
    expect(priced.body.prices.claystone).toBe(84.2);

    // 10 × $84.20 + 4 × $100.
    const summary = await request(app).get("/api/inventory-counts?week=2026-08-16");
    expect(summary.body.usage.totalCost).toBe(1242);
    expect(summary.body.usage.unpricedItems).toEqual([]);
    const glacier = summary.body.usage.lines.find(
      (l: { item: string }) => l.item === "Glacier"
    );
    expect(glacier).toMatchObject({ used: 0, restocked: true });
  });

  it("snaps mid-week dates to the reporting week", async () => {
    await request(app).post("/api/inventory-counts?week=2026-08-18").send({ rows: week1Rows });
    const res = await request(app).get("/api/inventory-counts?week=2026-08-16");
    expect(res.body.current?.itemCount).toBe(4);
  });

  it("rejects unreadable uploads with a helpful 400", async () => {
    const res = await request(app)
      .post("/api/inventory-counts")
      .send({ rows: [["nothing"], ["useful", "here"]] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_inventory");
    expect(res.body.message).toMatch(/inventory count/i);
  });

  it("deletes a week's count", async () => {
    await request(app).post("/api/inventory-counts").send({ rows: week2Rows });
    await request(app).delete("/api/inventory-counts");
    const res = await request(app).get("/api/inventory-counts");
    expect(res.body.current).toBeNull();
  });
});
