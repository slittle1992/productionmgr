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
  ["Deluxe Garages - Austin — Inventory Count"],
  ["FLAKE COLOR", "Count"],
  ["Claystone", 17],
  ["Autumn Brown", 36],
  ["Glacier", 40],
  ["RUBBER BINDER & RESIN", "Count"],
  ["FUMED SILICA", 18],
];
const week2Rows = [
  ["Deluxe Garages - Austin — Inventory Count"],
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
    expect(res.body.classes).toEqual([]);
    expect(res.body.totals.materialCost).toBe(0);
  });

  it("stores counts per week and computes usage + cost against the prior week", async () => {
    const up1 = await request(app)
      .post("/api/inventory-counts?week=2026-08-09")
      .send({ filename: "counts1.xlsx", rows: week1Rows });
    expect(up1.status).toBe(200);
    expect(up1.body.className).toBe("Austin");
    expect(up1.body.itemCount).toBe(4);

    const up2 = await request(app).post("/api/inventory-counts").send({ rows: week2Rows });
    expect(up2.status).toBe(200);
    expect(up2.body.week.weekStart).toBe("2026-08-16");
    const austin = up2.body.classes.find(
      (c: { className: string }) => c.className === "Austin"
    );
    expect(austin.previous.weekStart).toBe("2026-08-09");
    expect(austin.current.sourceLabel).toMatch(/^Submitted 8\/17\/2026/);

    // With no purchases entered, material cost degrades to the trailer
    // drawdown: Claystone 17→7 at the PO default $82.40 plus Glacier 40→44
    // (stock UP 4 × $62 = −$248) nets 824 − 248 = $576. Austin is flagged
    // as missing a purchases entry; Fumed Silica has no unit cost.
    expect(up2.body.totals.usedCount).toBe(2);
    const austinSum = up2.body.classes.find(
      (c: { className: string }) => c.className === "Austin"
    );
    expect(austinSum.materialCost).toBe(576);
    expect(austinSum.purchases).toBeNull();
    expect(up2.body.totals.missingPurchases).toContain("Austin");
    expect(up2.body.totals.unpricedItems).toEqual(["FUMED SILICA"]);

    // Enter the week's material spend and the P&L identity takes over:
    // 1000 + begin − end = 1000 + 576 = $1,576.
    const withPurch = await request(app)
      .post("/api/inventory-counts/purchases?week=2026-08-16")
      .send({ className: "Austin", amount: 1000 });
    expect(withPurch.status).toBe(200);
    const austinP = withPurch.body.classes.find(
      (c: { className: string }) => c.className === "Austin"
    );
    expect(austinP.purchases).toBe(1000);
    expect(austinP.materialCost).toBe(1576);
    expect(withPurch.body.totals.missingPurchases).not.toContain("Austin");

    // A second location the same week stacks onto the totals (class given
    // explicitly since these rows carry no title line).
    const dallas = await request(app)
      .post("/api/inventory-counts?week=2026-08-09")
      .send({ rows: week1Rows.slice(1), className: "Dallas" });
    expect(dallas.status).toBe(200);
    expect(dallas.body.className).toBe("Dallas");
    await request(app)
      .post("/api/inventory-counts")
      .send({ rows: week2Rows.slice(2), className: "Dallas" });

    // Override the default and price the silica.
    const priced = await request(app)
      .post("/api/inventory-counts/prices")
      .send({ prices: { Claystone: 84.2, "FUMED SILICA": 100 } });
    expect(priced.status).toBe(200);
    expect(priced.body.prices.claystone).toBe(84.2);

    // Two locations; item-movement detail still works per location.
    const summary = await request(app).get("/api/inventory-counts?week=2026-08-16");
    expect(summary.body.classes).toHaveLength(2);
    expect(summary.body.totals.unpricedItems).toEqual([]);
    const glacier = summary.body.classes[0].usage.lines.find(
      (l: { item: string }) => l.item === "Glacier"
    );
    expect(glacier).toMatchObject({ used: 0, restocked: true });
  });

  it("requires a location when none can be detected", async () => {
    const res = await request(app)
      .post("/api/inventory-counts")
      .send({ rows: week2Rows.slice(2) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("needs_class");
  });

  it("files a sheet under the week of its Submitted date, not the requested week", async () => {
    // week2Rows says "Submitted 8/17/2026" → week of 2026-08-16, even though
    // the request targets 2026-08-09.
    const res = await request(app)
      .post("/api/inventory-counts?week=2026-08-09")
      .send({ rows: week2Rows });
    expect(res.status).toBe(200);
    expect(res.body.week.weekStart).toBe("2026-08-16");
    const wk = await request(app).get("/api/inventory-counts?week=2026-08-16");
    expect(wk.body.classes[0]?.className).toBe("Austin");
  });

  it("snaps mid-week dates to the reporting week", async () => {
    await request(app).post("/api/inventory-counts?week=2026-08-18").send({ rows: week1Rows });
    const res = await request(app).get("/api/inventory-counts?week=2026-08-16");
    expect(res.body.classes[0]?.current.itemCount).toBe(4);
  });

  it("rejects unreadable uploads with a helpful 400", async () => {
    const res = await request(app)
      .post("/api/inventory-counts")
      .send({ rows: [["nothing"], ["useful", "here"]] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_inventory");
    expect(res.body.message).toMatch(/inventory count/i);
  });

  it("deletes one location's count", async () => {
    await request(app).post("/api/inventory-counts").send({ rows: week2Rows });
    await request(app)
      .post("/api/inventory-counts")
      .send({ rows: week2Rows.slice(2), className: "Dallas" });
    await request(app).delete("/api/inventory-counts?class=Austin");
    const res = await request(app).get("/api/inventory-counts");
    expect(res.body.classes.map((c: { className: string }) => c.className)).toEqual([
      "Dallas",
    ]);
    await request(app).delete("/api/inventory-counts");
    const empty = await request(app).get("/api/inventory-counts");
    expect(empty.body.classes).toEqual([]);
  });
});
