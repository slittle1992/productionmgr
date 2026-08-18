import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SampleProjectProvider } from "../src/builderPrime/sampleData.js";
import { MemoryInventoryStore } from "../src/storage/inventoryStore.js";

// Fixed clock: Tuesday 2026-08-18 → reporting week 2026-08-16..2026-08-22.
const NOW = Date.parse("2026-08-18T12:00:00Z");

function makeApp() {
  const config = loadConfig({ ALLOW_SAMPLE_DATA: "true" } as NodeJS.ProcessEnv);
  return buildApp({
    config,
    provider: new SampleProjectProvider(NOW),
    inventoryStore: new MemoryInventoryStore(),
    now: () => NOW,
  }).app;
}

const week1Rows = [
  ["FLAKE COLOR", "Count"],
  ["Claystone", 17],
  ["Autumn Brown", 36],
  ["Glacier", 40],
];
const week2Rows = [
  ["Submitted 8/17/2026, 7:59:59 AM · by John Blake · 4 trailers"],
  ["FLAKE COLOR", "Count"],
  ["Claystone", 7],
  ["Autumn Brown", 36],
  ["Glacier", 44],
];

describe("inventory API", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("returns an empty summary before any upload", async () => {
    const res = await request(app).get("/api/inventory");
    expect(res.status).toBe(200);
    expect(res.body.week.weekStart).toBe("2026-08-16");
    expect(res.body.current).toBeNull();
    expect(res.body.usage).toBeNull();
  });

  it("stores counts per week and computes usage + cost against the prior week", async () => {
    const up1 = await request(app)
      .post("/api/inventory?week=2026-08-09")
      .send({ filename: "counts1.xlsx", rows: week1Rows });
    expect(up1.status).toBe(200);
    expect(up1.body.current.itemCount).toBe(3);
    expect(up1.body.previous).toBeNull();

    const up2 = await request(app).post("/api/inventory").send({ rows: week2Rows });
    expect(up2.status).toBe(200);
    expect(up2.body.week.weekStart).toBe("2026-08-16");
    expect(up2.body.previous.weekStart).toBe("2026-08-09");
    expect(up2.body.current.sourceLabel).toMatch(/^Submitted 8\/17\/2026/);

    // No prices yet: usage found, cost 0, Claystone flagged unpriced.
    expect(up2.body.usage.usedCount).toBe(1);
    expect(up2.body.usage.totalCost).toBe(0);
    expect(up2.body.usage.unpricedItems).toEqual(["Claystone"]);

    // Price the flake box and the cost appears (10 used × $84.20).
    const priced = await request(app)
      .post("/api/inventory/prices")
      .send({ prices: { Claystone: 84.2 } });
    expect(priced.status).toBe(200);
    expect(priced.body.prices.claystone).toBe(84.2);

    const summary = await request(app).get("/api/inventory?week=2026-08-16");
    expect(summary.body.usage.totalCost).toBe(842);
    const glacier = summary.body.usage.lines.find(
      (l: { item: string }) => l.item === "Glacier"
    );
    expect(glacier).toMatchObject({ used: 0, restocked: true });
  });

  it("snaps mid-week dates to the reporting week", async () => {
    await request(app).post("/api/inventory?week=2026-08-18").send({ rows: week1Rows });
    const res = await request(app).get("/api/inventory?week=2026-08-16");
    expect(res.body.current?.itemCount).toBe(3);
  });

  it("rejects unreadable uploads with a helpful 400", async () => {
    const res = await request(app)
      .post("/api/inventory")
      .send({ rows: [["nothing"], ["useful", "here"]] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_inventory");
    expect(res.body.message).toMatch(/inventory count/i);
  });

  it("deletes a week's count", async () => {
    await request(app).post("/api/inventory").send({ rows: week2Rows });
    await request(app).delete("/api/inventory");
    const res = await request(app).get("/api/inventory");
    expect(res.body.current).toBeNull();
  });
});
