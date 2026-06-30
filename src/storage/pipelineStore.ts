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

export interface PipelineStore {
  get(): Promise<StoredPipeline | null>;
  set(pipeline: StoredPipeline): Promise<void>;
  clear(): Promise<void>;
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
}

/** A pristine empty marker so types line up where a value is required. */
export const EMPTY_PROJECTS: BuilderPrimeProject[] = [];
