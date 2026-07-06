import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryPipelineStore } from "../src/storage/pipelineStore.js";
import { MemoryScheduleStore } from "../src/storage/scheduleStore.js";
import type { StoredReport } from "../src/domain/weeklyReport.js";
import type { ReportRepository } from "../src/storage/repository.js";

class MemoryRepo implements ReportRepository {
  store = new Map<string, StoredReport>();
  async get(w: string, c: string) {
    return this.store.get(`${w}|${c}`) ?? null;
  }
  async save(r: StoredReport) {
    this.store.set(`${r.weekStart}|${r.className}`, structuredClone(r));
  }
  async listAll() {
    return [...this.store.values()];
  }
  async listByQuarter(q: string) {
    return [...this.store.values()].filter((r) => r.quarter === q);
  }
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/pipelineSample.json", import.meta.url)), "utf8")
) as unknown[][];

function makeApp() {
  const config = loadConfig({ ALLOW_SAMPLE_DATA: "true" } as NodeJS.ProcessEnv);
  // Pick a week that the fixture's first job (start 2026-08-13) falls in.
  const now = () => Date.parse("2026-08-13T12:00:00Z");
  return buildApp({
    config,
    repository: new MemoryRepo(),
    scheduleStore: new MemoryScheduleStore(),
    pipelineStore: new MemoryPipelineStore(),
    now,
  }).app;
}

describe("pipeline upload API", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("reports sample source before any upload", async () => {
    const res = await request(app).get("/api/config");
    expect(res.body.source).toBe("sample");
    const p = await request(app).get("/api/pipeline");
    expect(p.body.pipeline).toBeNull();
  });

  it("accepts an upload and returns a summary", async () => {
    const res = await request(app)
      .post("/api/pipeline")
      .send({ filename: "pipeline.xlsx", rows: fixture });
    expect(res.status).toBe(200);
    expect(res.body.pipeline.rowCount).toBeGreaterThan(0);
    expect(res.body.pipeline.filename).toBe("pipeline.xlsx");

    const cfg = await request(app).get("/api/config");
    expect(cfg.body.source).toBe("pipeline");
  });

  it("drives the schedule from the uploaded pipeline", async () => {
    await request(app).post("/api/pipeline").send({ rows: fixture });
    const res = await request(app).get("/api/schedule?week=2026-08-09");
    expect(res.status).toBe(200);
    expect(res.body.usingSampleData).toBe(false);

    const austin = res.body.classes.find((c: { className: string }) => c.className === "Austin");
    expect(austin).toBeTruthy();
    const job = austin.jobs.find((j: { jobNumber: string }) => j.jobNumber === "156407");
    expect(job).toBeTruthy();
    expect(job.sqft).toBe(255);
    expect(job.color).toBe("Claystone");
    // Polyurea A from sqft: 255/200 * 2/3 = 0.85.
    expect(job.material.basecoatAGallons).toBeCloseTo(0.85, 2);
  });

  it("rejects a non-pipeline file with a clear error", async () => {
    const res = await request(app)
      .post("/api/pipeline")
      .send({ rows: [["just"], ["some", "garbage"]] });
    expect(res.status).toBe(400);
  });

  it("clears the pipeline on DELETE", async () => {
    await request(app).post("/api/pipeline").send({ rows: fixture });
    await request(app).delete("/api/pipeline");
    const cfg = await request(app).get("/api/config");
    expect(cfg.body.source).toBe("sample");
  });
});
