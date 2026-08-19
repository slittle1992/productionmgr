import { projectTypeOf } from "./leads.js";
import { PipelineFormatError, type RawGrid } from "./pipeline.js";

/**
 * The Builder Prime "Meetings" export — one row per calendar entry for the
 * week. Real appointments have a Client; blockers (OFF, DO NOT SCHEDULE,
 * UNAVAILABLE, TRAINING…) don't and are skipped. A cancelled appointment
 * carries "Cancelled" in the Meeting Status column. The report title pins the
 * week: "Meetings Between 08/09/2026 and 08/15/2026".
 */

export interface RepAppointments {
  rep: string;
  total: number;
  cancelled: number;
}

/** A demo that didn't sell — the daily rehash call list. */
export interface NoSaleRow {
  client: string;
  phone: string | null;
  rep: string | null;
  status: string;
  projectType: string | null;
}

/** total / cancelled / flake / rubber. */
export interface ApptCounts {
  t: number;
  c: number;
  f: number;
  r: number;
}

/** One day's appointments, split by zip3 (→ market) and by rep. */
export interface ApptDay extends ApptCounts {
  byZip3: Record<string, ApptCounts>;
  byRep: Record<string, ApptCounts>;
}

export interface MeetingsParseResult {
  fromMs: number | null;
  toMs: number | null;
  sourceLabel: string | null;
  total: number;
  cancelled: number;
  byRep: RepAppointments[];
  /** Appointments per zip3 prefix (from the title's trailing zip) — the
   * server joins these to markets via the leads upload. */
  byZip3: Record<string, { t: number; c: number }>;
  /** Per-day counts keyed by ISO date (from each meeting's Start). */
  days: Record<string, ApptDay>;
  noSales: NoSaleRow[];
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

const CANCELLED_RE = /cancel/i;
/** Calendar-blocker types that can still carry a client by accident. */
const BLOCKER_TYPE_RE = /^(off|unavailable|training|home show)/i;
/** Demo happened, no sale — worth a rehash call. */
const NO_SALE_RE = /DEMO NO SALE|STILL INTERESTED/i;

// ── Cold streaks: reps running appointments day after day with no sale ──

export interface ColdStreak {
  rep: string;
  /** Consecutive appointment-days (held ≥ 1 appt) since their last sale. */
  days: number;
  /** Held appointments run during the streak. */
  appts: number;
  /** ISO date of the rep's last sale, or null if none on record. */
  lastSale: string | null;
  lastApptDay: string;
}

const repKey = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Cross the stored Meetings days (appointments per rep per day) with the
 * sold contracts: a rep who has HELD appointments on more than `minDays - 1`
 * distinct days since their last sale goes on the alert list. Appointment
 * days after the sold upload's coverage are ignored (unknown ≠ no sale).
 */
export function computeColdStreaks(
  weekDays: Record<string, ApptDay>[],
  sales: { rep: string | null; saleMs: number | null; status: string | null }[],
  minDays = 4
): ColdStreak[] {
  let soldThrough: string | null = null;
  const lastSaleByRep = new Map<string, string>();
  for (const s of sales) {
    if (s.saleMs === null || (s.status && /cancel/i.test(s.status))) continue;
    const iso = new Date(s.saleMs).toISOString().slice(0, 10);
    if (soldThrough === null || iso > soldThrough) soldThrough = iso;
    if (!s.rep) continue;
    const k = repKey(s.rep);
    const prev = lastSaleByRep.get(k);
    if (!prev || iso > prev) lastSaleByRep.set(k, iso);
  }
  if (soldThrough === null) return []; // no sold data → can't tell

  const held = new Map<string, Map<string, number>>(); // repKey → date → held
  const names = new Map<string, string>();
  for (const days of weekDays) {
    for (const [date, day] of Object.entries(days)) {
      if (date > soldThrough) continue;
      for (const [rep, v] of Object.entries(day.byRep)) {
        const h = v.t - v.c;
        if (h <= 0) continue;
        const k = repKey(rep);
        names.set(k, rep);
        const m = held.get(k) ?? new Map<string, number>();
        m.set(date, (m.get(date) ?? 0) + h);
        held.set(k, m);
      }
    }
  }

  const out: ColdStreak[] = [];
  for (const [k, byDate] of held) {
    const lastSale = lastSaleByRep.get(k) ?? null;
    const streakDates = [...byDate.keys()]
      .filter((d) => !lastSale || d > lastSale)
      .sort();
    if (streakDates.length < minDays) continue;
    out.push({
      rep: names.get(k)!,
      days: streakDates.length,
      appts: streakDates.reduce((s, d) => s + byDate.get(d)!, 0),
      lastSale,
      lastApptDay: streakDates[streakDates.length - 1]!,
    });
  }
  return out.sort((a, b) => b.days - a.days || b.appts - a.appts);
}

export function parseMeetingsExport(grid: RawGrid): MeetingsParseResult {
  let header: { row: number; cols: Record<string, number> } | null = null;
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const lower = Array.from(grid[r] ?? [], (c) => text(c)?.toLowerCase() ?? "");
    if (
      lower.includes("client") &&
      lower.includes("employee") &&
      lower.includes("type")
    ) {
      const cols: Record<string, number> = {};
      lower.forEach((c, i) => {
        if (c && cols[c] === undefined) cols[c] = i;
      });
      header = { row: r, cols };
      break;
    }
  }
  if (!header) {
    throw new PipelineFormatError(
      "Couldn't read that file — expected the Meetings export with Client, " +
        "Type, Employee, and Meeting Status columns."
    );
  }
  const h = header;
  const cell = (row: unknown[], name: string) =>
    h.cols[name] === undefined ? undefined : row[h.cols[name]!];

