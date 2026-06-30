import { Redis } from "@upstash/redis";
import type { KvClient } from "./kvClient.js";

/**
 * KvClient backed by Upstash Redis over HTTP REST — the same engine behind
 * Vercel KV. REST means no persistent TCP connection, so it works cleanly from
 * serverless functions. Reads/writes whole JSON objects per key, and uses Redis
 * hashes for per-field updates.
 */
export class UpstashKvClient implements KvClient {
  private readonly redis: Redis;

  constructor(url: string, token: string) {
    // automaticDeserialization (default) JSON-encodes on write and parses on read.
    this.redis = new Redis({ url, token });
  }

  async get<T>(key: string): Promise<T | null> {
    return (await this.redis.get<T>(key)) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.redis.set(key, value as unknown as string);
  }

  async keys(pattern: string): Promise<string[]> {
    // Datasets here are tiny (one entry per week), so KEYS is fine.
    return this.redis.keys(pattern);
  }

  async hset<T>(key: string, field: string, value: T): Promise<void> {
    await this.redis.hset(key, { [field]: value });
  }

  async hgetall<T>(key: string): Promise<Record<string, T>> {
    return (await this.redis.hgetall<Record<string, T>>(key)) ?? {};
  }
}
