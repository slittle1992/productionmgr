import { promises as fs } from "node:fs";
import path from "node:path";
import type { RepAppointments } from "../domain/appointments.js";
import type { CompactLead } from "../domain/leads.js";
import type { LeadGoals, PerfParseResult, SoldContract } from "../domain/sales.js";
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

/** One week's Meetings-export rollup, kept week over week for the sales tab. */
export interface StoredApptsWeek {
  weekStart: string;
  total: number;
  cancelled: number;
  byRep: RepAppointments[];
  uploadedAt: string;
  filename: string | null;
  sourceLabel: string | null;
}

export interface LeadsStore {
  getSold(): Promise<StoredSold | null>;
  setSold(sold: StoredSold): Promise<void>;
  /** Chunked sold-contracts upload (large date ranges exceed one request). */
  beginSoldUpload(uploadId: string, rows: SoldContract[]): Promise<void>;
  appendSoldUpload(uploadId: string, rows: SoldContract[]): Promise<boolean>;
  finalizeSoldUpload(
    uploadId: string,
    meta: Omit<StoredSold, "rows">
  ): Promise<number | null>;
  getPerf(): Promise<StoredPerf | null>;
  setPerf(perf: StoredPerf): Promise<void>;
  /** Appointment rollups keyed by weekStart (re-upload replaces the week). */
  getAppts(): Promise<Record<string, StoredApptsWeek>>;
  setApptsWeek(week: StoredApptsWeek): Promise<void>;
  /** Monthly lead goals (flake/rubber) for the Daily pacing view. */
  getGoals(): Promise<LeadGoals>;
  setGoals(goals: LeadGoals): Promise<void>;
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

const EMPTY_GOALS: LeadGoals = { flakeMonthly: null, rubberMonthly: null };

interface PendingSold {
  id: string;
  rows: SoldContract[];
}

interface SalesFileShape {
  sold: StoredSold | null;
  perf: StoredPerf | null;
  appts: Record<string, StoredApptsWeek>;
  goals: LeadGoals;
  pendingSold: PendingSold | null;
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
  private async readSales(): Promise<SalesFileShape> {
    try {
      const raw = JSON.parse(await fs.readFile(this.salesFile, "utf8"));
      return {
        sold: null,
        perf: null,
        appts: {},
        goals: EMPTY_GOALS,
        pendingSold: null,
        ...raw,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return {
          sold: null,
          perf: null,
          appts: {},
          goals: EMPTY_GOALS,
          pendingSold: null,
        };
      throw err;
    }
  }
  private async writeSales(mutate: (s: SalesFileShape) => void): Promise<void> {
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
      s.pendingSold = null;
    });
  }
  async beginSoldUpload(uploadId: string, rows: SoldContract[]) {
    await this.writeSales((s) => {
      s.pendingSold = { id: uploadId, rows };
    });
  }
  async appendSoldUpload(uploadId: string, rows: SoldContract[]) {
    let ok = false;
    await this.writeSales((s) => {
      if (s.pendingSold?.id !== uploadId) return;
      ok = true;
      s.pendingSold.rows.push(...rows);
    });
    return ok;
  }
  async finalizeSoldUpload(uploadId: string, meta: Omit<StoredSold, "rows">) {
    let count: number | null = null;
    await this.writeSales((s) => {
      if (s.pendingSold?.id !== uploadId) return;
      count = s.pendingSold.rows.length;
      s.sold = { ...meta, rows: s.pendingSold.rows };
      s.pendingSold = null;
    });
    return count;
  }
  async getPerf() {
    return (await this.readSales()).perf;
  }
  async setPerf(perf: StoredPerf) {
    await this.writeSales((s) => {
      s.perf = perf;
    });
  }
  async getAppts() {
    return (await this.readSales()).appts;
  }
  async setApptsWeek(week: StoredApptsWeek) {
    await this.writeSales((s) => {
      s.appts[week.weekStart] = week;
    });
  }
  async getGoals() {
    return (await this.readSales()).goals;
  }
  async setGoals(goals: LeadGoals) {
    await this.writeSales((s) => {
      s.goals = goals;
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
  private static readonly APPTS = "sales:appts";
  constructor(private readonly kv: KvClient) {}

  async getSold() {
    return await this.kv.get<StoredSold>(KvLeadsStore.SOLD);
  }
  async setSold(sold: StoredSold) {
    await this.kv.set(KvLeadsStore.SOLD, sold);
    await this.kv.set(KvLeadsStore.SOLD_PENDING, null);
  }
  private static readonly SOLD_PENDING = "sales:soldpending";
  async beginSoldUpload(uploadId: string, rows: SoldContract[]) {
    await this.kv.set(KvLeadsStore.SOLD_PENDING, { id: uploadId, rows });
  }
  async appendSoldUpload(uploadId: string, rows: SoldContract[]) {
    const pending = await this.kv.get<{ id: string; rows: SoldContract[] }>(
      KvLeadsStore.SOLD_PENDING
    );
    if (pending?.id !== uploadId) return false;
    pending.rows.push(...rows);
    await this.kv.set(KvLeadsStore.SOLD_PENDING, pending);
    return true;
  }
  async finalizeSoldUpload(uploadId: string, meta: Omit<StoredSold, "rows">) {
    const pending = await this.kv.get<{ id: string; rows: SoldContract[] }>(
      KvLeadsStore.SOLD_PENDING
    );
    if (pending?.id !== uploadId) return null;
    await this.kv.set(KvLeadsStore.SOLD, { ...meta, rows: pending.rows });
    await this.kv.set(KvLeadsStore.SOLD_PENDING, null);
    return pending.rows.length;
  }
  async getPerf() {
    return await this.kv.get<StoredPerf>(KvLeadsStore.PERF);
  }
  async setPerf(perf: StoredPerf) {
    await this.kv.set(KvLeadsStore.PERF, perf);
  }
  async getAppts() {
    return (
      (await this.kv.get<Record<string, StoredApptsWeek>>(KvLeadsStore.APPTS)) ??
      {}
    );
  }
  async setApptsWeek(week: StoredApptsWeek) {
    const all = await this.getAppts();
    all[week.weekStart] = week;
    await this.kv.set(KvLeadsStore.APPTS, all);
  }
  private static readonly GOALS = "sales:goals";
  async getGoals() {
    return (
      (await this.kv.get<LeadGoals>(KvLeadsStore.GOALS)) ?? { ...EMPTY_GOALS }
    );
  }
  async setGoals(goals: LeadGoals) {
    await this.kv.set(KvLeadsStore.GOALS, goals);
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
    this.pendingSold = null;
  }
  private pendingSold: { id: string; rows: SoldContract[] } | null = null;
  async beginSoldUpload(uploadId: string, rows: SoldContract[]) {
    this.pendingSold = { id: uploadId, rows: structuredClone(rows) };
  }
  async appendSoldUpload(uploadId: string, rows: SoldContract[]) {
    if (this.pendingSold?.id !== uploadId) return false;
    this.pendingSold.rows.push(...structuredClone(rows));
    return true;
  }
  async finalizeSoldUpload(uploadId: string, meta: Omit<StoredSold, "rows">) {
    if (this.pendingSold?.id !== uploadId) return null;
    this.sold = { ...structuredClone(meta), rows: this.pendingSold.rows };
    const n = this.pendingSold.rows.length;
    this.pendingSold = null;
    return n;
  }
  async getPerf() {
    return structuredClone(this.perf);
  }
  async setPerf(perf: StoredPerf) {
    this.perf = structuredClone(perf);
  }
  private appts: Record<string, StoredApptsWeek> = {};
  async getAppts() {
    return structuredClone(this.appts);
  }
  async setApptsWeek(week: StoredApptsWeek) {
    this.appts[week.weekStart] = structuredClone(week);
  }
  private goals: LeadGoals = { ...EMPTY_GOALS };
  async getGoals() {
    return structuredClone(this.goals);
  }
  async setGoals(goals: LeadGoals) {
    this.goals = structuredClone(goals);
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
