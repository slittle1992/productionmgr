import { promises as fs } from "node:fs";
import path from "node:path";
import type { KvClient } from "./kv/kvClient.js";

/**
 * Frozen weekly snapshots. Saving a snapshot captures the computed Friday
 * meeting (with everything the uploads produced), the staging list for the
 * following week, and the inventory position — so the week's record survives
 * later uploads replacing the "current" data.
 *
 * The stored document is the API's own view objects (MeetingView / staging /
 * inventory rows), kept as opaque JSON here so old snapshots still load even
 * as the view shape evolves.
 */

export interface SnapshotMeta {
  weekStart: string;
  weekEnd: string;
  savedAt: string;
  by: string | null;
}

export interface WeeklySnapshot extends SnapshotMeta {
  meeting: unknown;
  staging: unknown;
  inventory: unknown;
}

export interface SnapshotStore {
  save(snapshot: WeeklySnapshot): Promise<void>;
  /** Newest first. */
  list(): Promise<SnapshotMeta[]>;
  get(weekStart: string): Promise<WeeklySnapshot | null>;
}

function toMeta(s: WeeklySnapshot): SnapshotMeta {
  return { weekStart: s.weekStart, weekEnd: s.weekEnd, savedAt: s.savedAt, by: s.by };
}

function sortMeta(list: SnapshotMeta[]): SnapshotMeta[] {
  return list.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}

export class JsonSnapshotStore implements SnapshotStore {
  private readonly file: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, "snapshots.json");
  }

  private async read(): Promise<Record<string, WeeklySnapshot>> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async save(snapshot: WeeklySnapshot): Promise<void> {
    const run = async () => {
      const all = await this.read();
      all[snapshot.weekStart] = snapshot;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(all), "utf8");
      await fs.rename(tmp, this.file);
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }

  async list(): Promise<SnapshotMeta[]> {
    return sortMeta(Object.values(await this.read()).map(toMeta));
  }

  async get(weekStart: string): Promise<WeeklySnapshot | null> {
    return (await this.read())[weekStart] ?? null;
  }
}

export class KvSnapshotStore implements SnapshotStore {
  private static key(weekStart: string): string {
    return `snapshot:${weekStart}`;
  }
  private static readonly INDEX = "snapshot:index";

  constructor(private readonly kv: KvClient) {}

  async save(snapshot: WeeklySnapshot): Promise<void> {
    await this.kv.set(KvSnapshotStore.key(snapshot.weekStart), snapshot);
    // Keep an index of metas so list() doesn't have to fetch every snapshot.
    const index =
      (await this.kv.get<Record<string, SnapshotMeta>>(KvSnapshotStore.INDEX)) ?? {};
    index[snapshot.weekStart] = toMeta(snapshot);
    await this.kv.set(KvSnapshotStore.INDEX, index);
  }

  async list(): Promise<SnapshotMeta[]> {
    const index =
      (await this.kv.get<Record<string, SnapshotMeta>>(KvSnapshotStore.INDEX)) ?? {};
    return sortMeta(Object.values(index));
  }

  async get(weekStart: string): Promise<WeeklySnapshot | null> {
    return await this.kv.get<WeeklySnapshot>(KvSnapshotStore.key(weekStart));
  }
}

export class MemorySnapshotStore implements SnapshotStore {
  private state = new Map<string, WeeklySnapshot>();

  async save(snapshot: WeeklySnapshot): Promise<void> {
    this.state.set(snapshot.weekStart, structuredClone(snapshot));
  }
  async list(): Promise<SnapshotMeta[]> {
    return sortMeta([...this.state.values()].map(toMeta));
  }
  async get(weekStart: string): Promise<WeeklySnapshot | null> {
    return structuredClone(this.state.get(weekStart) ?? null);
  }
}
