import express, { type Express } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BuilderPrimeClient } from "./builderPrime/client.js";
import type { ProjectProvider } from "./builderPrime/provider.js";
import { SampleProjectProvider } from "./builderPrime/sampleData.js";
import { PipelineProvider } from "./builderPrime/pipelineProvider.js";
import {
  hasDurableStorage,
  hasLiveCredentials,
  loadConfig,
  type AppConfig,
} from "./config.js";
import { asyncHandler } from "./routes/asyncHandler.js";
import { errorMiddleware } from "./routes/errorMiddleware.js";
import { projectsRouter } from "./routes/projects.js";
import { reportsRouter } from "./routes/reports.js";
import { scheduleRouter } from "./routes/schedule.js";
import { pipelineRouter } from "./routes/pipeline.js";
import { workOrdersRouter } from "./routes/workOrders.js";
import { rosterRouter } from "./routes/roster.js";
import { payRouter } from "./routes/pay.js";
import { inventoryCountsRouter } from "./routes/inventoryCounts.js";
import { meetingRouter } from "./routes/meeting.js";
import { stagingRouter } from "./routes/staging.js";
import { MeetingService } from "./services/meetingService.js";
import {
  JsonMeetingStore,
  KvMeetingStore,
  type MeetingStore,
} from "./storage/meetingStore.js";
import {
  JsonInventoryStore,
  KvInventoryStore,
  type InventoryStore,
} from "./storage/inventoryStore.js";
import { snapshotRouter } from "./routes/snapshot.js";
import { leadsRouter } from "./routes/leads.js";
import {
  JsonLeadsStore,
  KvLeadsStore,
  type LeadsStore,
} from "./storage/leadsStore.js";
import {
  JsonSnapshotStore,
  KvSnapshotStore,
  type SnapshotStore,
} from "./storage/snapshotStore.js";
import { ProjectsService } from "./services/projectsService.js";
import { ReportService } from "./services/reportService.js";
import { ScheduleService } from "./services/scheduleService.js";
import type { ReportRepository } from "./storage/repository.js";
import { JsonReportRepository } from "./storage/jsonStore.js";
import { JsonScheduleStore, type ScheduleStore } from "./storage/scheduleStore.js";
import { KvReportRepository } from "./storage/kvReportRepository.js";
import { KvScheduleStore } from "./storage/kvScheduleStore.js";
import { UpstashKvClient } from "./storage/kv/upstashKvClient.js";
import { PgKvClient } from "./storage/kv/pgKvClient.js";
import {
  JsonPipelineStore,
  KvPipelineStore,
  type PipelineStore,
} from "./storage/pipelineStore.js";
import {
  JsonWorkOrderStore,
  KvWorkOrderStore,
  type WorkOrderStore,
} from "./storage/workOrderStore.js";
import {
  JsonRosterStore,
  KvRosterStore,
  type RosterStore,
} from "./storage/rosterStore.js";
import {
  JsonInventoryCountsStore,
  KvInventoryCountsStore,
  type InventoryCountsStore,
} from "./storage/inventoryCountsStore.js";

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
  pipelineStore?: PipelineStore;
  workOrderStore?: WorkOrderStore;
  rosterStore?: RosterStore;
  inventoryCountsStore?: InventoryCountsStore;
  meetingStore?: MeetingStore;
  inventoryStore?: InventoryStore;
  snapshotStore?: SnapshotStore;
  leadsStore?: LeadsStore;
  now?: () => number;
}

export interface BuiltApp {
  app: Express;
  usingSampleData: boolean;
  usingDurableStorage: boolean;
}

const EMPTY_PROVIDER: ProjectProvider = {
  isSample: false,
  listAllProjects: async () => [],
};

/**
 * Pick the project source: live Builder Prime when credentials exist; otherwise
 * an uploaded pipeline (falling back to sample data, or nothing if sample data
 * is disabled).
 */
function resolveProvider(
  config: AppConfig,
  now: () => number,
  pipelineStore: PipelineStore
): ProjectProvider {
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
  const fallback = config.allowSampleData
    ? new SampleProjectProvider(now())
    : EMPTY_PROVIDER;
  return new PipelineProvider(pipelineStore, fallback);
}

