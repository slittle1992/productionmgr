import express, { type Express } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BuilderPrimeClient } from "./builderPrime/client.js";
import type { ProjectProvider } from "./builderPrime/provider.js";
import { SampleProjectProvider } from "./builderPrime/sampleData.js";
import { hasLiveCredentials, type AppConfig } from "./config.js";
import { errorMiddleware } from "./routes/errorMiddleware.js";
import { projectsRouter } from "./routes/projects.js";
import { reportsRouter } from "./routes/reports.js";
import { scheduleRouter } from "./routes/schedule.js";
import { ProjectsService } from "./services/projectsService.js";
import { ReportService } from "./services/reportService.js";
import { ScheduleService } from "./services/scheduleService.js";
import type { ReportRepository } from "./storage/repository.js";
import { JsonReportRepository } from "./storage/jsonStore.js";
import { JsonScheduleStore, type ScheduleStore } from "./storage/scheduleStore.js";

/**
 * Resolve the static `public/` directory. Works both when running from source
 * (tsx) and when bundled into a serverless function on Vercel, where the cwd is
 * the project root and `import.meta.url` may point elsewhere.
 */
function resolvePublicDir(): string {
  const candidates = [
    process.env.PUBLIC_DIR,
    path.join(process.cwd(), "public"),
    (() => {
      try {
        return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
      } catch {
        return undefined;
      }
    })(),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    if (existsSync(path.join(dir, "index.html"))) return dir;
  }
  return candidates[0] ?? path.join(process.cwd(), "public");
}

const PUBLIC_DIR = resolvePublicDir();

export interface BuildAppOptions {
  config: AppConfig;
  /** Override the project source (used by tests). */
  provider?: ProjectProvider;
  repository?: ReportRepository;
  scheduleStore?: ScheduleStore;
  now?: () => number;
}

export interface BuiltApp {
  app: Express;
  usingSampleData: boolean;
}

/** Choose the live Builder Prime client or the sample provider. */
function resolveProvider(config: AppConfig, now: () => number): ProjectProvider {
  if (hasLiveCredentials(config)) {
    const client = new BuilderPrimeClient({
      subdomain: config.builderPrime.subdomain!,
      apiKey: config.builderPrime.apiKey!,
    });
    return {
      isSample: false,
      listAllProjects: (params) => client.listAllProjects(params),
    };
  }
  if (!config.allowSampleData) {
    throw new Error(
      "No Builder Prime credentials configured and sample data is disabled. " +
        "Set BUILDER_PRIME_SUBDOMAIN and BUILDER_PRIME_API_KEY."
    );
  }
  return new SampleProjectProvider(now());
}

export function buildApp(options: BuildAppOptions): BuiltApp {
  const { config } = options;
  const now = options.now ?? (() => Date.now());
  const provider = options.provider ?? resolveProvider(config, now);
  const repository = options.repository ?? new JsonReportRepository(config.dataDir);
  const scheduleStore = options.scheduleStore ?? new JsonScheduleStore(config.dataDir);

  const projectsService = new ProjectsService(provider, config.productionManagerId);
  const reportService = new ReportService(
    projectsService,
    repository,
    config.laborMultiplier,
    config.weekStartDay,
    now
  );
  const scheduleService = new ScheduleService(
    provider,
    scheduleStore,
    config.coverage,
    config.customFields,
    config.weekStartDay,
    now
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Non-sensitive runtime info for the UI (never includes the API key).
  app.get("/api/config", (_req, res) => {
    res.json({
      usingSampleData: provider.isSample,
      laborMultiplier: config.laborMultiplier,
      weekStartDay: config.weekStartDay,
      scopedToManager: Boolean(config.productionManagerId),
      coverage: config.coverage,
    });
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.use("/api", scheduleRouter(scheduleService));
  app.use("/api", reportsRouter(reportService));
  app.use("/api", projectsRouter(projectsService));

  app.use(express.static(PUBLIC_DIR));
  // SPA fallback for any non-API GET.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  app.use(errorMiddleware);

  return { app, usingSampleData: provider.isSample };
}
