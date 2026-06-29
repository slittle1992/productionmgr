/**
 * Reporting-week math. The spreadsheet snapshot is taken weekly; §8.2 leaves the
 * exact boundaries open, so the start day is configurable (default Sunday) and
 * all boundaries are computed in a single place.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ReportingWeek {
  /** ISO date (YYYY-MM-DD) of the week's first day — the report's stable id. */
  weekStart: string;
  /** ISO date of the week's last day. */
  weekEnd: string;
  /** Inclusive start instant (ms since epoch, UTC). */
  startMs: number;
  /** Exclusive end instant (ms since epoch, UTC) — start of the next week. */
  endMsExclusive: number;
  /** Calendar quarter label, e.g. "2026-Q2". */
  quarter: string;
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Start-of-day (UTC) for the date portion of `ms`. */
function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function quarterLabel(ms: number): string {
  const d = new Date(ms);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

/**
 * Resolve the reporting week containing `referenceMs`.
 * @param weekStartDay 0 = Sunday ... 6 = Saturday.
 */
export function getReportingWeek(
  referenceMs: number,
  weekStartDay = 0
): ReportingWeek {
  const dayStart = startOfUtcDay(referenceMs);
  const dow = new Date(dayStart).getUTCDay();
  const offset = (dow - weekStartDay + 7) % 7;
  const startMs = dayStart - offset * MS_PER_DAY;
  const endMsExclusive = startMs + 7 * MS_PER_DAY;
  return {
    weekStart: toIsoDate(startMs),
    weekEnd: toIsoDate(endMsExclusive - MS_PER_DAY),
    startMs,
    endMsExclusive,
    quarter: quarterLabel(startMs),
  };
}

/** Resolve a reporting week from an ISO `YYYY-MM-DD` start date. */
export function getReportingWeekFromStart(
  weekStart: string,
  weekStartDay = 0
): ReportingWeek {
  const ms = Date.parse(`${weekStart}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid week start date: ${weekStart}`);
  }
  return getReportingWeek(ms, weekStartDay);
}

/** True when `ms` falls inside the week [start, endExclusive). */
export function isWithinWeek(
  ms: number | undefined,
  week: ReportingWeek
): boolean {
  if (ms === undefined || !Number.isFinite(ms)) return false;
  return ms >= week.startMs && ms < week.endMsExclusive;
}

/**
 * All week-start ids for the quarter containing `week`, in chronological order,
 * up to and including `week` itself. Used to roll QTD figures forward (§4).
 */
export function quarterWeekStarts(week: ReportingWeek, weekStartDay = 0): string[] {
  const starts: string[] = [];
  const d = new Date(week.startMs);
  const quarterStartMonth = Math.floor(d.getUTCMonth() / 3) * 3;
  const quarterStartMs = Date.UTC(d.getUTCFullYear(), quarterStartMonth, 1);

  // Walk weeks from the first reporting week that the quarter start falls in.
  let cursor = getReportingWeek(quarterStartMs, weekStartDay).startMs;
  while (cursor <= week.startMs) {
    starts.push(toIsoDate(cursor));
    cursor += 7 * MS_PER_DAY;
  }
  return starts;
}
