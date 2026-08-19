import type { MaterialEstimate } from "./materials.js";
import type { ScheduleJob, WeeklySchedule } from "../services/scheduleService.js";

/**
 * Staging list: what material each location pulls and sets out ahead of a
 * week's installs. Built from the weekly schedule (which already computes
 * per-job material from SQFT + color), aggregated per class → per product.
 *
 * Material is identified by a stable item key so the inventory screen can
 * compare on-hand counts against staged needs:
 *   flake:<product>   — flake blend, counted in boxes (lbs shown too)
 *   rubber:<color>    — rubber granules, counted in 50 lb bags
 *   basecoatA/B       — polyurea gallons
 *   topcoatA/B        — polyaspartic gallons
 *   binder / primer   — 5-gal buckets
 */

export interface StagingJobLine {
  id: string;
  jobNumber: string;
  customer: string;
  dayLabel: string | null;
  dayIndex: number | null;
  projectType: string;
  kind: MaterialEstimate["kind"];
  sqft: number | null;
  color: string | null;
  baseColor: string | null;
  crew: string;
  isWorkOrder: boolean;
  material: MaterialEstimate;
  /** Material applies but sqft or color is missing — can't stage it yet. */
  missingInfo: boolean;
}

export interface StagingColorLine {
  kind: "flake" | "rubber";
  /** Flake product or rubber color ("(no color set)" when missing). */
  product: string;
  itemKey: string;
  jobs: number;
  sqft: number;
  flakePounds: number;
  flakeBoxes: number;
  rubberBags: number;
}

export interface StagingTotals {
  basecoatAGallons: number;
  basecoatBGallons: number;
  topcoatAGallons: number;
  topcoatBGallons: number;
  binderBuckets: number;
  primerBuckets: number;
  flakePounds: number;
  flakeBoxes: number;
  rubberBags: number;
  sqftFlake: number;
  sqftRubber: number;
}

/**
 * Per-crew hand-out list in ISSUE UNITS: flake by the 40 lb box, polyurea by
 * the 15-gal kit (per base color), polyaspartic by the 10-gal kit, rubber by
 * the bag. Exact needs ride along so a light week reads "3 gal → 1 kit".
 * Mender and sundries are issued as needed and aren't computed here.
 */
export interface StagingCrewList {
  crew: string;
  jobs: number;
  flake: { product: string; pounds: number; boxes: number }[];
  polyurea: { base: string; gallons: number; kits: number }[];
  topcoatGallons: number;
  topcoatKits: number;
  rubber: { color: string; bags: number }[];
  binderBuckets: number;
  primerBuckets: number;
}

/** Warehouse pull line: whole issue units (the sum of the crews' units, so
 * the pull list and the hand-out sheets always agree). */
export interface StagingPullLine {
  label: string;
  qty: number;
  unit: string;
  /** Exact need behind the rounding ("34.3 gal"). */
  exact: string | null;
}

export interface StagingClassList {
  className: string;
  jobs: StagingJobLine[];
  colors: StagingColorLine[];
  crews: StagingCrewList[];
  pull: StagingPullLine[];
  totals: StagingTotals;
  missingInfoCount: number;
}

export interface StagingWeek {
  weekStart: string;
  weekEnd: string;
  classes: StagingClassList[];
  jobCount: number;
}

const NO_COLOR = "(no color set)";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function itemKeyFor(kind: "flake" | "rubber", product: string): string {
  return `${kind}:${product.toLowerCase()}`;
}