export function buildApp(options: BuildAppOptions): BuiltApp {
  const { config } = options;
  const now = options.now ?? (() => Date.now());

  // Durable KV store when configured (Vercel KV / Upstash); otherwise the
  // JSON-file store. Both satisfy the same repository interfaces.
  const durable = hasDurableStorage(config);
  // Prefer Neon Postgres; fall back to Upstash/Vercel KV; else JSON files.
  const kv = config.databaseUrl
    ? new PgKvClient(config.databaseUrl)
    : config.kv.url && config.kv.token
    ? new UpstashKvClient(config.kv.url, config.kv.token)
    : null;
  const repository =
    options.repository ??
    (kv ? new KvReportRepository(kv) : new JsonReportRepository(config.dataDir));
  const scheduleStore =
    options.scheduleStore ??
    (kv ? new KvScheduleStore(kv) : new JsonScheduleStore(config.dataDir));
  const pipelineStore =
    options.pipelineStore ??
    (kv ? new KvPipelineStore(kv) : new JsonPipelineStore(config.dataDir));
  const workOrderStore =
    options.workOrderStore ??
    (kv ? new KvWorkOrderStore(kv) : new JsonWorkOrderStore(config.dataDir));
  const rosterStore =
    options.rosterStore ??
    (kv ? new KvRosterStore(kv) : new JsonRosterStore(config.dataDir));
  const inventoryCountsStore =
    options.inventoryCountsStore ??
    (kv
      ? new KvInventoryCountsStore(kv)
      : new JsonInventoryCountsStore(config.dataDir));
  const meetingStore =
    options.meetingStore ??
    (kv ? new KvMeetingStore(kv) : new JsonMeetingStore(config.dataDir));
  const inventoryStore =
    options.inventoryStore ??
    (kv ? new KvInventoryStore(kv) : new JsonInventoryStore(config.dataDir));
  const snapshotStore =
    options.snapshotStore ??
    (kv ? new KvSnapshotStore(kv) : new JsonSnapshotStore(config.dataDir));
  const leadsStore =
    options.leadsStore ??
    (kv ? new KvLeadsStore(kv) : new JsonLeadsStore(config.dataDir));

  const provider = options.provider ?? resolveProvider(config, now, pipelineStore);

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
    now,
    workOrderStore,
    pipelineStore
  );

  const app = express();
  // Pipeline uploads post the raw spreadsheet grid as JSON, so allow some room.
  app.use(express.json({ limit: "16mb" }));

  const live = hasLiveCredentials(config);

  // Non-sensitive runtime info for the UI (never includes the API key).
  app.get(
    "/api/config",
    asyncHandler(async (_req, res) => {
      const pipeline = live ? null : await pipelineStore.get();
      const source = live ? "live" : pipeline ? "pipeline" : "sample";
      res.json({
        source,
        usingSampleData: source === "sample",
        laborMultiplier: config.laborMultiplier,
        weekStartDay: config.weekStartDay,
        scopedToManager: Boolean(config.productionManagerId),
        coverage: config.coverage,
        durableStorage: durable,
        // True on serverless with no KV: uploads/edits live in one instance's
        // /tmp and are NOT shared across devices or requests.
        ephemeralStorage: !durable && config.dataDir.startsWith("/tmp"),
      });
    })
  );

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  const meetingService = new MeetingService(
    meetingStore,
    workOrderStore,
    provider,
    config,
    now,
    pipelineStore
  );

  app.use("/api", pipelineRouter(pipelineStore, now, config.customFields, workOrderStore));
  app.use("/api", meetingRouter(meetingService));
  app.use("/api", stagingRouter(scheduleService, inventoryStore, now, scheduleStore));
  app.use("/api", leadsRouter(leadsStore, now, config.weekStartDay, pipelineStore));
  app.use(
    "/api",
    snapshotRouter(
      meetingService,
      scheduleService,
      inventoryStore,
      snapshotStore,
      now,
      leadsStore
    )
  );
  app.use("/api", workOrdersRouter(workOrderStore, now));
  app.use("/api", rosterRouter(rosterStore, now));
  app.use("/api", inventoryCountsRouter(inventoryCountsStore, config.weekStartDay, now));
  app.use("/api", payRouter(scheduleService, rosterStore));
  app.use("/api", scheduleRouter(scheduleService));
  app.use("/api", reportsRouter(reportService));
  app.use("/api", projectsRouter(projectsService));

  app.use(express.static(PUBLIC_DIR));
  // SPA fallback for any non-API GET.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  app.use(errorMiddleware);

  return { app, usingSampleData: provider.isSample, usingDurableStorage: durable };
}

/**
 * Default export: the production app built from the environment.
 *
 * Vercel auto-detects Express projects and, unless the framework preset is
 * disabled, compiles THIS file as the serverless entry and requires its default
 * export to be the app ("Invalid export found in module … The default export
 * must be a function or server" otherwise). vercel.json sets "framework": null
 * to turn that off, but this export makes the repo deploy correctly under
 * either behavior. Building it is side-effect-free (no listen, no I/O).
 */
const productionApp = buildApp({ config: loadConfig() }).app;
export default productionApp;
