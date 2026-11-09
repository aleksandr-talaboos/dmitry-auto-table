import { describe, expect, it, vi } from "vitest";
import { ExperimentBinomSource } from "../binom/client.js";
import { BinomRequestGate } from "../binom/gate.js";
import type { SheetsApi } from "../sheets/client.js";
import { MemoryStore } from "../store/memory.js";
import { LIBRARY_HEADER } from "./layout.js";
import { finalKey, handleRun, LOCK_KEY } from "./run.js";

const DAY = "2026-10-05";
const NOW = new Date("2026-10-06T06:30:00Z");
const SECRET = "cron-secret-value-0123456789abcdefgh";
const env = { CRON_SECRET: SECRET, BINOM_BASE_URL: "https://binom.example", BINOM_API_KEY: "k".repeat(20) };
const writeEnv = { ...env, LIBRARY_MODE: "write", LIBRARY_SPREADSHEET_ID: "sheet-id",
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "bot@example.iam.gserviceaccount.com", private_key: "key" }) };
const auth = { authorization: `Bearer ${SECRET}` };

// Campaign 12 resolves to the Subcaddy CW project, so its run needs CW; campaign 1 has no CW project.
function setup(campaignId = 1) {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("campaign/list/filtered")) {
      return new Response(JSON.stringify([{ id: campaignId, name: "E001 [TEST]" }]));
    }
    const rows = [{ level: "1", entity_id: String(campaignId), name: "E001 [TEST]", unique_clicks: "0", leads: "0", clicks: "0",
      revenue: "0" }];
    return new Response(JSON.stringify({ report: rows, totals: { total_count: "1" } }));
  });
  const binom = new ExperimentBinomSource({ baseUrl: "https://binom.example", apiKey: "k".repeat(20),
    gate: new BinomRequestGate({ minIntervalMs: 0 }), fetchImpl: fetchImpl as typeof fetch });
  const sheets: SheetsApi = { getSpreadsheet: vi.fn(async () => ({ sheets: [] })), batchGetValues: vi.fn(), batchUpdate: vi.fn() };
  const writeSheet = vi.fn(async () => ({ title: "Library", sheetId: 7, created: true }));
  const store = new MemoryStore();
  const alerts = vi.fn(async () => new Response("ok"));
  const call = (query: Record<string, string>, headers: Record<string, string> = auth, environment: NodeJS.ProcessEnv = env) =>
    handleRun({ headers, query }, environment, { store: () => store, binom, sheets, writeSheet, now: NOW, log: vi.fn(),
      fetchImpl: alerts as unknown as typeof fetch });
  return { call, store, fetchImpl, writeSheet, alerts };
}

describe("api/run handler", () => {
  it("rejects a missing or wrong cron secret", async () => {
    const test = setup();
    expect((await test.call({}, {})).status).toBe(401);
    expect((await test.call({}, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await test.call({}, { authorization: SECRET })).status).toBe(401);
    const short = await test.call({}, { authorization: "Bearer short-secret" }, { ...env, CRON_SECRET: "short-secret" });
    expect(short.status).toBe(500);
    expect(short.body).toContain("at least 32");
    expect(test.fetchImpl).not.toHaveBeenCalled();
  });
  it("does nothing when the library is off", async () => {
    const test = setup();
    const result = await test.call({}, auth, { ...env, LIBRARY_MODE: "off" });
    expect(result).toMatchObject({ status: 200 });
    expect(JSON.parse(result.body)).toEqual({ skipped: "off" });
    expect(test.fetchImpl).not.toHaveBeenCalled();
  });
  it("returns the CSV for a dry run and never calls the sheet writer", async () => {
    const test = setup();
    for (const [query, environment] of [[{ date: DAY }, env], [{ date: DAY, dryRun: "1" }, writeEnv]] as const) {
      const result = await test.call(query, auth, environment);
      expect(result.status).toBe(200);
      expect(result.contentType).toContain("text/csv");
      const lines = result.body.split("\n");
      expect(lines[0].startsWith("\uFEFF")).toBe(true);
      for (const header of LIBRARY_HEADER) expect(lines[0]).toContain(header);
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain("нет трафика");
      expect(result.headers?.["X-Library-Dry-Run"]).toBe("1");
      expect(JSON.parse(result.headers?.["X-Library-Summary"] ?? "{}")).toMatchObject({ date: DAY, rows: 1, complete: true });
    }
    expect(test.writeSheet).not.toHaveBeenCalled();
    expect(await test.store.get(finalKey(DAY))).toBeNull();
    expect(await test.store.get(LOCK_KEY)).toBeNull();
  });
  it("writes the final pass once and skips it afterwards unless forced", async () => {
    const test = setup();
    const first = await test.call({ pass: "final" }, auth, writeEnv);
    expect(JSON.parse(first.body)).toMatchObject({ date: DAY, pass: "final", rows: 1, binomRequests: 3,
      sheet: { gid: 7, title: "Library" } });
    expect(await test.store.get(finalKey(DAY))).not.toBeNull();
    for (const pass of ["final", "early"]) {
      expect(JSON.parse((await test.call({ pass }, auth, writeEnv)).body)).toEqual({ skipped: "final-done", date: DAY, pass });
    }
    expect(test.writeSheet).toHaveBeenCalledTimes(1);
    await test.call({ pass: "final", force: "1" }, auth, writeEnv);
    expect(test.writeSheet).toHaveBeenCalledTimes(2);
  });
  it("writes a final pass without CW but leaves it open for the retry and alerts", async () => {
    const test = setup(12);
    const alertEnv = { ...writeEnv, LIBRARY_ALERT_WEBHOOK_URL: "https://hooks.example/alert" };
    const result = await test.call({ pass: "final" }, auth, alertEnv);
    expect(JSON.parse(result.body)).toMatchObject({ date: DAY, pass: "final", complete: false });
    expect(test.writeSheet).toHaveBeenCalledTimes(1);
    expect(await test.store.get(finalKey(DAY))).toBeNull();
    expect(test.alerts).toHaveBeenCalledTimes(1);
    const [, init] = test.alerts.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toContain("без данных CampaignsWell");
    await test.call({ pass: "final" }, auth, alertEnv);
    expect(test.writeSheet).toHaveBeenCalledTimes(2);
  });
  it("answers 409 while another run holds the lock", async () => {
    const test = setup();
    await test.store.setIfAbsent(LOCK_KEY, "other", 900);
    expect((await test.call({ date: DAY })).status).toBe(409);
    expect(test.fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects bad dates and protected tabs without echoing secrets", async () => {
    const test = setup();
    expect((await test.call({ date: "2026-10-06" })).status).toBe(400);
    expect((await test.call({ date: "2026-05-31" })).status).toBe(400);
    const log = vi.fn();
    const result = await handleRun({ headers: auth, query: {} }, { ...writeEnv, LIBRARY_SHEET_GID: "1514034458" },
      { store: () => test.store, sheets: { getSpreadsheet: vi.fn(), batchGetValues: vi.fn(), batchUpdate: vi.fn() }, now: NOW, log });
    expect(result.status).toBe(500);
    const { errorId } = JSON.parse(result.body) as { errorId: string };
    expect(result.body).not.toContain("Protected sheet tab");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ errorId, error: expect.stringContaining("Protected sheet tab") }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    expect(test.writeSheet).not.toHaveBeenCalled();
  });
});
