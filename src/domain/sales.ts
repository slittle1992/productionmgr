import { PipelineFormatError, toMs, type RawGrid } from "./pipeline.js";
import type { CompactLead } from "./leads.js";
import { getReportingWeek, type ReportingWeek } from "./week.js";

/**
 * Sales-side exports for the Leads-by-area section:
 *
 *  - "Total Sales (Contracts)" detail — one row per sold contract with the
 *    sales person, client, project type (Concrete vs Rubber Coating), sale
 *    date, and net sale amount. Powers NSLI dollars, weekly sold trend, and
 *    the rubber/flake mix. No zip on the export — sold rows join to the
 *    Clients List by client name for area rollups.
 *
 *  - "Lead Performance Summary" (by Sales Person) — the true funnel per rep:
 *    Leads Issued, Demos, Jobs Sold. Close rate = sold ÷ issued, NSLI =
 *    net sold $ ÷ issued, matching Builder Prime's own definitions.
 */

export interface SoldContract {
  rep: string | null;
  contractNumber: string | null;
  client: string | null;
  /** Lower-cased client name for joining to leads. */
  clientKey: string | null;
  projectType: string | null;
  jobNumber: string | null;
  status: string | null;
  saleMs: number | null;
  /** Net of discounts ("Sale Amount"). */
  saleAmount: number;
}

export interface SoldParseResult {
  rows: SoldContract[];
  sourceLabel: string | null;
}

export interface RepFunnel {
  rep: string;
  opportunities: number;
  issued: number;
  demos: number;
  sold: number;
}

export interface PerfParseResult {
  byRep: RepFunnel[];
  /** Report range parsed from the title ("From 05/18/2026 To 08/18/2026"). */
  fromMs: number | null;
  toMs: number | null;
  sourceLabel: string | null;
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

export const nameKey = (s: string | null): string | null =>
  s ? s.toLowerCase().replace(/\s+/g, " ").trim() : null;

function findHeader(
  grid: RawGrid,
  required: string[]
): { row: number; cols: Record<string, number> } | null {
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const lower = Array.from(grid[r] ?? [], (c) => text(c)?.toLowerCase() ?? "");
    if (required.every((h) => lower.includes(h))) {
      const cols: Record<string, number> = {};
      lower.forEach((c, i) => {
        if (c && cols[c] === undefined) cols[c] = i;
      });
      return { row: r, cols };
    }
  }
  return null;
}

function sourceLabelOf(grid: RawGrid): string | null {
  for (const row of grid.slice(0, 4)) {
    const t = text((row ?? []).find((c) => text(c)));
    if (t && /data as of|from \d|between \d/i.test(t)) return t;
  }
  return null;
}

/** Parse the "Total Sales (Contracts)" detail export. */
export function parseSoldContracts(grid: RawGrid): SoldParseResult {
  const h = findHeader(grid, ["sales person", "sale date", "sale amount"]);
  if (!h) {
    throw new PipelineFormatError(
      "Couldn't read that file — expected the Total Sales (Contracts) detail " +
        "export with Sales Person, Sale Date, and Sale Amount columns."
    );
  }
  const cell = (row: unknown[], name: string) =>
    h.cols[name] === undefined ? undefined : row[h.cols[name]!];
  const rows: SoldContract[] = [];
  for (let r = h.row + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const saleMs = toMs(cell(row, "sale date")) ?? null;
    const client = text(cell(row, "client"));
    const saleAmount = num(cell(row, "sale amount"));
    if (saleMs === null && !client) continue;
    rows.push({
      rep: text(cell(row, "sales person")),
      contractNumber: text(cell(row, "contract #")),
      client,
      clientKey: nameKey(client),
      projectType: text(cell(row, "project type")),
      jobNumber: text(cell(row, "job #")),
      status: text(cell(row, "project status")),
      saleMs,
      saleAmount: r2(saleAmount),
    });
  }
  if (!rows.length) {
    throw new PipelineFormatError("No contract rows found in that file.");
  }
  return { rows, sourceLabel: sourceLabelOf(grid) };
}

/** Parse the "Lead Performance Summary" by Sales Person export. */
export function parseLeadPerformance(grid: RawGrid): PerfParseResult {
  const bySource = findHeader(grid, ["lead source", "leads issued"]);
  const h = findHeader(grid, ["sales person", "leads issued", "jobs sold"]);
  if (!h) {
    throw new PipelineFormatError(
      bySource
        ? "That's the Lead Performance report grouped by LEAD SOURCE — export " +
          "the version grouped by Sales Person instead."
        : "Couldn't read that file — expected the Lead Performance Summary " +
          "with Sales Person, Leads Issued, and Jobs Sold columns."
    );
  }
  const cell = (row: unknown[], name: string) =>
    h.cols[name] === undefined ? undefined : row[h.cols[name]!];
  const byRep: RepFunnel[] = [];
  for (let r = h.row + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const rep = text(cell(row, "sales person"));
    // Skip BP's own rollup rows — the UI computes its own company footer.
    if (!rep || /^(total|company)$/i.test(rep)) continue;
    byRep.push({
      rep,
      opportunities: num(cell(row, "opportunities created")),
      issued: num(cell(row, "leads issued")),
      demos: num(cell(row, "demos")),
      sold: num(cell(row, "jobs sold")),
    });
  }
  if (!byRep.length) {
    throw new PipelineFormatError("No sales-person rows found in that file.");
  }

  let fromMs: number | null = null;
  let toMs_: number | null = null;
  const label = sourceLabelOf(grid);
  const range = label?.match(
    /from\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{4})/i
  );
  if (range) {
    const parse = (s: string) => {
      const [m, d, y] = s.split("/").map(Number);
      return Date.UTC(y!, m! - 1, d!);
    };
    fromMs = parse(range[1]!);
    toMs_ = parse(range[2]!);
  }
  return { byRep, fromMs, toMs: toMs_, sourceLabel: label };
}

