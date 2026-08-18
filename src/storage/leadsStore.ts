import { promises as fs } from "node:fs";
import path from "node:path";
import type { CompactLead } from "../domain/leads.js";
import type { PerfParseResult, SoldContract } from "../domain/sales.js";
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

export interface StoredSold {
  rows: SoldContract[];
  uploadedAt: string;
  filename: string | null;
  sourceLabel: string | null;
}

export interface StoredPerf extends PerfParseResult {
  uploadedAt: string;
  filename: string | null;
}

export interface LeadsStore {
  getSold(): Promise<StoredSold | null>;
  setSold(sold: StoredSold): Promise<void>;
  getPerf(): Promise<StoredPerf | null>;
  setPerf(perf: StoredPerf): Promise<void>;
  getMeta(): Promise<LeadsMeta | null>;
  getLeads(): Promise<CompactLead[]>;
  set(leads: CompactLead[], meta: LeadsMeta): Promise<void>;
  /**
   * Chunked upload (the full export is too big for one serverless request).
   * begin replaces the rows and clears the meta; append verifies the same
   * upload is still in progress; finalize writes the meta and returns the
   * total count (null when the upload id doesn't match — a competing upload).
   */
  beginUpload(uploadId: string, leads: CompactLead[]): Promise<void>;
  appendUpload(uploadId: string, leads: CompactLead[]): Promise<boolean>;
  finalizeUpload(
    uploadId: string,
    meta: Omit<LeadsMeta, "count">
  ): Promise<number | null>;
}

interface LeadsFileShape {
  meta: LeadsMeta | null;
  leads: CompactLead[];
  pendingId: string | null;
}

