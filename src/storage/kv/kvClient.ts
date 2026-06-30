/**
 * Minimal key/value contract the durable repositories need. Backed by Redis
 * (Vercel KV / Upstash) in production and an in-memory map in tests. Values are
 * plain JS objects; the implementation handles serialisation.
 *
 * Hash operations (`hset`/`hgetall`) let the schedule store update one job's
 * assignment without a read-modify-write race across concurrent serverless
 * invocations.
 */
export interface KvClient {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  /** Keys matching a glob pattern (e.g. "report:*"). */
  keys(pattern: string): Promise<string[]>;
  hset<T>(key: string, field: string, value: T): Promise<void>;
  hgetall<T>(key: string): Promise<Record<string, T>>;
}

/** In-memory KvClient for tests. Mirrors Redis glob semantics for `*`. */
export class MemoryKvClient implements KvClient {
  private values = new Map<string, unknown>();
  private hashes = new Map<string, Map<string, unknown>>();

  async get<T>(key: string): Promise<T | null> {
    return this.values.has(key) ? structuredClone(this.values.get(key)) as T : null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async keys(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    return [...this.values.keys(), ...this.hashes.keys()].filter((k) => re.test(k));
  }
  async hset<T>(key: string, field: string, value: T): Promise<void> {
    const h = this.hashes.get(key) ?? new Map<string, unknown>();
    h.set(field, structuredClone(value));
    this.hashes.set(key, h);
  }
  async hgetall<T>(key: string): Promise<Record<string, T>> {
    const h = this.hashes.get(key);
    if (!h) return {};
    const out: Record<string, T> = {};
    for (const [f, v] of h) out[f] = structuredClone(v) as T;
    return out;
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