  // Week range + label from the title rows above the header.
  let fromMs: number | null = null;
  let toMs: number | null = null;
  let sourceLabel: string | null = null;
  for (const row of grid.slice(0, h.row)) {
    const t = text((row ?? []).find((c) => text(c)));
    if (!t) continue;
    const m = t.match(
      /between\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+and\s+(\d{1,2}\/\d{1,2}\/\d{4})/i
    );
    if (m) {
      const parse = (s: string) => {
        const [mo, d, y] = s.split("/").map(Number);
        return Date.UTC(y!, mo! - 1, d!);
      };
      fromMs = parse(m[1]!);
      toMs = parse(m[2]!);
      sourceLabel = t;
    } else if (!sourceLabel && /meetings|data as of/i.test(t)) {
      sourceLabel = t;
    }
  }

  const perRep = new Map<string, RepAppointments>();
  const byZip3: Record<string, { t: number; c: number }> = {};
  const days: Record<string, ApptDay> = {};
  const noSaleByClient = new Map<string, NoSaleRow>();
  let total = 0;
  let cancelled = 0;
  const bump = (a: ApptCounts, cxl: boolean, pt: "rubber" | "flake" | null) => {
    a.t++;
    if (cxl) a.c++;
    if (pt === "flake") a.f++;
    else if (pt === "rubber") a.r++;
  };
  for (let r = h.row + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const client = text(cell(row, "client"));
    if (!client) continue; // blockers and headers have no client
    const type = text(cell(row, "type"));
    if (type && BLOCKER_TYPE_RE.test(type)) continue;
    const rep = text(cell(row, "employee")) ?? "Unassigned";
    const isCancelled = CANCELLED_RE.test(text(cell(row, "meeting status")) ?? "");
    total++;
    if (isCancelled) cancelled++;
    const slot = perRep.get(rep) ?? { rep, total: 0, cancelled: 0 };
    slot.total++;
    if (isCancelled) slot.cancelled++;
    perRep.set(rep, slot);

    // The title carries the client's zip ("Joe Ybarra 78253").
    const zip = text(cell(row, "title"))?.match(/(\d{5})\s*$/)?.[1] ?? null;
    const z3 = zip ? zip.slice(0, 3) : "?";
    (byZip3[z3] ??= { t: 0, c: 0 }).t++;
    if (isCancelled) byZip3[z3]!.c++;

    // Per-day: the Start column ("08/15/26 @ 5:00 pm") gives the day.
    const pt = projectTypeOf(text(cell(row, "project type")));
    const dm = text(cell(row, "start"))?.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (dm) {
      const yy = Number(dm[3]);
      const iso = new Date(
        Date.UTC(yy < 100 ? 2000 + yy : yy, Number(dm[1]) - 1, Number(dm[2]))
      )
        .toISOString()
        .slice(0, 10);
      const day = (days[iso] ??= { t: 0, c: 0, f: 0, r: 0, byZip3: {}, byRep: {} });
      bump(day, isCancelled, pt);
      bump((day.byZip3[z3] ??= { t: 0, c: 0, f: 0, r: 0 }), isCancelled, pt);
      bump((day.byRep[rep] ??= { t: 0, c: 0, f: 0, r: 0 }), isCancelled, pt);
    }

    // Rehash list: demos that didn't sell (deduped per client, kept even if
    // one of their meetings was cancelled — the status is what matters).
    const status = text(cell(row, "status"));
    if (status && NO_SALE_RE.test(status) && !isCancelled) {
      noSaleByClient.set(client.toLowerCase(), {
        client,
        phone: text(cell(row, "phone")),
        rep,
        status,
        projectType: text(cell(row, "project type")),
      });
    }
  }
  if (!total) {
    throw new PipelineFormatError(
      "No appointments with a client found in that file — is it the Meetings export?"
    );
  }

  return {
    fromMs,
    toMs,
    sourceLabel,
    total,
    cancelled,
    byRep: [...perRep.values()].sort((a, b) => b.total - a.total),
    byZip3,
    days,
    noSales: [...noSaleByClient.values()].sort((a, b) =>
      a.client.localeCompare(b.client)
    ),
  };
}
