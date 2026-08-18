import { promises as fs } from "node:fs";
import path from "node:path";
import type { InventoryCountLine } from "../domain/inventory.js";
import { classSlug } from "./repository.js";
import type { KvClient } from "./kv/kvClient.js";

/** One location's uploaded inventory count for one week. */
export interface StoredInventoryWeek {
  weekStart: string;
  className: string;
  uploadedAt: string;
  filename: string | null;
  sourceLabel: string | null;
  lines: InventoryCountLine[];
}

/** Unit costs by item key (lower-cased cleaned item name) → dollars per unit. */
export type PriceMap = Record<string, number>;

/** Dollars spent on material for one location in one week (from POs/Ramp). */
export type PurchasesMap = Record<string, number>;

/** A vendor purchase order dropped in from the email, pending until received. */
export interface StoredPo {
  id: string;
  poNumber: string | null;
  supplier: string | null;
  orderMs: number | null;
  className: string | null;
  total: number | null;
  filename: string | null;
  uploadedAt: string;
  /** Week the material landed; null while still in transit. */
  receivedWeek: string | null;
  receivedAt: string | null;
}

export interface InventoryCountsStore {
  /** Every location's count stored for the week. */
  getWeek(weekStart: string): Promise<StoredInventoryWeek[]>;
  /** Upsert one location's count for its week. */
  setWeek(week: StoredInventoryWeek): Promise<void>;
  /** Remove one location's count, or the whole week when no class is given. */
  deleteWeek(weekStart: string, className?: string): Promise<void>;
  /** All stored week-start dates, ascending. */
  listWeekStarts(): Promise<string[]>;
  getPrices(): Promise<PriceMap>;
  /** Merge `prices` into the stored map; entries with value <= 0 are removed. */
  setPrices(prices: PriceMap): Promise<PriceMap>;
  /** classSlug → purchases $ for the week. */
  getPurchases(weekStart: string): Promise<PurchasesMap>;
  /** Set (or clear, with null) one location's purchases $ for the week. */
  setPurchases(
    weekStart: string,
    className: string,
    amount: number | null
  ): Promise<void>;
  listPos(): Promise<StoredPo[]>;
  addPo(po: StoredPo): Promise<void>;
  /** Merge fields into a stored PO; returns null when the id is unknown. */
  updatePo(id: string, patch: Partial<StoredPo>): Promise<StoredPo | null>;
  deletePo(id: string): Promise<void>;
}

function mergePrices(current: PriceMap, updates: PriceMap): PriceMap {
  const next = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (Number.isFinite(value) && value > 0) next[key] = value;
    else delete next[key];
  }
  return next;
}

const sortByClass = (a: StoredInventoryWeek, b: StoredInventoryWeek) =>
  a.className.localeCompare(b.className);

interface InventoryFile {
  /** weekStart → classSlug → count. */
  weeks: Record<string, Record<string, StoredInventoryWeek>>;
  prices: PriceMap;
  /** weekStart → classSlug → purchases $. */
  purchases?: Record<string, PurchasesMap>;
  pos?: StoredPo[];
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
        return { weeks: {}, prices: {}, purchases: {} };
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

