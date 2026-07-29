/**
 * Installer roster. Roles are fixed per person (per the PFP plan — an
 * installer holds their role until promoted), so the roster is the source of
 * truth the pay calculator uses to know each rep's percentage and hourly rate.
 */
export type InstallerRole = "First" | "Second" | "Third" | "Floater";

export interface Installer {
  id: string;
  name: string;
  /** Class/region the rep belongs to (e.g. "Dallas"). */
  className: string;
  role: InstallerRole;
  /** Hourly rate for PTO / go-backs / floater pay. */
  hourlyRate: number;
  active: boolean;
}

/** Commission % by role and number of crews on the job (PFP plan). */
export function commissionPct(role: InstallerRole, crews: 1 | 2): number {
  const single: Record<InstallerRole, number> = {
    First: 0.05,
    Second: 0.04,
    Third: 0.03,
    Floater: 0,
  };
  const pct = single[role];
  return crews === 2 ? pct / 2 : pct;
}

/** Default hourly rate by role (PTO / hourly work). */
export function defaultHourlyRate(role: InstallerRole): number {
  switch (role) {
    case "First":
      return 24;
    case "Second":
      return 22;
    case "Third":
      return 20;
    case "Floater":
      return 20;
  }
}

/** Worksheet position label ("Crew Lead", "Production Tech 1", ...). */
export function positionLabel(role: InstallerRole): string {
  switch (role) {
    case "First":
      return "Crew Lead";
    case "Second":
      return "Production Tech 1";
    case "Third":
      return "Production Tech 2";
    case "Floater":
      return "Floater (hourly)";
  }
}

/** Case/space-insensitive roster lookup by name. */
export function findInstaller(
  roster: Installer[],
  name: string
): Installer | undefined {
  const key = name.trim().toLowerCase();
  return roster.find((i) => i.name.trim().toLowerCase() === key);
}
