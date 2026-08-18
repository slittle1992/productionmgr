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

export interface MeetingsParseResult {
  fromMs: number | null;
  toMs: number | null;
  sourceLabel: string | null;
  total: number;
  cancelled: number;
  byRep: RepAppointments[];
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

const CANCELLED_RE = /cancel/i;
/** Calendar-blocker types that can still carry a client by accident. */
const BLOCKER_TYPE_RE = /^(off|unavailable|training|home show)/i;

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
  let total = 0;
  let cancelled = 0;
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
  };
}
