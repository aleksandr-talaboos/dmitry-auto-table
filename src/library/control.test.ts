import { describe, expect, it, vi } from "vitest";
import { ExperimentBinomSource } from "../binom/client.js";
import { BinomRequestGate } from "../binom/gate.js";
import { parseLibraryConfig } from "../config.js";
import { MemoryStore } from "../store/memory.js";
import { collectLibrary } from "./collect.js";
import { computeLibrary } from "./compute.js";
import { parentCacheKey } from "./control.js";

const DAY = "2026-10-05";
const reply = (body: unknown) => new Response(JSON.stringify(body));
const list = [{ id: 1, name: "E001 [TEST]", groupName: "IQ" }, { id: 100, name: "IQ funnel [MAIN]", groupName: "IQ" },
  { id: 200, name: "Zodeya [MAIN]", groupName: "Zodeya" }];
// The IQ main sends half of its traffic to the test and half directly to offer 8 (T005).
const parent = { id: 100, name: "IQ funnel [MAIN]", link: "https://binom.example/main", customRotation: { rules: [],
  defaultPaths: [{ enabled: true, weight: 100, offers: [{ offerId: 0, campaignId: 1, weight: 50, enabled: true },
    { offerId: 8, campaignId: 0, weight: 50, enabled: true, name: "T005" }] }] } };
const offers: Array<[number, string, number]> = [[8, "T005", 50], [9, "T002", 60]];

function setup(env: Record<string, string> = {}) {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("campaign/list/filtered")) return reply(list);
    if (url.pathname.endsWith("campaign/100")) return reply(parent);
    const withDays = url.searchParams.getAll("groupings[]").includes("days");
    const rows = [{ level: "1", entity_id: "1", name: "E001 [TEST]", unique_clicks: "2000", leads: "110", clicks: "2000", revenue: "200" },
      ...offers.flatMap(([id, name, leads]) => [
        { level: "2", entity_id: String(id), name, unique_clicks: "1000", leads: String(leads), clicks: "1000", revenue: "100" },
        ...withDays ? [{ level: "3", name: DAY, unique_clicks: "1000", leads: String(leads), clicks: "1000", revenue: "100" }] : []])];
    return reply({ report: rows, totals: { total_count: String(rows.length) } });
  });
  const binom = new ExperimentBinomSource({ baseUrl: "https://binom.example", apiKey: "k".repeat(20),
    gate: new BinomRequestGate({ minIntervalMs: 0 }), fetchImpl: fetchImpl as typeof fetch });
  const config = parseLibraryConfig({ BINOM_BASE_URL: "https://binom.example", BINOM_API_KEY: "k".repeat(20), ...env });
  const store = new MemoryStore();
  const log = vi.fn();
  const collect = async () => computeLibrary((await collectLibrary({ binom, config, day: DAY, store, log,
    now: new Date("2026-10-06T06:30:00Z") })).input);
  const parentReads = () => fetchImpl.mock.calls.filter(([input]) => String(input).endsWith("/campaign/100")).length;
  return { collect, store, log, parentReads };
}

describe("library control choice", () => {
  it("lets a base-offer override win without reading parents", async () => {
    const test = setup({ LIBRARY_BASE_OFFER_OVERRIDES: "1:9" });
    expect((await test.collect())[0].controlKey).toBe("o:9");
    expect(test.parentReads()).toBe(0);
  });
  it("uses the parent's direct-offer share and caches the parent for 24 hours", async () => {
    const test = setup();
    expect((await test.collect())[0].controlKey).toBe("o:8");
    expect(test.parentReads()).toBe(1);
    expect(await test.store.get(parentCacheKey(100))).toMatchObject({ id: 100 });
    expect((await test.collect())[0].controlKey).toBe("o:8");
    expect(test.parentReads()).toBe(1);
  });
  it("falls back to the smallest T number without a parent route", async () => {
    const test = setup();
    await test.store.set(parentCacheKey(100), { ...parent, customRotation: { rules: [], defaultPaths: [] } });
    expect((await test.collect())[0].controlKey).toBe("o:9");
    expect(test.parentReads()).toBe(0);
  });
  it("skips parents when the request budget is spent and keeps the run", async () => {
    const test = setup({ LIBRARY_REQUEST_BUDGET: "3" });
    const rows = await test.collect();
    expect(rows[0].controlKey).toBe("o:9");
    expect(test.parentReads()).toBe(0);
    expect(test.log).toHaveBeenCalledWith(expect.objectContaining({ level: "warn",
      msg: expect.stringContaining("request budget exhausted"), skipped: 1 }));
  });
});