// ───────────────────── Rep scorecard (close rate + NSLI) ─────────────────────

export interface RepScoreRow {
  rep: string;
  issued: number;
  demos: number;
  sold: number;
  /** sold ÷ issued. */
  closeRate: number | null;
  /** Net sold $ within the performance report's range. */
  net: number;
  /** net ÷ issued. */
  nsli: number | null;
}

const CANCELLED_RE = /cancel/i;

export function computeRepScorecard(
  perf: PerfParseResult,
  sold: SoldContract[]
): RepScoreRow[] {
  const netByRep = new Map<string, number>();
  for (const s of sold) {
    if (!s.rep || (s.status && CANCELLED_RE.test(s.status))) continue;
    if (perf.fromMs !== null && s.saleMs !== null && s.saleMs < perf.fromMs) continue;
    if (perf.toMs !== null && s.saleMs !== null && s.saleMs >= perf.toMs + 86400000)
      continue;
    const key = nameKey(s.rep)!;
    netByRep.set(key, (netByRep.get(key) ?? 0) + s.saleAmount);
  }
  return perf.byRep
    .map((p) => {
      const net = r2(netByRep.get(nameKey(p.rep)!) ?? 0);
      return {
        rep: p.rep,
        issued: p.issued,
        demos: p.demos,
        sold: p.sold,
        closeRate: p.issued > 0 ? p.sold / p.issued : null,
        net,
        nsli: p.issued > 0 ? r2(net / p.issued) : null,
      };
    })
    .sort((a, b) => (b.nsli ?? -1) - (a.nsli ?? -1));
}

// ───────────────────── Weekly flow (leads + sold, with YoY) ─────────────────────

export interface WeeklyFlowWeek {
  weekStart: string;
  leads: number;
  /** Leads created the same week one year (52 weeks) earlier. */
  leadsLastYear: number;
  soldCount: number;
  soldNet: number;
  rubberNet: number;
  flakeNet: number;
  /** Per-location lead counts for the week. */
  byClass: Record<string, number>;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function computeWeeklyFlow(
  leads: CompactLead[],
  sold: SoldContract[],
  weekStartDay: number,
  nowMs: number,
  weeks = 8
): WeeklyFlowWeek[] {
  const current = getReportingWeek(nowMs, weekStartDay);
  const starts: ReportingWeek[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    starts.push(getReportingWeek(current.startMs - i * WEEK_MS, weekStartDay));
  }

  const leadWeek = new Map<number, { total: number; byClass: Record<string, number> }>();
  for (const l of leads) {
    const ws = getReportingWeek(l.created, weekStartDay).startMs;
    const slot = leadWeek.get(ws) ?? { total: 0, byClass: {} };
    slot.total++;
    slot.byClass[l.className] = (slot.byClass[l.className] ?? 0) + 1;
    leadWeek.set(ws, slot);
  }

  const soldWeek = new Map<
    number,
    { count: number; net: number; rubber: number; flake: number }
  >();
  for (const s of sold) {
    if (s.saleMs === null || (s.status && CANCELLED_RE.test(s.status))) continue;
    const ws = getReportingWeek(s.saleMs, weekStartDay).startMs;
    const slot = soldWeek.get(ws) ?? { count: 0, net: 0, rubber: 0, flake: 0 };
    slot.count++;
    slot.net += s.saleAmount;
    if (/rubber/i.test(s.projectType ?? "")) slot.rubber += s.saleAmount;
    else slot.flake += s.saleAmount;
    soldWeek.set(ws, slot);
  }

  return starts.map((w) => {
    const lw = leadWeek.get(w.startMs);
    const ly = leadWeek.get(w.startMs - 52 * WEEK_MS);
    const sw = soldWeek.get(w.startMs);
    return {
      weekStart: w.weekStart,
      leads: lw?.total ?? 0,
      leadsLastYear: ly?.total ?? 0,
      soldCount: sw?.count ?? 0,
      soldNet: r2(sw?.net ?? 0),
      rubberNet: r2(sw?.rubber ?? 0),
      flakeNet: r2(sw?.flake ?? 0),
      byClass: lw?.byClass ?? {},
    };
  });
}

// ───────────────────── Area (zip-cluster) sales via name join ─────────────────────

export interface ClusterSales {
  net: number;
  soldCount: number;
}

/**
 * Join sold contracts to leads by client name → zip cluster (first 3 digits)
 * per location. Returns `${className}|${cluster}` → sales, plus the join rate
 * so the UI can say how complete the area picture is.
 */
export function salesByCluster(
  leads: CompactLead[],
  sold: SoldContract[],
  windowFromMs: number,
  windowToMs: number
): { clusters: Record<string, ClusterSales>; joined: number; total: number } {
  const leadByName = new Map<string, CompactLead>();
  for (const l of leads) {
    if (l.name) leadByName.set(l.name, l);
  }
  const clusters: Record<string, ClusterSales> = {};
  let joined = 0;
  let total = 0;
  for (const s of sold) {
    if (s.saleMs === null || s.saleMs < windowFromMs || s.saleMs >= windowToMs)
      continue;
    if (s.status && CANCELLED_RE.test(s.status)) continue;
    total++;
    const lead = s.clientKey ? leadByName.get(s.clientKey) : undefined;
    if (!lead || lead.zip === "?") continue;
    joined++;
    const key = `${lead.className}|${lead.zip.slice(0, 3)}`;
    const c = (clusters[key] ??= { net: 0, soldCount: 0 });
    c.net = r2(c.net + s.saleAmount);
    c.soldCount++;
  }
  return { clusters, joined, total };
}