export class JsonLeadsStore implements LeadsStore {
  private readonly file: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, "leads.json");
  }

  private async read(): Promise<LeadsFileShape> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      return { meta: null, leads: [], pendingId: null, ...raw };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return { meta: null, leads: [], pendingId: null };
      throw err;
    }
  }

  private async write(mutate: (s: LeadsFileShape) => void): Promise<LeadsFileShape> {
    let result!: LeadsFileShape;
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

  private get salesFile(): string {
    return this.file.replace(/leads\.json$/, "sales.json");
  }
  private async readSales(): Promise<{ sold: StoredSold | null; perf: StoredPerf | null }> {
    try {
      return JSON.parse(await fs.readFile(this.salesFile, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return { sold: null, perf: null };
      throw err;
    }
  }
  private async writeSales(
    mutate: (s: { sold: StoredSold | null; perf: StoredPerf | null }) => void
  ): Promise<void> {
    const run = async () => {
      const current = await this.readSales();
      mutate(current);
      await fs.mkdir(path.dirname(this.salesFile), { recursive: true });
      const tmp = `${this.salesFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(current), "utf8");
      await fs.rename(tmp, this.salesFile);
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }
  async getSold() {
    return (await this.readSales()).sold;
  }
  async setSold(sold: StoredSold) {
    await this.writeSales((s) => {
      s.sold = sold;
    });
  }
  async getPerf() {
    return (await this.readSales()).perf;
  }
  async setPerf(perf: StoredPerf) {
    await this.writeSales((s) => {
      s.perf = perf;
    });
  }
  async getMeta() {
    return (await this.read()).meta;
  }
  async getLeads() {
    return (await this.read()).leads;
  }
  async set(leads: CompactLead[], meta: LeadsMeta): Promise<void> {
    await this.write((s) => {
      s.leads = leads;
      s.meta = meta;
      s.pendingId = null;
    });
  }
  async beginUpload(uploadId: string, leads: CompactLead[]): Promise<void> {
    await this.write((s) => {
      s.leads = leads;
      s.meta = null;
      s.pendingId = uploadId;
    });
  }
  async appendUpload(uploadId: string, leads: CompactLead[]): Promise<boolean> {
    let ok = false;
    await this.write((s) => {
      if (s.pendingId !== uploadId) return;
      ok = true;
      s.leads.push(...leads);
    });
    return ok;
  }
  async finalizeUpload(
    uploadId: string,
    meta: Omit<LeadsMeta, "count">
  ): Promise<number | null> {
    let count: number | null = null;
    await this.write((s) => {
      if (s.pendingId !== uploadId) return;
      count = s.leads.length;
      s.meta = { ...meta, count };
      s.pendingId = null;
    });
    return count;
  }
}

export class KvLeadsStore implements LeadsStore {
  private static readonly META = "leads:meta";
  private static readonly ROWS = "leads:rows";
  private static readonly PENDING = "leads:pending";
  private static readonly SOLD = "sales:sold";
  private static readonly PERF = "sales:perf";
  constructor(private readonly kv: KvClient) {}

  async getSold() {
    return await this.kv.get<StoredSold>(KvLeadsStore.SOLD);
  }
  async setSold(sold: StoredSold) {
    await this.kv.set(KvLeadsStore.SOLD, sold);
  }
  async getPerf() {
    return await this.kv.get<StoredPerf>(KvLeadsStore.PERF);
  }
  async setPerf(perf: StoredPerf) {
    await this.kv.set(KvLeadsStore.PERF, perf);
  }

  async getMeta() {
    return await this.kv.get<LeadsMeta>(KvLeadsStore.META);
  }
  async getLeads() {
    return (await this.kv.get<CompactLead[]>(KvLeadsStore.ROWS)) ?? [];
  }
  async set(leads: CompactLead[], meta: LeadsMeta) {
    await this.kv.set(KvLeadsStore.ROWS, leads);
    await this.kv.set(KvLeadsStore.META, meta);
    await this.kv.set(KvLeadsStore.PENDING, null);
  }
  async beginUpload(uploadId: string, leads: CompactLead[]) {
    await this.kv.set(KvLeadsStore.ROWS, leads);
    await this.kv.set(KvLeadsStore.META, null);
    await this.kv.set(KvLeadsStore.PENDING, uploadId);
  }
  async appendUpload(uploadId: string, leads: CompactLead[]) {
    const pending = await this.kv.get<string>(KvLeadsStore.PENDING);
    if (pending !== uploadId) return false;
    const rows = await this.getLeads();
    rows.push(...leads);
    await this.kv.set(KvLeadsStore.ROWS, rows);
    return true;
  }
  async finalizeUpload(uploadId: string, meta: Omit<LeadsMeta, "count">) {
    const pending = await this.kv.get<string>(KvLeadsStore.PENDING);
    if (pending !== uploadId) return null;
    const count = (await this.getLeads()).length;
    await this.kv.set(KvLeadsStore.META, { ...meta, count });
    await this.kv.set(KvLeadsStore.PENDING, null);
    return count;
  }
}

export class MemoryLeadsStore implements LeadsStore {
  private meta: LeadsMeta | null = null;
  private sold: StoredSold | null = null;
  private perf: StoredPerf | null = null;

  async getSold() {
    return structuredClone(this.sold);
  }
  async setSold(sold: StoredSold) {
    this.sold = structuredClone(sold);
  }
  async getPerf() {
    return structuredClone(this.perf);
  }
  async setPerf(perf: StoredPerf) {
    this.perf = structuredClone(perf);
  }
  private leads: CompactLead[] = [];
  private pendingId: string | null = null;

  async getMeta() {
    return structuredClone(this.meta);
  }
  async getLeads() {
    return structuredClone(this.leads);
  }
  async set(leads: CompactLead[], meta: LeadsMeta) {
    this.leads = structuredClone(leads);
    this.meta = structuredClone(meta);
    this.pendingId = null;
  }
  async beginUpload(uploadId: string, leads: CompactLead[]) {
    this.leads = structuredClone(leads);
    this.meta = null;
    this.pendingId = uploadId;
  }
  async appendUpload(uploadId: string, leads: CompactLead[]) {
    if (this.pendingId !== uploadId) return false;
    this.leads.push(...structuredClone(leads));
    return true;
  }
  async finalizeUpload(uploadId: string, meta: Omit<LeadsMeta, "count">) {
    if (this.pendingId !== uploadId) return null;
    this.meta = { ...meta, count: this.leads.length };
    this.pendingId = null;
    return this.leads.length;
  }
}
