import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Store } from "./index.js";

type Entry = { value: unknown; expiresAt?: number };
export class FileStore implements Store {
  constructor(private readonly directory: string) {}
  private path(key: string): string { return join(this.directory, `${Buffer.from(key).toString("base64url")}.json`); }
  private async read(key: string): Promise<Entry | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.path(key), "utf8")) as Entry;
      return entry.expiresAt !== undefined && entry.expiresAt <= Date.now() ? undefined : entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lock = `${this.path(key)}.lock`;
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try { if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await rm(lock, { recursive: true, force: true }); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
        await delay(20);
      }
    }
    try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
  private async write(key: string, entry: Entry): Promise<void> {
    const file = this.path(key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(entry), "utf8"); } finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  async get<T>(key: string): Promise<T | null> { return (await this.read(key))?.value as T ?? null; }
  async set<T>(key: string, value: T, options?: { ttlSeconds?: number }): Promise<void> {
    await this.locked(key, () => this.write(key, { value,
      ...(options?.ttlSeconds !== undefined ? { expiresAt: Date.now() + options.ttlSeconds * 1000 } : {}) }));
  }
  async setIfAbsent<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    return this.locked(key, async () => {
      if (await this.read(key)) return false;
      await this.write(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return true;
    });
  }
  async compareAndSet<T>(key: string, expected: T | null, value: T): Promise<boolean> {
    return this.locked(key, async () => {
      if (JSON.stringify((await this.read(key))?.value ?? null) !== JSON.stringify(expected)) return false;
      await this.write(key, { value });
      return true;
    });
  }
  async delete(key: string): Promise<void> { await this.locked(key, () => rm(this.path(key), { force: true })); }
  async deleteIfValue<T>(key: string, expected: T): Promise<boolean> {
    return this.locked(key, async () => {
      const current = await this.read(key);
      if (!current || JSON.stringify(current.value) !== JSON.stringify(expected)) return false;
      await rm(this.path(key), { force: true });
      return true;
    });
  }
}
