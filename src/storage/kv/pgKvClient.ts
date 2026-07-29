import { neon } from "@neondatabase/serverless";
import type { KvClient } from "./kvClient.js";

/**
 * KvClient backed by Neon Postgres (HTTP driver — no TCP sockets, so it works
 * from serverless functions). Two tiny tables hold everything:
 *
 *   kv_store(key text PK, value jsonb)                 — whole-value keys
 *   kv_hash(key text, field text, value jsonb, PK(key, field)) — per-field hashes
 *
 * Tables are created on first use. Because all the app's repositories already
 * talk to the KvClient interface, pointing DATABASE_URL at Neon moves the
 * pipeline, work orders, schedule edits, reports, and roster into Postgres
 * with no changes anywhere else.
 */
export class PgKvClient implements KvClient {
  private readonly sql: ReturnType<typeof neon>;
  private ready: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  private init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.sql`
          CREATE TABLE IF NOT EXISTS kv_store (
            key   text PRIMARY KEY,
            value jsonb NOT NULL
          )`;
        await this.sql`
          CREATE TABLE IF NOT EXISTS kv_hash (
            key   text NOT NULL,
            field text NOT NULL,
            value jsonb NOT NULL,
            PRIMARY KEY (key, field)
          )`;
      })();
    }
    return this.ready;
  }

  async get<T>(key: string): Promise<T | null> {
    await this.init();
    const rows = (await this.sql`
      SELECT value FROM kv_store WHERE key = ${key}`) as Array<{ value: T }>;
    return rows.length ? rows[0]!.value : null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.init();
    await this.sql`
      INSERT INTO kv_store (key, value)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  }

  async keys(pattern: string): Promise<string[]> {
    await this.init();
    const like = pattern.replace(/[%_]/g, (m) => `\\${m}`).replace(/\*/g, "%");
    const rows = (await this.sql`
      SELECT key FROM kv_store WHERE key LIKE ${like}`) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  async hset<T>(key: string, field: string, value: T): Promise<void> {
    await this.init();
    await this.sql`
      INSERT INTO kv_hash (key, field, value)
      VALUES (${key}, ${field}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (key, field) DO UPDATE SET value = EXCLUDED.value`;
  }

  async hgetall<T>(key: string): Promise<Record<string, T>> {
    await this.init();
    const rows = (await this.sql`
      SELECT field, value FROM kv_hash WHERE key = ${key}`) as Array<{
      field: string;
      value: T;
    }>;
    const out: Record<string, T> = {};
    for (const r of rows) out[r.field] = r.value;
    return out;
  }
}
