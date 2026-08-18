import { promises as fs } from "node:fs";
import path from "node:path";
import type { BuilderPrimeProject } from "../builderPrime/types.js";
import type { KvClient } from "./kv/kvClient.js";

/** The current uploaded pipeline, plus metadata for the upload banner/summary. */
export interface StoredPipeline {
  projects: BuilderPrimeProject[];
  uploadedAt: string;
  filename: string | null;
  rowCount: number;
  classes: Record<string, number>;
  sourceLabel: string | null;
}

/** Metadata only — what the UI needs without shipping every project twice. */
export type PipelineMeta = Omit<StoredPipeline, "projects">;

/** SQFT/color remembered per job across every pipeline upload — completed
 * jobs age out of the current pipeline export, so lookups need this history. */
export interface JobFacts {
  sqft: number | null;
  color: string | null;
}

export interface PipelineStore {
  get(): Promise<StoredPipeline | null>;
  set(pipeline: StoredPipeline): Promise<void>;
  clear(): Promise<void>;
  getJobFacts(): Promise<Record<string, JobFacts>>;
  /** Merge (upsert) facts; existing jobs keep newer non-null values. */
  mergeJobFacts(facts: Record<string, JobFacts>): Promise<void>;
}

function mergeFactMaps(
  current: Record<string, JobFacts>,
  updates: Record<string, JobFacts>
): Record<string, JobFacts> {
  const next = { ...current };
  for (const [key, f] of Object.entries(updates)) {
    const old = next[key];
    next[key] = {
      sqft: f.sqft ?? old?.sqft ?? null,
      color: f.color ?? old?.color ?? null,
    };
  }
  return next;
}

export function toMeta(p: StoredPipeline): PipelineMeta {
  const { projects: _omit, ...meta } = p;
  return meta;
}

/** File-backed pipeline store (single JSON file). */
export class JsonPipelineStore implements PipelineStore {
  private readonly file: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, "pipeline.json");
  }

  async get(): Promise<StoredPipeline | null> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as StoredPipeline;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async set(pipeline: StoredPipeline): Promise<void> {
    const run = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(pipeline), "utf8");
      await fs.rename(tmp, this.file);
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private get factsFile(): string {
    return this.file.replace(/pipeline\.json$/, "job-facts.json");
  }
  async getJobFacts(): Promise<Record<string, JobFacts>> {
    try {
      return JSON.parse(await fs.readFile(this.factsFile, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }
  async mergeJobFacts(facts: Record<string, JobFacts>): Promise<void> {
    const run = async () => {
      const current = await this.getJobFacts();
      await fs.mkdir(path.dirname(this.factsFile), { recursive: true });
      const tmp = `${this.factsFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(mergeFactMaps(current, facts)), "utf8");
      await fs.rename(tmp, this.factsFile);
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }
}

/** KV-backed pipeline store (Vercel KV / Upstash). */
export class KvPipelineStore implements PipelineStore {
  private static readonly KEY = "pipeline:current";
  constructor(private readonly kv: KvClient) {}

  get(): Promise<StoredPipeline | null> {
    return this.kv.get<StoredPipeline>(KvPipelineStore.KEY);
  }
  async set(pipeline: StoredPipeline): Promise<void> {
    await this.kv.set(KvPipelineStore.KEY, pipeline);
  }
  async clear(): Promise<void> {
    await this.kv.set(KvPipelineStore.KEY, null as unknown as StoredPipeline);
  }
  private static readonly FACTS = "pipeline:jobfacts";
  async getJobFacts(): Promise<Record<string, JobFacts>> {
    return (
      (await this.kv.get<Record<string, JobFacts>>(KvPipelineStore.FACTS)) ?? {}
    );
  }
  async mergeJobFacts(facts: Record<string, JobFacts>): Promise<void> {
    await this.kv.set(
      KvPipelineStore.FACTS,
      mergeFactMaps(await this.getJobFacts(), facts)
    );
  }
}

/** In-memory pipeline store for tests. */
export class MemoryPipelineStore implements PipelineStore {
  private current: StoredPipeline | null = null;
  async get(): Promise<StoredPipeline | null> {
    return this.current ? structuredClone(this.current) : null;
  }
  async set(pipeline: StoredPipeline): Promise<void> {
    this.current = structuredClone(pipeline);
  }
  async clear(): Promise<void> {
    this.current = null;
  }
  private facts: Record<string, JobFacts> = {};
  async getJobFacts(): Promise<Record<string, JobFacts>> {
    return structuredClone(this.facts);
  }
  async mergeJobFacts(facts: Record<string, JobFacts>): Promise<void> {
    this.facts = mergeFactMaps(this.facts, facts);
  }
}

/** A pristine empty marker so types line up where a value is required. */
export const EMPTY_PROJECTS: BuilderPrimeProject[] = [];
