import { promises as fs } from "node:fs";
import path from "node:path";
import type { WorkOrder } from "../domain/workOrders.js";
import type { KvClient } from "./kv/kvClient.js";

/** Uploaded work orders plus any the PMs added by hand. */
export interface StoredWorkOrders {
  uploaded: WorkOrder[];
  manual: WorkOrder[];
  uploadedAt: string | null;
  filename: string | null;
  sourceLabel: string | null;
}

export const EMPTY_WORK_ORDERS: StoredWorkOrders = {
  uploaded: [],
  manual: [],
  uploadedAt: null,
  filename: null,
  sourceLabel: null,
};

export interface WorkOrderStore {
  get(): Promise<StoredWorkOrders>;
  /** Replace the uploaded set (a new export replaces the old one). */
  setUploaded(
    workOrders: WorkOrder[],
    meta: { uploadedAt: string; filename: string | null; sourceLabel: string | null }
  ): Promise<void>;
  addManual(workOrder: WorkOrder): Promise<void>;
  clear(): Promise<void>;
}

export class JsonWorkOrderStore implements WorkOrderStore {
  private readonly file: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, "workorders.json");
  }

  async get(): Promise<StoredWorkOrders> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as StoredWorkOrders;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(EMPTY_WORK_ORDERS);
      throw err;
    }
  }

  private async write(mutate: (s: StoredWorkOrders) => void): Promise<void> {
    const run = async () => {
      const current = await this.get();
      mutate(current);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(current), "utf8");
      await fs.rename(tmp, this.file);
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }

  setUploaded(
    workOrders: WorkOrder[],
    meta: { uploadedAt: string; filename: string | null; sourceLabel: string | null }
  ): Promise<void> {
    return this.write((s) => {
      s.uploaded = workOrders;
      s.uploadedAt = meta.uploadedAt;
      s.filename = meta.filename;
      s.sourceLabel = meta.sourceLabel;
    });
  }

  addManual(workOrder: WorkOrder): Promise<void> {
    return this.write((s) => {
      s.manual.push(workOrder);
    });
  }

  clear(): Promise<void> {
    return this.write((s) => {
      Object.assign(s, structuredClone(EMPTY_WORK_ORDERS));
    });
  }
}

export class KvWorkOrderStore implements WorkOrderStore {
  private static readonly KEY = "workorders:current";
  constructor(private readonly kv: KvClient) {}

  async get(): Promise<StoredWorkOrders> {
    return (
      (await this.kv.get<StoredWorkOrders>(KvWorkOrderStore.KEY)) ??
      structuredClone(EMPTY_WORK_ORDERS)
    );
  }
  async setUploaded(
    workOrders: WorkOrder[],
    meta: { uploadedAt: string; filename: string | null; sourceLabel: string | null }
  ): Promise<void> {
    const s = await this.get();
    await this.kv.set(KvWorkOrderStore.KEY, { ...s, uploaded: workOrders, ...meta });
  }
  async addManual(workOrder: WorkOrder): Promise<void> {
    const s = await this.get();
    s.manual.push(workOrder);
    await this.kv.set(KvWorkOrderStore.KEY, s);
  }
  async clear(): Promise<void> {
    await this.kv.set(KvWorkOrderStore.KEY, structuredClone(EMPTY_WORK_ORDERS));
  }
}

export class MemoryWorkOrderStore implements WorkOrderStore {
  private current: StoredWorkOrders = structuredClone(EMPTY_WORK_ORDERS);
  async get() {
    return structuredClone(this.current);
  }
  async setUploaded(
    workOrders: WorkOrder[],
    meta: { uploadedAt: string; filename: string | null; sourceLabel: string | null }
  ) {
    this.current = { ...this.current, uploaded: structuredClone(workOrders), ...meta };
  }
  async addManual(workOrder: WorkOrder) {
    this.current.manual.push(structuredClone(workOrder));
  }
  async clear() {
    this.current = structuredClone(EMPTY_WORK_ORDERS);
  }
}