/** Human label + unit for a staging/inventory item key. */
export function itemLabel(key: string): { label: string; unit: string } {
  if (key.startsWith("flake:")) return { label: `Flake — ${title(key.slice(6))}`, unit: "boxes (40 lb)" };
  if (key.startsWith("rubber:")) return { label: `Rubber — ${title(key.slice(7))}`, unit: "bags (50 lb)" };
  switch (key) {
    case "basecoatA": return { label: "Polyurea basecoat A", unit: "gal" };
    case "basecoatB": return { label: "Polyurea basecoat B", unit: "gal" };
    case "topcoatA": return { label: "Polyaspartic topcoat A", unit: "gal" };
    case "topcoatB": return { label: "Polyaspartic topcoat B", unit: "gal" };
    case "binder": return { label: "Rubber binder", unit: "buckets (5 gal)" };
    case "primer": return { label: "Rubber primer", unit: "buckets (5 gal)" };
    default: return { label: key, unit: "" };
  }
}

function title(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function jobLine(job: ScheduleJob): StagingJobLine {
  const m = job.material;
  const missingInfo =
    m.applies && (!job.sqft || job.sqft <= 0 || (m.kind !== "none" && !m.flake));
  return {
    id: job.id,
    jobNumber: job.jobNumber,
    customer: job.customer,
    dayLabel: job.dayLabel,
    dayIndex: job.dayIndex,
    projectType: job.projectType,
    kind: m.kind,
    sqft: job.sqft,
    color: m.flake ?? job.color,
    baseColor: job.baseColor ?? null,
    crew: job.crew,
    isWorkOrder: job.isWorkOrder,
    material: m,
    missingInfo,
  };
}

export function buildStaging(schedule: WeeklySchedule): StagingWeek {
  const classes: StagingClassList[] = [];

  for (const group of schedule.classes) {
    const jobs = group.jobs.map(jobLine);
    // Only jobs whose material applies stage anything.
    const staged = jobs.filter((j) => j.material.applies && j.kind !== "none");

    const colorMap = new Map<string, StagingColorLine>();
    const totals: StagingTotals = {
      basecoatAGallons: 0,
      basecoatBGallons: 0,
      topcoatAGallons: 0,
      topcoatBGallons: 0,
      binderBuckets: 0,
      primerBuckets: 0,
      flakePounds: 0,
      flakeBoxes: 0,
      rubberBags: 0,
      sqftFlake: 0,
      sqftRubber: 0,
    };

    for (const j of staged) {
      const m = j.material;
      const kind = m.kind as "flake" | "rubber";
      const product = m.flake ?? NO_COLOR;
      const key = `${kind}|${product.toLowerCase()}`;
      let line = colorMap.get(key);
      if (!line) {
        line = {
          kind,
          product,
          itemKey: itemKeyFor(kind, product),
          jobs: 0,
          sqft: 0,
          flakePounds: 0,
          flakeBoxes: 0,
          rubberBags: 0,
        };
        colorMap.set(key, line);
      }
      line.jobs++;
      line.sqft += j.sqft ?? 0;
      line.flakePounds = round2(line.flakePounds + m.flakePounds);
      line.flakeBoxes = round2(line.flakeBoxes + m.flakeBoxes);
      line.rubberBags = round2(line.rubberBags + m.rubberBags);

      totals.basecoatAGallons = round2(totals.basecoatAGallons + m.basecoatAGallons);
      totals.basecoatBGallons = round2(totals.basecoatBGallons + m.basecoatBGallons);
      totals.topcoatAGallons = round2(totals.topcoatAGallons + m.topcoatAGallons);
      totals.topcoatBGallons = round2(totals.topcoatBGallons + m.topcoatBGallons);
      totals.binderBuckets = round2(totals.binderBuckets + m.binderBuckets);
      totals.primerBuckets = round2(totals.primerBuckets + m.primerBuckets);
      totals.flakePounds = round2(totals.flakePounds + m.flakePounds);
      totals.flakeBoxes = round2(totals.flakeBoxes + m.flakeBoxes);
      totals.rubberBags = round2(totals.rubberBags + m.rubberBags);
      if (kind === "flake") totals.sqftFlake += j.sqft ?? 0;
      else totals.sqftRubber += j.sqft ?? 0;
    }

    // Per-crew hand-out lists in issue units.
    const POLYUREA_KIT_GAL = 15;
    const POLYASPARTIC_KIT_GAL = 10;
    const NO_CREW = "(no crew assigned)";
    interface CrewAcc {
      crew: string;
      jobs: number;
      flake: Map<string, number>; // product → boxes (fractional)
      polyurea: Map<string, number>; // base color → gallons
      topcoatGallons: number;
      rubber: Map<string, number>; // color → bags
      binderBuckets: number;
      primerBuckets: number;
    }
    const crewMap = new Map<string, CrewAcc>();
    for (const j of staged) {
      const m = j.material;
      const crew = j.crew || NO_CREW;
      const acc =
        crewMap.get(crew) ??
        ({
          crew,
          jobs: 0,
          flake: new Map(),
          polyurea: new Map(),
          topcoatGallons: 0,
          rubber: new Map(),
          binderBuckets: 0,
          primerBuckets: 0,
        } as CrewAcc);
      acc.jobs++;
      const product = m.flake ?? NO_COLOR;
      if (m.kind === "flake") {
        acc.flake.set(product, (acc.flake.get(product) ?? 0) + m.flakeBoxes);
        const base = j.baseColor ?? "(base TBD)";
        acc.polyurea.set(
          base,
          (acc.polyurea.get(base) ?? 0) + m.basecoatAGallons + m.basecoatBGallons
        );
        acc.topcoatGallons = round2(
          acc.topcoatGallons + m.topcoatAGallons + m.topcoatBGallons
        );
      } else {
        acc.rubber.set(product, (acc.rubber.get(product) ?? 0) + m.rubberBags);
        acc.binderBuckets = round2(acc.binderBuckets + m.binderBuckets);
        acc.primerBuckets = round2(acc.primerBuckets + m.primerBuckets);
      }
      crewMap.set(crew, acc);
    }
    const crews: StagingCrewList[] = [...crewMap.values()]
      .map((a) => ({
        crew: a.crew,
        jobs: a.jobs,
        flake: [...a.flake.entries()]
          .map(([product, boxes]) => ({
            product,
            pounds: round2(boxes * 40),
            boxes: Math.ceil(boxes - 1e-9),
          }))
          .sort((x, y) => x.product.localeCompare(y.product)),
        polyurea: [...a.polyurea.entries()]
          .map(([base, gallons]) => ({
            base,
            gallons: round2(gallons),
            kits: Math.ceil(gallons / POLYUREA_KIT_GAL - 1e-9),
          }))
          .sort((x, y) => x.base.localeCompare(y.base)),
        topcoatGallons: a.topcoatGallons,
        topcoatKits: Math.ceil(a.topcoatGallons / POLYASPARTIC_KIT_GAL - 1e-9),
        rubber: [...a.rubber.entries()]
          .map(([color, bags]) => ({ color, bags: Math.ceil(bags - 1e-9) }))
          .sort((x, y) => x.color.localeCompare(y.color)),
        binderBuckets: Math.ceil(a.binderBuckets - 1e-9),
        primerBuckets: Math.ceil(a.primerBuckets - 1e-9),
      }))
      .sort((x, y) =>
        x.crew === NO_CREW ? 1 : y.crew === NO_CREW ? -1 : x.crew.localeCompare(y.crew)
      );

    // Warehouse pull = the crews' whole units summed.
    const pullMap = new Map<string, StagingPullLine & { exactN: number }>();
    const addPull = (label: string, qty: number, unit: string, exactN: number, exactUnit: string) => {
      const cur = pullMap.get(label) ?? { label, qty: 0, unit, exact: null, exactN: 0 };
      cur.qty += qty;
      cur.exactN = round2(cur.exactN + exactN);
      cur.exact = `${cur.exactN} ${exactUnit}`;
      pullMap.set(label, cur);
    };
    for (const cr of crews) {
      for (const f of cr.flake) addPull(`Flake — ${f.product}`, f.boxes, "boxes (40 lb)", f.pounds, "lb");
      for (const p of cr.polyurea) {
        if (p.gallons > 0) addPull(`Polyurea ${p.base}`, p.kits, "15-gal kits", p.gallons, "gal");
      }
      if (cr.topcoatGallons > 0)
        addPull("Polyaspartic", cr.topcoatKits, "10-gal kits", cr.topcoatGallons, "gal");
      for (const r of cr.rubber) addPull(`Rubber — ${r.color}`, r.bags, "bags (50 lb)", r.bags, "bags");
      if (cr.binderBuckets > 0) addPull("Rubber binder", cr.binderBuckets, "buckets (5 gal)", cr.binderBuckets, "buckets");
      if (cr.primerBuckets > 0) addPull("Rubber primer", cr.primerBuckets, "buckets (5 gal)", cr.primerBuckets, "buckets");
    }
    const pull = [...pullMap.values()]
      .map(({ exactN: _n, ...line }) => line)
      .sort((a, b) => a.label.localeCompare(b.label));

    classes.push({
      className: group.className,
      jobs,
      colors: [...colorMap.values()].sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.product.localeCompare(b.product)
      ),
      crews,
      pull,
      totals,
      missingInfoCount: jobs.filter((j) => j.missingInfo).length,
    });
  }

  return {
    weekStart: schedule.weekStart,
    weekEnd: schedule.weekEnd,
    classes,
    jobCount: schedule.jobCount,
  };
}

