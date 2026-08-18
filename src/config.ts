/**
 * Centralised configuration loaded from the environment.
 *
 * The Builder Prime key is read here, on the server, and never exposed to any
 * client-facing route or payload (see §10 of the requirements).
 */

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

/** SQFT-driven material rates for flake/concrete coating. */
export interface FlakeRates {
  /** Pounds of flake per sqft (0.15 → sqft × 0.15 = lbs). */
  flakeLbsPerSqft: number;
  /** Pounds per box of flake (40 lb boxes). */
  flakeBoxLbs: number;
  /** Sqft covered by one TOTAL gallon of polyurea basecoat (A+B combined). */
  polyureaSqftPerGallon: number;
  /** Polyurea mix ratio — 2 parts A to 1 part B. */
  polyureaPartsA: number;
  polyureaPartsB: number;
  /** Sqft covered by one TOTAL gallon of polyaspartic topcoat (equal parts A/B). */
  polyasparticSqftPerGallon: number;
}

/** SQFT-per-unit rates for rubber coating (units = sqft / sqftPerUnit). */
export interface RubberRates {
  /** Sqft covered by one 50 lb bag of rubber granules. */
  sqftPerBag: number;
  /** Sqft covered by one 5-gallon bucket of binder. */
  sqftPerBinderBucket: number;
  /** Sqft covered by one 5-gallon bucket of primer. */
  sqftPerPrimerBucket: number;
}

/** Material rates by coating type — rubber uses different products and ratios. */
export interface CoverageConfig {
  flake: FlakeRates;
  rubber: RubberRates;
}

/** Names of the Builder Prime custom fields the schedule reads from. */
export interface CustomFieldNames {
  sqft: string[];
  color: string[];
  projectType: string[];
  jobNumber: string[];
  crew: string[];
}

export interface AppConfig {
  port: number;
  dataDir: string;
  laborMultiplier: number;
  weekStartDay: number;
  productionManagerId: string | null;
  builderPrime: {
    subdomain: string | null;
    apiKey: string | null;
  };
  allowSampleData: boolean;
  coverage: CoverageConfig;
  customFields: CustomFieldNames;
  kv: {
    url: string | null;
    token: string | null;
  };
  /** Neon Postgres connection string (preferred durable store). */
  databaseUrl: string | null;
  /** Dashboard links surfaced on the Friday-meeting checklist. */
  meetingLinks: {
    reviews: string | null;
    lytx: string | null;
    ramp: string | null;
  };
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value || value.trim() === "") return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const subdomain = env.BUILDER_PRIME_SUBDOMAIN?.trim() || null;
  const apiKey = env.BUILDER_PRIME_API_KEY?.trim() || null;
  const pmId = env.PRODUCTION_MANAGER_ID?.trim() || null;

  // On serverless platforms (Vercel) the project filesystem is read-only; only
  // /tmp is writable. Fall back there so saves don't crash. NOTE: /tmp is
  // ephemeral and per-instance — see README for durable-storage options.
  const defaultDataDir = env.VERCEL ? "/tmp/productionmgr-data" : "./data";

  return {
    port: num(env.PORT, 3000),
    dataDir: env.DATA_DIR?.trim() || defaultDataDir,
    laborMultiplier: num(env.LABOR_MULTIPLIER, 1.2),
    weekStartDay: Math.min(6, Math.max(0, num(env.REPORTING_WEEK_START_DAY, 0))),
    productionManagerId: pmId,
    builderPrime: { subdomain, apiKey },
    allowSampleData: bool(env.ALLOW_SAMPLE_DATA, true),
    coverage: {
      flake: {
        flakeLbsPerSqft: num(env.FLAKE_LBS_PER_SQFT, 0.15),
        flakeBoxLbs: num(env.FLAKE_BOX_LBS, 40),
        polyureaSqftPerGallon: num(env.POLYUREA_SQFT_PER_GALLON, 200),
        polyureaPartsA: num(env.POLYUREA_PARTS_A, 2),
        polyureaPartsB: num(env.POLYUREA_PARTS_B, 1),
        polyasparticSqftPerGallon: num(env.POLYASPARTIC_SQFT_PER_GALLON, 130),
      },
      rubber: {
        sqftPerBag: num(env.RUBBER_SQFT_PER_BAG, 30),
        sqftPerBinderBucket: num(env.RUBBER_SQFT_PER_BINDER_BUCKET, 160),
        sqftPerPrimerBucket: num(env.RUBBER_SQFT_PER_PRIMER_BUCKET, 700),
      },
    },
    customFields: {
      sqft: list(env.BP_FIELD_SQFT, ["SQFT", "Square Footage", "Sq Ft"]),
      color: list(env.BP_FIELD_COLOR, ["Flake Color", "Flake/Rubber Color", "Color"]),
      projectType: list(env.BP_FIELD_PROJECT_TYPE, ["Project Type", "Job Type", "Type"]),
      jobNumber: list(env.BP_FIELD_JOB_NUMBER, ["Job Number", "Job #", "Job No"]),
      crew: list(env.BP_FIELD_CREW, ["Crew", "Team", "Trailer"]),
    },
    kv: {
      // Accept Vercel KV's env names or Upstash's directly.
      url: env.KV_REST_API_URL?.trim() || env.UPSTASH_REDIS_REST_URL?.trim() || null,
      token: env.KV_REST_API_TOKEN?.trim() || env.UPSTASH_REDIS_REST_TOKEN?.trim() || null,
    },
    // Neon (or any Postgres) — Vercel's Neon integration injects DATABASE_URL.
    databaseUrl:
      env.DATABASE_URL?.trim() ||
      env.NEON_DATABASE_URL?.trim() ||
      env.POSTGRES_URL?.trim() ||
      null,
    meetingLinks: {
      reviews: env.REVIEWS_DASHBOARD_URL?.trim() || null,
      lytx: env.LYTX_DASHBOARD_URL?.trim() || "https://user.lytx.com",
      ramp: env.RAMP_DASHBOARD_URL?.trim() || "https://app.ramp.com",
    },
  };
}

/** True when a durable store (Neon Postgres or Vercel KV / Upstash) is configured. */
export function hasDurableStorage(config: AppConfig): boolean {
  return Boolean(config.databaseUrl || (config.kv.url && config.kv.token));
}

/** True when we have real Builder Prime credentials to talk to the live API. */
export function hasLiveCredentials(config: AppConfig): boolean {
  return Boolean(config.builderPrime.subdomain && config.builderPrime.apiKey);
}
