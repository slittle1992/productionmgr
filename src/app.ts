import express, { type Express } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderPrimeClient } from "./builderPrime/client.js";
import type { ProjectProvider } from "./builderPrime/provider.js";
import { SampleProjectProvider } from "./builderPrime/sampleData.js";
import { hasLiveCredentials, type AppConfig } from "./config.js";
import { errorMiddleware } from "./routes/errorMiddleware.js";
import { projectsRouter } from "./routes/projects.js";
import { reportsRouter } from "./routes/reports.js";
import { ProjectsService } from "./services/projectsService.js";
import { ReportService } from "./services/reportService.js";
import type { ReportRepository } from "./storage/repository.js";
import { JsonReportRepository } from "./storage/jsonStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");

export interface BuildAppOptions {
  config: AppConfig;
  /** Override the project source (used by tests). */
  provider?: ProjectProvider;
  repository?: ReportRepository;
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

  const projectsService = new ProjectsService(provider, config.productionManagerId);
  const reportService = new ReportService(
    projectsService,
    repository,
    config.laborMultiplier,
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
    });
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

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
