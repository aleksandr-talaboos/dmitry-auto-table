import type { Store } from "./index.js";

type Entry = { value: unknown; expiresAt?: number };
export class MemoryStore implements Store {
  private readonly entries = new Map<string, Entry>();
  private current(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) { this.entries.delete(key); return undefined; }
    return entry;
  }
  async get<T>(key: string): Promise<T | null> { return structuredClone(this.current(key)?.value ?? null) as T | null; }
  async set<T>(key: string, value: T, options?: { ttlSeconds?: number }): Promise<void> {
    this.entries.set(key, { value: structuredClone(value),
      ...(options?.ttlSeconds !== undefined ? { expiresAt: Date.now() + options.ttlSeconds * 1000 } : {}) });
  }
  async setIfAbsent<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    if (this.current(key)) return false;
    await this.set(key, value, { ttlSeconds });
    return true;
  }
  async compareAndSet<T>(key: string, expected: T | null, value: T): Promise<boolean> {
    if (JSON.stringify(this.current(key)?.value ?? null) !== JSON.stringify(expected)) return false;
    await this.set(key, value);
    return true;
  }
  async delete(key: string): Promise<void> { this.entries.delete(key); }
  async deleteIfValue<T>(key: string, expected: T): Promise<boolean> {
    if (!this.current(key) || JSON.stringify(this.current(key)?.value) !== JSON.stringify(expected)) return false;
    this.entries.delete(key);
    return true;
  }
}
