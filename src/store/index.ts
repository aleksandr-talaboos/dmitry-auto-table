import { RedisStore } from "./redis.js";
import { FileStore } from "./file.js";

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: { ttlSeconds?: number }): Promise<void>;
  setIfAbsent<T>(key: string, value: T, ttlSeconds: number): Promise<boolean>;
  compareAndSet<T>(key: string, expected: T | null, value: T): Promise<boolean>;
  delete(key: string): Promise<void>;
  deleteIfValue<T>(key: string, expected: T): Promise<boolean>;
}

export function configuredStore(env: NodeJS.ProcessEnv = process.env, local = false): Store {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new RedisStore(url, token);
  if (url || token) throw new Error("Redis URL and token must both be configured");
  if (local) return new FileStore(".state");
  throw new Error("Redis URL and token are required for the serverless function");
}
