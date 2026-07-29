import {
  commissionPct,
  findInstaller,
  positionLabel,
  type Installer,
  type InstallerRole,
} from "./roster.js";

/**
 * Performance-pay calculator (PFP plan):
 *  - First 5%, Second 4%, Third 3% of the commissionable (net) contract amount.
 *  - >3 non-floater installers on a job = two crews → rates halve (2.5/2/1.5),
 *    even for a partial second crew.
 *  - Roles come from the roster and never shift day-to-day. Unknown names fall
 *    back to their slot position (1st/2nd/3rd).
 *  - Floaters ($/hr) earn no commission.
 *  - The Lead earns a +1% bonus on the week's total commissionable revenue
 *    when their crew completes more than $30,000 that week.
 */

export const BONUS_THRESHOLD = 30_000;
export const BONUS_PCT = 0.01;

/** The slice of a schedule job the calculator needs. */
export interface PayJobInput {
  jobNumber: string;
  customer: string;
  /** Commissionable (net) amount — contract less dealer fees. */
  amount: number;
  dayIndex: number | null;
  dayLabel: string | null;
  crewMembers: string[];
  isWorkOrder: boolean;
}

export interface PayJobLine {
  jobNumber: string;
  customer: string;
  amount: number;
  dayIndex: number | null;
  dayLabel: string | null;
  /** 1 or 2 crews (sets the rate table for this job). */
  crews: 1 | 2;
  /** Standard daily-pay columns at this job's crew count. */
  leadDailyPay: number;
  tech1DailyPay: number;
  tech2DailyPay: number;
}

export interface PayEmployee {
  name: string;
  role: InstallerRole;
  position: string;
  /** Single-crew percentage for display (per-job rate may halve). */
  pct: number;
  commission: number;
  /** 1% of weekly total for Leads over the threshold; null renders as FALSE/N-A. */
  bonus: number | null;
  hourlyRate: number | null;
  onRoster: boolean;
}

export interface CrewPay {
  /** Crew label = the First slot of the crew's jobs. */
  crewName: string;
  jobs: PayJobLine[];
  totalContracted: number;
  employees: PayEmployee[];
}

export interface WeekPay {
  crews: CrewPay[];
  /** Jobs with an amount but no crew assigned — must be resolved before payroll. */
  unassigned: PayJobLine[];
  totalContracted: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function roleFor(
  name: string,
  slotIndex: number,
  roster: Installer[]
): { role: InstallerRole; hourly: number | null; onRoster: boolean } {
  const found = findInstaller(roster, name);
  if (found) return { role: found.role, hourly: found.hourlyRate, onRoster: true };
  const bySlot: InstallerRole[] = ["First", "Second", "Third"];
  return { role: bySlot[slotIndex] ?? "Third", hourly: null, onRoster: false };
}

function crewCountFor(job: PayJobInput, roster: Installer[]): 1 | 2 {
  const nonFloaters = job.crewMembers.filter((name, i) => {
    if (!name.trim()) return false;
    return roleFor(name, i, roster).role !== "Floater";
  }).length;
  return nonFloaters > 3 ? 2 : 1;
}

function toLine(job: PayJobInput, crews: 1 | 2): PayJobLine {
  const half = crews === 2 ? 0.5 : 1;
  return {
    jobNumber: job.jobNumber,
    customer: job.customer,
    amount: r2(job.amount),
    dayIndex: job.dayIndex,
    dayLabel: job.dayLabel,
    crews,
    leadDailyPay: r2(job.amount * 0.05 * half),
    tech1DailyPay: r2(job.amount * 0.04 * half),
    tech2DailyPay: r2(job.amount * 0.03 * half),
  };
}

export function computeWeekPay(jobs: PayJobInput[], roster: Installer[]): WeekPay {
  const payable = jobs.filter((j) => j.amount > 0);

  // Group by the First slot — the crew identity per the schedule.
  const byCrew = new Map<string, { jobs: PayJobInput[] }>();
  const unassigned: PayJobLine[] = [];
  for (const job of payable) {
    const first = (job.crewMembers[0] || "").trim();
    if (!first) {
      unassigned.push(toLine(job, 1));
      continue;
    }
    const bucket = byCrew.get(first) ?? { jobs: [] };
    bucket.jobs.push(job);
    byCrew.set(first, bucket);
  }

  const crews: CrewPay[] = [...byCrew.entries()].map(([crewName, bucket]) => {
    const lines: PayJobLine[] = [];
    // Per-employee accumulation across the crew's jobs.
    const perEmployee = new Map<
      string,
      { role: InstallerRole; hourly: number | null; onRoster: boolean; commission: number }
    >();
    let total = 0;

    for (const job of bucket.jobs) {
      const crewsOnJob = crewCountFor(job, roster);
      lines.push(toLine(job, crewsOnJob));
      total += job.amount;

      job.crewMembers.forEach((name, slot) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const info = roleFor(trimmed, slot, roster);
        const entry =
          perEmployee.get(trimmed) ?? { ...info, commission: 0 };
        entry.commission += job.amount * commissionPct(info.role, crewsOnJob);
        perEmployee.set(trimmed, entry);
      });
    }

    total = r2(total);
    const employees: PayEmployee[] = [...perEmployee.entries()].map(
      ([name, e]) => ({
        name,
        role: e.role,
        position: positionLabel(e.role),
        pct: commissionPct(e.role, 1),
        commission: r2(e.commission),
        bonus:
          e.role === "First" && total > BONUS_THRESHOLD
            ? r2(total * BONUS_PCT)
            : null,
        hourlyRate: e.hourly,
        onRoster: e.onRoster,
      })
    );
    // Lead first, then Seconds, Thirds, Floaters.
    const order: Record<InstallerRole, number> = { First: 0, Second: 1, Third: 2, Floater: 3 };
    employees.sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));

    lines.sort((a, b) => (a.dayIndex ?? 7) - (b.dayIndex ?? 7));
    return { crewName, jobs: lines, totalContracted: total, employees };
  });

  crews.sort((a, b) => a.crewName.localeCompare(b.crewName));
  const totalContracted = r2(
    crews.reduce((n, c) => n + c.totalContracted, 0) +
      unassigned.reduce((n, j) => n + j.amount, 0)
  );
  return { crews, unassigned, totalContracted };
}
