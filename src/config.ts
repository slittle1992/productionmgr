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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const subdomain = env.BUILDER_PRIME_SUBDOMAIN?.trim() || null;
  const apiKey = env.BUILDER_PRIME_API_KEY?.trim() || null;
  const pmId = env.PRODUCTION_MANAGER_ID?.trim() || null;

  return {
    port: num(env.PORT, 3000),
    dataDir: env.DATA_DIR?.trim() || "./data",
    laborMultiplier: num(env.LABOR_MULTIPLIER, 1.2),
    weekStartDay: Math.min(6, Math.max(0, num(env.REPORTING_WEEK_START_DAY, 0))),
    productionManagerId: pmId,
    builderPrime: { subdomain, apiKey },
    allowSampleData: bool(env.ALLOW_SAMPLE_DATA, true),
  };
}

/** True when we have real Builder Prime credentials to talk to the live API. */
export function hasLiveCredentials(config: AppConfig): boolean {
  return Boolean(config.builderPrime.subdomain && config.builderPrime.apiKey);
}