  async getWeek(weekStart: string): Promise<StoredInventoryWeek[]> {
    return Object.values((await this.read()).weeks[weekStart] ?? {}).sort(sortByClass);
  }
  async setWeek(week: StoredInventoryWeek): Promise<void> {
    await this.write((f) => {
      (f.weeks[week.weekStart] ??= {})[classSlug(week.className)] = week;
    });
  }
  async deleteWeek(weekStart: string, className?: string): Promise<void> {
    await this.write((f) => {
      if (className === undefined) delete f.weeks[weekStart];
      else delete f.weeks[weekStart]?.[classSlug(className)];
    });
  }
  async listWeekStarts(): Promise<string[]> {
    const weeks = (await this.read()).weeks;
    return Object.keys(weeks)
      .filter((w) => Object.keys(weeks[w] ?? {}).length)
      .sort();
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
  async getPurchases(weekStart: string): Promise<PurchasesMap> {
    return (await this.read()).purchases?.[weekStart] ?? {};
  }
  async setPurchases(
    weekStart: string,
    className: string,
    amount: number | null
  ): Promise<void> {
    await this.write((f) => {
      const wk = ((f.purchases ??= {})[weekStart] ??= {});
      if (amount === null) delete wk[classSlug(className)];
      else wk[classSlug(className)] = amount;
    });
  }
  async listPos(): Promise<StoredPo[]> {
    return (await this.read()).pos ?? [];
  }
  async addPo(po: StoredPo): Promise<void> {
    await this.write((f) => {
      (f.pos ??= []).push(po);
    });
  }
  async updatePo(id: string, patch: Partial<StoredPo>): Promise<StoredPo | null> {
    let updated: StoredPo | null = null;
    await this.write((f) => {
      const po = (f.pos ?? []).find((p) => p.id === id);
      if (po) updated = Object.assign(po, patch);
    });
    return updated;
  }
  async deletePo(id: string): Promise<void> {
    await this.write((f) => {
      f.pos = (f.pos ?? []).filter((p) => p.id !== id);
    });
  }
}

export class KvInventoryCountsStore implements InventoryCountsStore {
  /** Hash of `${weekStart}|${classSlug}` → StoredInventoryWeek (null = deleted). */
  private static readonly WEEKS = "inventory:weeks";
  private static readonly PRICES = "inventory:prices";
  /** Hash of `${weekStart}|${classSlug}` → purchases $ (null = cleared). */
  private static readonly PURCHASES = "inventory:purchases";
  /** Hash of PO id → StoredPo (null = deleted). */
  private static readonly POS = "inventory:pos";
  constructor(private readonly kv: KvClient) {}

  private async all(): Promise<Record<string, StoredInventoryWeek | null>> {
    return (
      (await this.kv.hgetall<StoredInventoryWeek | null>(
        KvInventoryCountsStore.WEEKS
      )) ?? {}
    );
  }
  private static live(v: StoredInventoryWeek | null): v is StoredInventoryWeek {
    return Boolean(v && Array.isArray(v.lines));
  }

  async getWeek(weekStart: string): Promise<StoredInventoryWeek[]> {
    const all = await this.all();
    return Object.entries(all)
      .filter(
        ([k, v]) =>
          k.startsWith(`${weekStart}|`) && KvInventoryCountsStore.live(v)
      )
      .map(([, v]) => v as StoredInventoryWeek)
      .sort(sortByClass);
  }
  async setWeek(week: StoredInventoryWeek): Promise<void> {
    await this.kv.hset(
      KvInventoryCountsStore.WEEKS,
      `${week.weekStart}|${classSlug(week.className)}`,
      week
    );
  }
  async deleteWeek(weekStart: string, className?: string): Promise<void> {
    if (className !== undefined) {
      await this.kv.hset(
        KvInventoryCountsStore.WEEKS,
        `${weekStart}|${classSlug(className)}`,
        null
      );
      return;
    }
    const all = await this.all();
    for (const key of Object.keys(all)) {
      if (key.startsWith(`${weekStart}|`) && all[key]) {
        await this.kv.hset(KvInventoryCountsStore.WEEKS, key, null);
      }
    }
  }
  async listWeekStarts(): Promise<string[]> {
    const all = await this.all();
    const weeks = new Set<string>();
    for (const [key, v] of Object.entries(all)) {
      if (KvInventoryCountsStore.live(v)) weeks.add(key.split("|")[0]!);
    }
    return [...weeks].sort();
  }
  async getPrices(): Promise<PriceMap> {
    return (await this.kv.get<PriceMap>(KvInventoryCountsStore.PRICES)) ?? {};
  }
  async setPrices(prices: PriceMap): Promise<PriceMap> {
    const next = mergePrices(await this.getPrices(), prices);
    await this.kv.set(KvInventoryCountsStore.PRICES, next);
    return next;
  }
  async getPurchases(weekStart: string): Promise<PurchasesMap> {
    const all =
      (await this.kv.hgetall<number | null>(KvInventoryCountsStore.PURCHASES)) ??
      {};
    const out: PurchasesMap = {};
    for (const [key, v] of Object.entries(all)) {
      if (typeof v === "number" && key.startsWith(`${weekStart}|`)) {
        out[key.slice(weekStart.length + 1)] = v;
      }
    }
    return out;
  }
  async setPurchases(
    weekStart: string,
    className: string,
    amount: number | null
  ): Promise<void> {
    await this.kv.hset(
      KvInventoryCountsStore.PURCHASES,
      `${weekStart}|${classSlug(className)}`,
      amount
    );
  }
  private async allPos(): Promise<StoredPo[]> {
    const all =
      (await this.kv.hgetall<StoredPo | null>(KvInventoryCountsStore.POS)) ?? {};
    return Object.values(all).filter((p): p is StoredPo => Boolean(p && p.id));
  }
  async listPos(): Promise<StoredPo[]> {
    return (await this.allPos()).sort((a, b) =>
      a.uploadedAt.localeCompare(b.uploadedAt)
    );
  }
  async addPo(po: StoredPo): Promise<void> {
    await this.kv.hset(KvInventoryCountsStore.POS, po.id, po);
  }
  async updatePo(id: string, patch: Partial<StoredPo>): Promise<StoredPo | null> {
    const all =
      (await this.kv.hgetall<StoredPo | null>(KvInventoryCountsStore.POS)) ?? {};
    const po = all[id];
    if (!po) return null;
    const next = { ...po, ...patch };
    await this.kv.hset(KvInventoryCountsStore.POS, id, next);
    return next;
  }
  async deletePo(id: string): Promise<void> {
    await this.kv.hset(KvInventoryCountsStore.POS, id, null);
  }
}

export class MemoryInventoryCountsStore implements InventoryCountsStore {
  private weeks = new Map<string, StoredInventoryWeek>();
  private prices: PriceMap = {};

