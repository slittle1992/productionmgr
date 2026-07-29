import { promises as fs } from "node:fs";
import path from "node:path";
import type { Installer } from "../domain/roster.js";
import type { KvClient } from "./kv/kvClient.js";

/** Admin-maintained installer roster. */
export interface RosterStore {
  list(): Promise<Installer[]>;
  upsert(installer: Installer): Promise<void>;
  remove(id: string): Promise<void>;
}

export class JsonRosterStore implements RosterStore {
  private readonly file: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, "roster.json");
  }

  async list(): Promise<Installer[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as Installer[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async write(mutate: (list: Installer[]) => Installer[]): Promise<void> {
    const run = async () => {
      const next = mutate(await this.list());
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
      await fs.rename(tmp, this.file);
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }

  upsert(installer: Installer): Promise<void> {
    return this.write((list) => [
      ...list.filter((i) => i.id !== installer.id),
      installer,
    ]);
  }

  remove(id: string): Promise<void> {
    return this.write((list) => list.filter((i) => i.id !== id));
  }
}

export class KvRosterStore implements RosterStore {
  private static readonly KEY = "roster:current";
  constructor(private readonly kv: KvClient) {}

  async list(): Promise<Installer[]> {
    return (await this.kv.get<Installer[]>(KvRosterStore.KEY)) ?? [];
  }
  async upsert(installer: Installer): Promise<void> {
    const list = await this.list();
    await this.kv.set(KvRosterStore.KEY, [
      ...list.filter((i) => i.id !== installer.id),
      installer,
    ]);
  }
  async remove(id: string): Promise<void> {
    const list = await this.list();
    await this.kv.set(
      KvRosterStore.KEY,
      list.filter((i) => i.id !== id)
    );
  }
}

export class MemoryRosterStore implements RosterStore {
  private items: Installer[] = [];
  async list() {
    return structuredClone(this.items);
  }
  async upsert(installer: Installer) {
    this.items = [...this.items.filter((i) => i.id !== installer.id), structuredClone(installer)];
  }
  async remove(id: string) {
    this.items = this.items.filter((i) => i.id !== id);
  }
}
