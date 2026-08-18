import { cleanClassName, toMs, type RawGrid } from "./pipeline.js";
import { PipelineFormatError } from "./pipeline.js";

/**
 * Leads-by-area analysis from the Builder Prime "Clients List" export.
 *
 * Meeting question: where are leads coming from, per location — and within a
 * location, per ZIP cluster (first 3 digits ≈ a metro area: 752xx Dallas,
 * 761xx Fort Worth). Comparing the current window against the equal window
 * before it shows movement ("leads shifting toward Dallas, away from Fort
 * Worth"); all-time sold counts per zip expose areas that generate leads but
 * never buy.
 */

export type LeadCategory = "sold" | "dead" | "open";

export interface CompactLead {
  /** 5-digit zip ("?" when missing). */
  zip: string;
  className: string;
  city: string | null;
  created: number;
  cat: LeadCategory;
  /** Normalised client name — joins sold contracts to areas (may be absent
   * on uploads stored before this field existed). */
  name?: string | null;
}

/** Statuses that count as a sale for conversion purposes. */
const SOLD_RE = /SOLD|COMPLETED|JOB IN PROGRESS/i;
const DEAD_RE =
  /NOT INTERESTED|BAD LEAD|DEAD END|WRONG|CAN'T PERFORM|NO DEMO|OUT OF AREA|NON-ISSUED/i;

export function categorize(status: string | null): LeadCategory {
  if (!status) return "open";
  if (SOLD_RE.test(status)) return "sold";
  if (DEAD_RE.test(status)) return "dead";
  return "open";
}

const HEADERS: Record<string, string[]> = {
  name: ["name", "client", "customer"],
  state: ["state"],
  city: ["city"],
  zip: ["zip", "zip code", "zipcode"],
  className: ["class"],
  created: ["created"],
  status: ["lead status", "status"],
};

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export interface LeadsParseResult {
  leads: CompactLead[];
  sourceLabel: string | null;
}

export function parseClientsExport(grid: RawGrid): LeadsParseResult {
  if (!Array.isArray(grid)) {
    throw new PipelineFormatError("Leads data must be a grid of rows.");
  }

  let headerRow = -1;
  const col: Record<string, number> = {};
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const lower = (grid[r] ?? []).map((c) => text(c)?.toLowerCase() ?? "");
    if (
      lower.some((c) => HEADERS.status!.includes(c)) &&
      lower.some((c) => HEADERS.zip!.includes(c))
    ) {
      headerRow = r;
      for (const [key, names] of Object.entries(HEADERS)) {
        col[key] = lower.findIndex((c) => names.includes(c));
      }
      break;
    }
  }
  if (headerRow < 0) {
    throw new PipelineFormatError(
      "Couldn't find the leads header row (expected 'Zip' and 'Lead Status' " +
        "columns). Make sure you uploaded the Clients List export."
    );
  }

  let sourceLabel: string | null = null;
  for (let r = 0; r < headerRow; r++) {
    for (const c of grid[r] ?? []) {
      const t = text(c);
      if (t && /\bas of\b/i.test(t)) sourceLabel = t;
    }
  }

  const cell = (row: unknown[], key: string) =>
    col[key]! >= 0 ? row[col[key]!] : undefined;

  const leads: CompactLead[] = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const name = text(cell(row, "name"));
    const created = toMs(cell(row, "created"));
    if (!name || created === undefined) continue;
    const zipRaw = text(cell(row, "zip"));
    const zip = zipRaw ? zipRaw.replace(/[^0-9]/g, "").slice(0, 5) : "";
    leads.push({
      zip: zip.length === 5 ? zip : "?",
      className: cleanClassName(text(cell(row, "className"))),
      city: text(cell(row, "city")),
      created,
      cat: categorize(text(cell(row, "status"))),
      name: name.toLowerCase().replace(/\s+/g, " ").trim(),
    });
  }
  return { leads, sourceLabel };
}

// ───────────────────────── Analysis ─────────────────────────

export interface ZipStat {
  zip: string;
  city: string | null;
  current: number;
  previous: number;
  allTime: number;
  soldAllTime: number;
}

export interface ClusterStat {
  /** zip3 prefix, e.g. "761". */
  cluster: string;
  /** Most common cities in the cluster, for a human label. */
  cities: string[];
  current: number;
  previous: number;
  /** Share of the class's current-window leads (0–1). */
  shareCurrent: number;
  sharePrevious: number;
  /** Percentage-point shift of share (positive = leads moving toward here). */
  shareShiftPts: number;
  allTime: number;
  soldAllTime: number;
  /** All-time conversion of this cluster's leads (0–1). */
  conversion: number;
  zips: ZipStat[];
}