  private static key(weekStart: string, className: string) {
    return `${weekStart}|${classSlug(className)}`;
  }
  async getWeek(weekStart: string) {
    return [...this.weeks.values()]
      .filter((w) => w.weekStart === weekStart)
      .map((w) => structuredClone(w))
      .sort(sortByClass);
  }
  async setWeek(week: StoredInventoryWeek) {
    this.weeks.set(
      MemoryInventoryCountsStore.key(week.weekStart, week.className),
      structuredClone(week)
    );
  }
  async deleteWeek(weekStart: string, className?: string) {
    if (className !== undefined) {
      this.weeks.delete(MemoryInventoryCountsStore.key(weekStart, className));
      return;
    }
    for (const key of [...this.weeks.keys()]) {
      if (key.startsWith(`${weekStart}|`)) this.weeks.delete(key);
    }
  }
  async listWeekStarts() {
    return [...new Set([...this.weeks.values()].map((w) => w.weekStart))].sort();
  }
  async getPrices() {
    return { ...this.prices };
  }
  async setPrices(prices: PriceMap) {
    this.prices = mergePrices(this.prices, prices);
    return { ...this.prices };
  }
  private purchases = new Map<string, number>();
  async getPurchases(weekStart: string) {
    const out: PurchasesMap = {};
    for (const [key, v] of this.purchases) {
      if (key.startsWith(`${weekStart}|`)) out[key.slice(weekStart.length + 1)] = v;
    }
    return out;
  }
  async setPurchases(weekStart: string, className: string, amount: number | null) {
    const key = MemoryInventoryCountsStore.key(weekStart, className);
    if (amount === null) this.purchases.delete(key);
    else this.purchases.set(key, amount);
  }
  private pos: StoredPo[] = [];
  async listPos() {
    return structuredClone(this.pos);
  }
  async addPo(po: StoredPo) {
    this.pos.push(structuredClone(po));
  }
  async updatePo(id: string, patch: Partial<StoredPo>) {
    const po = this.pos.find((p) => p.id === id);
    if (!po) return null;
    Object.assign(po, patch);
    return structuredClone(po);
  }
  async deletePo(id: string) {
    this.pos = this.pos.filter((p) => p.id !== id);
  }
}
