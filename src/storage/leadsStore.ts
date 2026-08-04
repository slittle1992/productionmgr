import { promises as fs } from "node:fs";
import path from "node:path";
import type { CompactLead } from "../domain/leads.js";
import type { KvClient } from "./kv/kvClient.js";

/**
 * The latest Clients List (leads) upload, stored compactly. Meta lives under
 * its own key so the meeting view can show upload status without loading all
 * ~35k lead rows.
 */

export interface LeadsMeta {
  uploadedAt: string;
  filename: string | null;
  sourceLabel: string | null;
  count: number;
}

export interface LeadsStore {
  getMeta(): Promise<LeadsMeta | null>;
  getLeads(): Promise<CompactLead[]>;
  set(leads: CompactLead[], meta: LeadsMeta): Promise<void>;
}

export class JsonLeadsStore implements LeadsStore {
  private readonly file: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, "leads.json");
  }

  private async read(): Promise<{ meta: LeadsMeta | null; leads: CompactLead[] }> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return { meta: null, leads: [] };
      throw err;
    }
  }

  async getMeta() {
    return (await this.read()).meta;
  }
  async getLeads() {
    return (await this.read()).leads;
  }
  async set(leads: CompactLead[], meta: LeadsMeta): Promise<void> {
    const run = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ meta, leads }), "utf8");
      await fs.rename(tmp, this.file);
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }
}

export class KvLeadsStore implements LeadsStore {
  private static readonly META = "leads:meta";
  private static readonly ROWS = "leads:rows";
  constructor(private readonly kv: KvClient) {}

  async getMeta() {
    return await this.kv.get<LeadsMeta>(KvLeadsStore.META);
  }
  async getLeads() {
    return (await this.kv.get<CompactLead[]>(KvLeadsStore.ROWS)) ?? [];
  }
  async set(leads: CompactLead[], meta: LeadsMeta) {
    await this.kv.set(KvLeadsStore.ROWS, leads);
    await this.kv.set(KvLeadsStore.META, meta);
  }
}

export class MemoryLeadsStore implements LeadsStore {
  private meta: LeadsMeta | null = null;
  private leads: CompactLead[] = [];

  async getMeta() {
    return structuredClone(this.meta);
  }
  async getLeads() {
    return structuredClone(this.leads);
  }
  async set(leads: CompactLead[], meta: LeadsMeta) {
    this.leads = structuredClone(leads);
    this.meta = structuredClone(meta);
  }
}
