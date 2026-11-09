import { Redis } from "@upstash/redis";
import type { Store } from "./index.js";

export class RedisStore implements Store {
  private readonly redis: Redis;
  constructor(url: string, token: string) { this.redis = new Redis({ url, token, automaticDeserialization: false }); }
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get<string>(key);
    return raw === null ? null : JSON.parse(raw) as T;
  }
  async set<T>(key: string, value: T, options?: { ttlSeconds?: number }): Promise<void> {
    if (options?.ttlSeconds !== undefined) await this.redis.set(key, JSON.stringify(value), { ex: options.ttlSeconds });
    else await this.redis.set(key, JSON.stringify(value));
  }
  async setIfAbsent<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    return await this.redis.set(key, JSON.stringify(value), { nx: true, ex: ttlSeconds }) === "OK";
  }
  async compareAndSet<T>(key: string, expected: T | null, value: T): Promise<boolean> {
    const script = "local v=redis.call('GET',KEYS[1]); if (v or 'null')~=ARGV[1] then return 0 end; " +
      "redis.call('SET',KEYS[1],ARGV[2]); return 1";
    return Number(await this.redis.eval(script, [key], [JSON.stringify(expected), JSON.stringify(value)])) === 1;
  }
  async delete(key: string): Promise<void> { await this.redis.del(key); }
  async deleteIfValue<T>(key: string, expected: T): Promise<boolean> {
    const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
    return Number(await this.redis.eval(script, [key], [JSON.stringify(expected)])) === 1;
  }
}