export interface NeverSellZip {
  zip: string;
  city: string | null;
  allTime: number;
  recent: number;
}

export interface ClassLeads {
  className: string;
  current: number;
  previous: number;
  soldCurrentCohort: number;
  clusters: ClusterStat[];
  /** Clusters gaining/losing share fastest (movement summary). */
  gaining: ClusterStat[];
  fading: ClusterStat[];
  /** Zips with real lead volume and ZERO sales ever. */
  neverSells: NeverSellZip[];
}

export interface LeadsAnalysis {
  windowDays: number;
  /** ISO dates of the current window [from, to). */
  from: string;
  to: string;
  totalLeads: number;
  classes: ClassLeads[];
}

const NEVER_SELL_MIN = 10;
const MAX_CLUSTERS = 12;
const MAX_ZIPS = 10;
const MAX_NEVER = 12;

// ── Full per-zip table (heat map + drill-down; nothing capped) ──

export interface ZipTableRow {
  zip: string;
  city: string | null;
  /** Leads created in the selected window / the equal window before it. */
  current: number;
  previous: number;
  allTime: number;
  /** Sold (jobs), all time. */
  jobs: number;
  /** All-time conversion 0–1; null under 10 leads (not enough data). */
  conversion: number | null;
}

export interface ZipTableClass {
  className: string;
  rows: ZipTableRow[];
  totals: { current: number; previous: number; allTime: number; jobs: number };
}

export interface ZipTable {
  windowDays: number;
  from: string;
  to: string;
  classes: ZipTableClass[];
}

