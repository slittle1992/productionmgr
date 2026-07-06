import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SampleProjectProvider } from "../src/builderPrime/sampleData.js";
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

function makeApp() {
  const config = loadConfig({ ALLOW_SAMPLE_DATA: "true" } as NodeJS.ProcessEnv);
  const now = () => Date.parse("2026-06-30T12:00:00Z");
  return buildApp({
    config,
    provider: new SampleProjectProvider(now()),
    repository: new MemoryRepo(),
    now,
  }).app;
}

describe("HTTP API", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("exposes config without leaking the API key", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body.usingSampleData).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/api[_-]?key/i);
  });

  it("returns a pre-filled current-week report from sample data", async () => {
    const res = await request(app).get("/api/report");
    expect(res.status).toBe(200);
    expect(res.body.weekStart).toBe("2026-06-28");
    // Sample data: two projects start this week (42000 + 18500).
    expect(res.body.auto.projectedJobSchedule).toBeGreaterThan(0);
    expect(res.body.usingSampleData).toBe(true);
  });

  it("saves a report and recomputes derived fields", async () => {
    const res = await request(app)
      .post("/api/report")
      .send({
        manual: {
          actualLaborRaw: 1000,
          warrantiesOpenedThisWeek: 2,
          leadsThisWeek: 3,
          materialsGivenForWarranties: 0,
          projectedMaterials: 0,
          actualMaterials: 0,
          totalSundriesCost: 0,
        },
        submit: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.derived.actualLabor).toBe(1200);
    expect(res.body.status).toBe("draft");
  });

  it("rejects invalid input with a 400 and field detail", async () => {
    const res = await request(app)
      .post("/api/report")
      .send({ manual: { actualLaborRaw: -5 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it("lists projects, excluding cancelled by default", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(200);
    const names = res.body.projects.map((p: { name: string }) => p.name);
    expect(names).not.toContain("Pine Way (cancelled)");
    expect(res.body.projects.length).toBeGreaterThan(0);
  });

  it("includes cancelled projects when asked", async () => {
    const res = await request(app).get("/api/projects?includeCancelled=true");
    const names = res.body.projects.map((p: { name: string }) => p.name);
    expect(names).toContain("Pine Way (cancelled)");
  });

  it("serves the mobile app shell at the root", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Weekly Report");
  });
});