export interface InventoryItemView {
  key: string;
  label: string;
  unit: string;
  onHand: number;
  needed: number;
  short: number;
}

export interface InventoryClassView {
  className: string;
  items: InventoryItemView[];
  updatedAt: string | null;
  by: string | null;
}

export interface InventoryView {
  weekStart: string;
  weekEnd: string;
  classes: InventoryClassView[];
}

/** Join staged needs with on-hand counts (shape of GET /api/inventory). */
export function buildInventoryView(
  staging: StagingWeek,
  inventory: Record<string, { items: Record<string, number>; updatedAt: string | null; by: string | null }>
): InventoryView {
  const classNames = new Set<string>([
    ...staging.classes.map((c) => c.className),
    ...Object.keys(inventory),
  ]);
  const classes = [...classNames].sort().map((className) => {
    const list = staging.classes.find((c) => c.className === className);
    const need = list ? neededByItem(list) : {};
    const onHand = inventory[className]?.items ?? {};
    const keys = new Set([...Object.keys(need), ...Object.keys(onHand)]);
    const items = [...keys].sort().map((key) => {
      const needed = need[key] ?? 0;
      const have = onHand[key] ?? 0;
      return {
        key,
        ...itemLabel(key),
        onHand: have,
        needed,
        short: Math.max(0, Math.round((needed - have) * 100) / 100),
      };
    });
    return {
      className,
      items,
      updatedAt: inventory[className]?.updatedAt ?? null,
      by: inventory[className]?.by ?? null,
    };
  });
  return { weekStart: staging.weekStart, weekEnd: staging.weekEnd, classes };
}

/** Needed quantities per item key for one class (for the inventory screen). */
export function neededByItem(list: StagingClassList): Record<string, number> {
  const need: Record<string, number> = {};
  const add = (key: string, qty: number) => {
    if (qty > 0) need[key] = round2((need[key] ?? 0) + qty);
  };
  for (const c of list.colors) {
    if (c.kind === "flake") add(c.itemKey, c.flakeBoxes);
    else add(c.itemKey, c.rubberBags);
  }
  add("basecoatA", list.totals.basecoatAGallons);
  add("basecoatB", list.totals.basecoatBGallons);
  add("topcoatA", list.totals.topcoatAGallons);
  add("topcoatB", list.totals.topcoatBGallons);
  add("binder", list.totals.binderBuckets);
  add("primer", list.totals.primerBuckets);
  return need;
}