/** Every zip for every location — the data behind the heat map + zip table. */
export function buildZipTable(
  leads: CompactLead[],
  nowMs: number,
  windowDays: number
): ZipTable {
  const DAY = 86_400_000;
  const curFrom = nowMs - windowDays * DAY;
  const prevFrom = nowMs - 2 * windowDays * DAY;

  interface Acc {
    current: number;
    previous: number;
    allTime: number;
    jobs: number;
    cities: Map<string, number>;
  }
  const byClass = new Map<string, Map<string, Acc>>();
  for (const l of leads) {
    const cls = l.className || "Unassigned";
    let zips = byClass.get(cls);
    if (!zips) {
      zips = new Map();
      byClass.set(cls, zips);
    }
    let a = zips.get(l.zip);
    if (!a) {
      a = { current: 0, previous: 0, allTime: 0, jobs: 0, cities: new Map() };
      zips.set(l.zip, a);
    }
    a.allTime++;
    if (l.cat === "sold") a.jobs++;
    if (l.city) a.cities.set(l.city, (a.cities.get(l.city) ?? 0) + 1);
    if (l.created >= curFrom && l.created < nowMs + DAY) a.current++;
    else if (l.created >= prevFrom && l.created < curFrom) a.previous++;
  }

  const classes: ZipTableClass[] = [...byClass.entries()].map(([className, zips]) => {
    const rows: ZipTableRow[] = [...zips.entries()].map(([zip, a]) => ({
      zip,
      city: [...a.cities.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
      current: a.current,
      previous: a.previous,
      allTime: a.allTime,
      jobs: a.jobs,
      conversion: a.allTime >= NEVER_SELL_MIN ? a.jobs / a.allTime : null,
    }));
    rows.sort((a, b) => b.current - a.current || b.allTime - a.allTime);
    return {
      className,
      rows,
      totals: {
        current: rows.reduce((s, r) => s + r.current, 0),
        previous: rows.reduce((s, r) => s + r.previous, 0),
        allTime: rows.reduce((s, r) => s + r.allTime, 0),
        jobs: rows.reduce((s, r) => s + r.jobs, 0),
      },
    };
  });
  classes.sort((a, b) => b.totals.current - a.totals.current);

  return {
    windowDays,
    from: new Date(curFrom).toISOString().slice(0, 10),
    to: new Date(nowMs).toISOString().slice(0, 10),
    classes,
  };
}

export function buildLeadsAnalysis(
  leads: CompactLead[],
  nowMs: number,
  windowDays: number
): LeadsAnalysis {
  const DAY = 86_400_000;
  const curFrom = nowMs - windowDays * DAY;
  const prevFrom = nowMs - 2 * windowDays * DAY;

  interface ZipAcc {
    allTime: number;
    soldAllTime: number;
    current: number;
    previous: number;
    cities: Map<string, number>;
  }
  const byClass = new Map<string, Map<string, ZipAcc>>();
  const classCur = new Map<string, number>();
  const classPrev = new Map<string, number>();
  const classSoldCohort = new Map<string, number>();

  for (const l of leads) {
    const cls = l.className || "Unassigned";
    let zips = byClass.get(cls);
    if (!zips) {
      zips = new Map();
      byClass.set(cls, zips);
    }
    let z = zips.get(l.zip);
    if (!z) {
      z = { allTime: 0, soldAllTime: 0, current: 0, previous: 0, cities: new Map() };
      zips.set(l.zip, z);
    }
    z.allTime++;
    if (l.cat === "sold") z.soldAllTime++;
    if (l.city) z.cities.set(l.city, (z.cities.get(l.city) ?? 0) + 1);
    if (l.created >= curFrom && l.created < nowMs + DAY) {
      z.current++;
      classCur.set(cls, (classCur.get(cls) ?? 0) + 1);
      if (l.cat === "sold") {
        classSoldCohort.set(cls, (classSoldCohort.get(cls) ?? 0) + 1);
      }
    } else if (l.created >= prevFrom && l.created < curFrom) {
      z.previous++;
      classPrev.set(cls, (classPrev.get(cls) ?? 0) + 1);
    }
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const classes: ClassLeads[] = [];

  for (const [className, zips] of byClass) {
    const current = classCur.get(className) ?? 0;
    const previous = classPrev.get(className) ?? 0;

    // Roll zips up into zip3 clusters.
    interface ClusterAcc extends Omit<ClusterStat, "cities" | "zips"> {
      cities: Map<string, number>;
      zipStats: ZipStat[];
    }
    const clusters = new Map<string, ClusterAcc>();
    const neverSells: NeverSellZip[] = [];

    for (const [zip, z] of zips) {
      const key = zip === "?" ? "?" : zip.slice(0, 3);
      let c = clusters.get(key);
      if (!c) {
        c = {
          cluster: key,
          current: 0,
          previous: 0,
          shareCurrent: 0,
          sharePrevious: 0,
          shareShiftPts: 0,
          allTime: 0,
          soldAllTime: 0,
          conversion: 0,
          cities: new Map(),
          zipStats: [],
        };
        clusters.set(key, c);
      }
      c.current += z.current;
      c.previous += z.previous;
      c.allTime += z.allTime;
      c.soldAllTime += z.soldAllTime;
      for (const [city, n] of z.cities) c.cities.set(city, (c.cities.get(city) ?? 0) + n);
      const topCity =
        [...z.cities.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      c.zipStats.push({
        zip,
        city: topCity,
        current: z.current,
        previous: z.previous,
        allTime: z.allTime,
        soldAllTime: z.soldAllTime,
      });

      if (zip !== "?" && z.allTime >= NEVER_SELL_MIN && z.soldAllTime === 0) {
        neverSells.push({ zip, city: topCity, allTime: z.allTime, recent: z.current });
      }
    }

    const clusterList: ClusterStat[] = [...clusters.values()].map((c) => {
      const shareCurrent = current > 0 ? c.current / current : 0;
      const sharePrevious = previous > 0 ? c.previous / previous : 0;
      return {
        cluster: c.cluster,
        cities: [...c.cities.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([city]) => city),
        current: c.current,
        previous: c.previous,
        shareCurrent,
        sharePrevious,
        shareShiftPts: round1((shareCurrent - sharePrevious) * 100),
        allTime: c.allTime,
        soldAllTime: c.soldAllTime,
        conversion: c.allTime > 0 ? c.soldAllTime / c.allTime : 0,
        zips: c.zipStats
          .sort((a, b) => b.current - a.current || b.allTime - a.allTime)
          .slice(0, MAX_ZIPS),
      };
    });

    // Movement: only clusters with enough volume to mean anything.
    const meaningful = clusterList.filter((c) => c.current + c.previous >= 3);
    const byShift = [...meaningful].sort((a, b) => b.shareShiftPts - a.shareShiftPts);

    classes.push({
      className,
      current,
      previous,
      soldCurrentCohort: classSoldCohort.get(className) ?? 0,
      clusters: clusterList
        .sort((a, b) => b.current - a.current || b.allTime - a.allTime)
        .slice(0, MAX_CLUSTERS),
      gaining: byShift.filter((c) => c.shareShiftPts > 0).slice(0, 3),
      fading: byShift.filter((c) => c.shareShiftPts < 0).slice(-3).reverse(),
      neverSells: neverSells
        .sort((a, b) => b.allTime - a.allTime)
        .slice(0, MAX_NEVER),
    });
  }

  classes.sort((a, b) => b.current - a.current);
  return {
    windowDays,
    from: new Date(curFrom).toISOString().slice(0, 10),
    to: new Date(nowMs).toISOString().slice(0, 10),
    totalLeads: leads.length,
    classes,
  };
}
