import { promises as fs } from "node:fs";
import path from "node:path";
import type { KvClient } from "./kv/kvClient.js";

/**
 * On-hand material counts per class/location, keyed by the staging item key
 * (see domain/staging.ts). The inventory screen compares these against the
 * upcoming week's staged needs to flag shortfalls.
 */

export interface ClassInventory {
  /** itemKey → on-hand quantity (boxes / bags / gallons / buckets). */
  items: Record<string, number>;
  updatedAt: string | null;
  by: string | null;
}

export type InventoryMap = Record<string, ClassInventory>;

export interface InventoryStore {
  getAll(): Promise<InventoryMap>;
  setItem(
    className: string,
    itemKey: string,
    qty: number,
    by: string | null,
    nowIso: string
  ): Promise<void>;
}

export class JsonInventoryStore implements InventoryStore {
  private readonly file: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, "inventory.json");
  }

  async getAll(): Promise<InventoryMap> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as InventoryMap;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async setItem(
    className: string,
    itemKey: string,
    qty: number,
    by: string | null,
    nowIso: string
  ): Promise<void> {
    const run = async () => {
      const all = await this.getAll();
      const cls = all[className] ?? { items: {}, updatedAt: null, by: null };
      cls.items[itemKey] = qty;
      cls.updatedAt = nowIso;
      cls.by = by;
      all[className] = cls;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(all), "utf8");
      await fs.rename(tmp, this.file);
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }
}

export class KvInventoryStore implements InventoryStore {
  private static readonly KEY = "inventory:current";
  constructor(private readonly kv: KvClient) {}

  async getAll(): Promise<InventoryMap> {
    return (await this.kv.get<InventoryMap>(KvInventoryStore.KEY)) ?? {};
  }
  async setItem(
    className: string,
    itemKey: string,
    qty: number,
    by: string | null,
    nowIso: string
  ): Promise<void> {
    const all = await this.getAll();
    const cls = all[className] ?? { items: {}, updatedAt: null, by: null };
    cls.items[itemKey] = qty;
    cls.updatedAt = nowIso;
    cls.by = by;
    all[className] = cls;
    await this.kv.set(KvInventoryStore.KEY, all);
  }
}

export class MemoryInventoryStore implements InventoryStore {
  private state: InventoryMap = {};
  async getAll() {
    return structuredClone(this.state);
  }
  async setItem(
    className: string,
    itemKey: string,
    qty: number,
    by: string | null,
    nowIso: string
  ) {
    const cls = this.state[className] ?? { items: {}, updatedAt: null, by: null };
    cls.items[itemKey] = qty;
    cls.updatedAt = nowIso;
    cls.by = by;
    this.state[className] = cls;
  }
}
