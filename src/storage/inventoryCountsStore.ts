import { promises as fs } from "node:fs";
import path from "node:path";
import type { InventoryCountLine } from "../domain/inventory.js";
import type { KvClient } from "./kv/kvClient.js";

/** One week's uploaded inventory count. */
export interface StoredInventoryWeek {
  weekStart: string;
  uploadedAt: string;
  filename: string | null;
  sourceLabel: string | null;
  lines: InventoryCountLine[];
}

/** Unit costs by item key (lower-cased cleaned item name) → dollars per unit. */
export type PriceMap = Record<string, number>;

export interface InventoryCountsStore {
  getWeek(weekStart: string): Promise<StoredInventoryWeek | null>;
  setWeek(week: StoredInventoryWeek): Promise<void>;
  deleteWeek(weekStart: string): Promise<void>;
  /** All stored week-start dates, ascending. */
  listWeekStarts(): Promise<string[]>;
  getPrices(): Promise<PriceMap>;
  /** Merge `prices` into the stored map; entries with value <= 0 are removed. */
  setPrices(prices: PriceMap): Promise<PriceMap>;
}

function mergePrices(current: PriceMap, updates: PriceMap): PriceMap {
  const next = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (Number.isFinite(value) && value > 0) next[key] = value;
    else delete next[key];
  }
  return next;
}

interface InventoryFile {
  weeks: Record<string, StoredInventoryWeek>;
  prices: PriceMap;
}

export class JsonInventoryCountsStore implements InventoryCountsStore {
  private readonly file: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, "inventory-counts.json");
  }

  private async read(): Promise<InventoryFile> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as InventoryFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return { weeks: {}, prices: {} };
      throw err;
    }
  }

  private async write(mutate: (f: InventoryFile) => void): Promise<InventoryFile> {
    let result!: InventoryFile;
    const run = async () => {
      const current = await this.read();
      mutate(current);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(current), "utf8");
      await fs.rename(tmp, this.file);
      result = current;
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
    return result;
  }

  async getWeek(weekStart: string): Promise<StoredInventoryWeek | null> {
    return (await this.read()).weeks[weekStart] ?? null;
  }
  async setWeek(week: StoredInventoryWeek): Promise<void> {
    await this.write((f) => {
      f.weeks[week.weekStart] = week;
    });
  }
  async deleteWeek(weekStart: string): Promise<void> {
    await this.write((f) => {
      delete f.weeks[weekStart];
    });
  }
  async listWeekStarts(): Promise<string[]> {
    return Object.keys((await this.read()).weeks).sort();
  }
  async getPrices(): Promise<PriceMap> {
    return (await this.read()).prices ?? {};
  }
  async setPrices(prices: PriceMap): Promise<PriceMap> {
    const next = await this.write((f) => {
      f.prices = mergePrices(f.prices ?? {}, prices);
    });
    return next.prices;
  }
}

export class KvInventoryCountsStore implements InventoryCountsStore {
  private static readonly WEEKS = "inventory:weeks";
  private static readonly PRICES = "inventory:prices";
  constructor(private readonly kv: KvClient) {}

  async getWeek(weekStart: string): Promise<StoredInventoryWeek | null> {
    const all = await this.kv.hgetall<StoredInventoryWeek>(KvInventoryCountsStore.WEEKS);
    return all?.[weekStart] ?? null;
  }
  async setWeek(week: StoredInventoryWeek): Promise<void> {
    await this.kv.hset(KvInventoryCountsStore.WEEKS, week.weekStart, week);
  }
  async deleteWeek(weekStart: string): Promise<void> {
    // KvClient has no hdel; overwrite with a tombstone the reads filter out.
    await this.kv.hset(KvInventoryCountsStore.WEEKS, weekStart, null);
  }
  async listWeekStarts(): Promise<string[]> {
    const all = await this.kv.hgetall<StoredInventoryWeek>(KvInventoryCountsStore.WEEKS);
    return Object.entries(all ?? {})
      .filter(([, v]) => v && Array.isArray(v.lines))
      .map(([k]) => k)
      .sort();
  }
  async getPrices(): Promise<PriceMap> {
    return (await this.kv.get<PriceMap>(KvInventoryCountsStore.PRICES)) ?? {};
  }
  async setPrices(prices: PriceMap): Promise<PriceMap> {
    const next = mergePrices(await this.getPrices(), prices);
    await this.kv.set(KvInventoryCountsStore.PRICES, next);
    return next;
  }
}

export class MemoryInventoryCountsStore implements InventoryCountsStore {
  private weeks = new Map<string, StoredInventoryWeek>();
  private prices: PriceMap = {};

  async getWeek(weekStart: string) {
    const w = this.weeks.get(weekStart);
    return w ? structuredClone(w) : null;
  }
  async setWeek(week: StoredInventoryWeek) {
    this.weeks.set(week.weekStart, structuredClone(week));
  }
  async deleteWeek(weekStart: string) {
    this.weeks.delete(weekStart);
  }
  async listWeekStarts() {
    return [...this.weeks.keys()].sort();
  }
  async getPrices() {
    return { ...this.prices };
  }
  async setPrices(prices: PriceMap) {
    this.prices = mergePrices(this.prices, prices);
    return { ...this.prices };
  }
}
