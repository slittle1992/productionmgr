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

/** SQFT-driven material coverage rates (gallons = sqft / divisor; flake = sqft * lbsPerSqft). */
export interface CoverageRates {
  basecoatADivisor: number;
  basecoatBDivisor: number;
  topcoatADivisor: number;
  topcoatBDivisor: number;
  flakeLbsPerSqft: number;
}

/** Names of the Builder Prime custom fields the schedule reads from. */
export interface CustomFieldNames {
  sqft: string[];
  color: string[];
  projectType: string[];
  jobNumber: string[];
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
  coverage: CoverageRates;
  customFields: CustomFieldNames;
  kv: {
    url: string | null;
    token: string | null;
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
      basecoatADivisor: num(env.COVERAGE_BASECOAT_A_DIVISOR, 315),
      basecoatBDivisor: num(env.COVERAGE_BASECOAT_B_DIVISOR, 630),
      topcoatADivisor: num(env.COVERAGE_TOPCOAT_A_DIVISOR, 330),
      topcoatBDivisor: num(env.COVERAGE_TOPCOAT_B_DIVISOR, 330),
      flakeLbsPerSqft: num(env.COVERAGE_FLAKE_LBS_PER_SQFT, 0.125),
    },
    customFields: {
      sqft: list(env.BP_FIELD_SQFT, ["SQFT", "Square Footage", "Sq Ft"]),
      color: list(env.BP_FIELD_COLOR, ["Flake Color", "Flake/Rubber Color", "Color"]),
      projectType: list(env.BP_FIELD_PROJECT_TYPE, ["Project Type", "Job Type", "Type"]),
      jobNumber: list(env.BP_FIELD_JOB_NUMBER, ["Job Number", "Job #", "Job No"]),
    },
    kv: {
      // Accept Vercel KV's env names or Upstash's directly.
      url: env.KV_REST_API_URL?.trim() || env.UPSTASH_REDIS_REST_URL?.trim() || null,
      token: env.KV_REST_API_TOKEN?.trim() || env.UPSTASH_REDIS_REST_TOKEN?.trim() || null,
    },
  };
}

/** True when a durable KV store (Vercel KV / Upstash) is configured. */
export function hasDurableStorage(config: AppConfig): boolean {
  return Boolean(config.kv.url && config.kv.token);
}

/** True when we have real Builder Prime credentials to talk to the live API. */
export function hasLiveCredentials(config: AppConfig): boolean {
  return Boolean(config.builderPrime.subdomain && config.builderPrime.apiKey);
}
