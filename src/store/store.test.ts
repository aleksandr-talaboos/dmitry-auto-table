import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileStore } from "./file.js";
import { configuredStore, type Store } from "./index.js";
import { MemoryStore } from "./memory.js";
import { RedisStore } from "./redis.js";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });

const stores: Array<[string, () => Promise<Store>]> = [
  ["MemoryStore", async () => new MemoryStore()],
  ["FileStore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "library-store-"));
    directories.push(directory);
    return new FileStore(join(directory, ".state"));
  }]
];

describe.each(stores)("%s", (_, create) => {
  it("takes a lock once until it expires or is released by its owner", async () => {
    const store = await create();
    expect(await store.setIfAbsent("library:lock", "a", 900)).toBe(true);
    expect(await store.setIfAbsent("library:lock", "b", 900)).toBe(false);
    expect(await store.deleteIfValue("library:lock", "b")).toBe(false);
    expect(await store.deleteIfValue("library:lock", "a")).toBe(true);
    expect(await store.setIfAbsent("library:lock", "b", 0)).toBe(true);
    expect(await store.get("library:lock")).toBeNull();
    expect(await store.setIfAbsent("library:lock", "c", 900)).toBe(true);
  });
  it("compares and sets JSON values", async () => {
    const store = await create();
    expect(await store.compareAndSet("cw:credentials", { token: "x" }, { token: "y" })).toBe(false);
    expect(await store.compareAndSet("cw:credentials", null, { token: "a" })).toBe(true);
    expect(await store.compareAndSet("cw:credentials", { token: "b" }, { token: "c" })).toBe(false);
    expect(await store.compareAndSet("cw:credentials", { token: "a" }, { token: "c" })).toBe(true);
    expect(await store.get("cw:credentials")).toEqual({ token: "c" });
    await store.set("library:arms", { version: 1, arms: {} }, { ttlSeconds: 60 });
    expect(await store.get("library:arms")).toEqual({ version: 1, arms: {} });
    await store.delete("library:arms");
    expect(await store.get("library:arms")).toBeNull();
  });
});

describe("configuredStore", () => {
  it("accepts Upstash and Vercel KV names and falls back to files only locally", () => {
    expect(configuredStore({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" })).toBeInstanceOf(RedisStore);
    expect(configuredStore({ KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" })).toBeInstanceOf(RedisStore);
    expect(() => configuredStore({ KV_REST_API_URL: "https://x.upstash.io" })).toThrow("both");
    expect(() => configuredStore({})).toThrow("required");
    expect(configuredStore({}, true)).toBeInstanceOf(FileStore);
  });
});
