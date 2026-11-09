import { describe, expect, it, vi } from "vitest";
import { compareProportions, holm } from "../abAnalysis/stats.js";
import { BinomRequestGate } from "../binom/gate.js";
import { ExperimentBinomSource, type LibraryBinomMetrics } from "../binom/client.js";
import { includedCampaigns } from "./collect.js";
import { computeLibrary, qualifyingArms, type LibraryInput } from "./compute.js";
import { pValue } from "./format.js";

const arm = (campaignId: number, offerId: number | null, offerName: string, clicks: number, purchases: number,
  revenue = clicks * 0.1): LibraryBinomMetrics => ({ campaignId, offerId, offerName, uniqueClicks: clicks, purchases, revenue });
function fixture(arms: LibraryBinomMetrics[]): LibraryInput {
  const campaigns = [...new Set(arms.map(row => row.campaignId))].map(id => ({ id, name: `E00${id}`,
    groupName: "IQ", groupUuid: null }));
  const totals = campaigns.map(campaign => ({ campaignId: campaign.id,
    uniqueClicks: arms.filter(row => row.campaignId === campaign.id).reduce((n, row) => n + row.uniqueClicks, 0),
    purchases: arms.filter(row => row.campaignId === campaign.id).reduce((n, row) => n + row.purchases, 0) }));
  const history = Object.fromEntries(arms.map(row => [`${row.campaignId}|${row.offerId === null
    ? `u:${row.offerName}` : `o:${row.offerId}`}`, { firstDay: "2026-10-01", lastDay: "2026-10-05" }]));
  return { day: "2026-10-05", campaigns, lifetime: { campaigns: totals, metrics: arms, days: [] },
    recent: { campaigns: totals.map(row => ({ ...row, purchases: 9 })), metrics: [], days: [] },
    history: { version: 1, arms: history }, aliases: {}, overrides: {}, parentShares: {},
    projects: Object.fromEntries(campaigns.map(row => [row.id, "IQ"])), configuredProjects: ["IQ"],
    cw: arms.filter(row => row.offerId !== null).map(row => ({ campaign: String(row.campaignId), offer: row.offerName,
      subscribers: 50, predictedRevenue: 2000 })), paid: {}, registry: {} };
}
const standard = () => fixture([arm(1, 1, "T001", 1000, 50), arm(1, 2, "T002", 1000, 70)]);

describe("library calculations", () => {
  it("excludes bot-trap sandbox names without a space", () => {
    const rows = [
      { id: 1, name: "TEST_ZD_WW_BNM_BotTrap-Sandbox_26102026 [TEST]", groupName: null, groupUuid: null },
      { id: 2, name: "E006 [TEST]", groupName: null, groupUuid: null }
    ];
    expect(includedCampaigns(rows, {}).map(row => row.id)).toEqual([2]);
  });
  it("adds campaign IDs to every colliding base label", () => {
    const input = standard();
    input.campaigns[0].name = "E006_First";
    input.campaigns.push({ id: 2, name: "E006_Second", groupName: "IQ", groupUuid: null });
    input.lifetime.campaigns.push({ campaignId: 2, uniqueClicks: 0, purchases: 0 });
    const rows = computeLibrary(input);
    expect(rows.map(row => row.cells[1])).toEqual(["E006 (#1)", "E006 (#2)"]);
  });
  it("combines direct URL templates before arm qualification and comparison", async () => {
    const gate = new BinomRequestGate({ minIntervalMs: 0 });
    vi.spyOn(gate, "beforeRequest").mockResolvedValue(undefined);
    vi.spyOn(gate, "complete").mockResolvedValue(undefined);
    const rows = [
      { level: "1", entity_id: "1", name: "E001", unique_clicks: "430", leads: "40", clicks: "430", revenue: "43" },
      { level: "2", entity_id: "", name: "https://example.test/a?one=1", unique_clicks: "80", leads: "8", clicks: "80", revenue: "8" },
      { level: "2", entity_id: "", name: "https://example.test/a?two=2", unique_clicks: "100", leads: "12", clicks: "100", revenue: "10" },
      { level: "2", entity_id: "", name: "https://example.test/b", unique_clicks: "250", leads: "20", clicks: "250", revenue: "25" }
    ];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ report: rows, totals: { total_count: "4" } })));
    const source = new ExperimentBinomSource({ baseUrl: "https://binom.example", apiKey: "key", gate, fetchImpl });
    const report = await source.libraryReport([1], "2026-06-01", "2026-10-05", false);
    const input = fixture(report.metrics);
    input.lifetime = report;
    expect(qualifyingArms(1, report).map(row => row.uniqueClicks)).toEqual([180, 250]);
    expect(computeLibrary(input)[0].cells[13]).toBe("20 / 20");
  });
  it("qualifies only arms meeting both traffic thresholds and reports excluded traffic", () => {
    const input = fixture([arm(1, 1, "T001", 3000, 90), arm(1, 2, "T002", 1000, 60),
      arm(1, 3, "T003", 150, 4), arm(1, 4, "T004", 99, 1)]);
    expect(qualifyingArms(1, input.lifetime).map(row => row.offerId)).toEqual([1, 2]);
    input.history.arms["1|o:3"].firstDay = "2026-09-15";
    const cells = computeLibrary(input)[0].cells;
    expect(cells[26]).toContain("Ещё 2 офферов с малым трафиком (249 кликов) не показаны");
    expect(cells[4]).toBe("15.09");
    delete input.history.arms["1|o:3"];
    expect(computeLibrary(input)[0].cells[4]).toBe("—");
    expect(computeLibrary(input)[0].cells[3]).toBe("—");
  });
  it("uses override, parent share and T-number in that order", () => {
    const input = fixture([arm(1, 8, "T005", 1000, 50), arm(1, 9, "offer T002", 1000, 60), arm(1, 10, "T003", 1000, 70)]);
    input.overrides = { 1: 10 };
    input.parentShares = { 1: { 8: 0.8, 10: 0.2 } };
    expect(computeLibrary(input)[0].controlKey).toBe("o:10");
    input.overrides = {};
    expect(computeLibrary(input)[0].controlKey).toBe("o:8");
    input.parentShares = {};
    expect(computeLibrary(input)[0].controlKey).toBe("o:9");
  });
  it("chooses direct URLs by occurrence in other campaigns, then first day", () => {
    const input = fixture([arm(1, null, "https://a.test/a", 1000, 50), arm(1, null, "https://a.test/b", 1000, 60),
      arm(2, null, "https://other.test/b", 1000, 50)]);
    input.history.arms["1|u:https://a.test/a"].firstDay = "2026-09-01";
    expect(computeLibrary(input).find(row => row.campaignId === 1)?.controlKey).toBe("u:https://a.test/b");
    input.lifetime.metrics = input.lifetime.metrics.filter(row => row.campaignId === 1);
    expect(computeLibrary(input).find(row => row.campaignId === 1)?.controlKey).toBe("u:https://a.test/a");
  });
  it("uses 90% tests, Holm-adjusted p-values and marks different starts", () => {
    const input = fixture([arm(1, 1, "T001", 1000, 50), arm(1, 2, "T002", 1000, 70), arm(1, 3, "T003", 1000, 85)]);
    input.history.arms["1|o:2"].firstDay = "2026-10-03";
    const rows = computeLibrary(input);
    const raw = [70, 85].map(x => compareProportions({ x: 50, n: 1000 }, { x, n: 1000 },
      { alpha: 0.10, minConversions: 30 }).pValue!);
    const expected = holm(raw);
    expect(rows.find(row => row.variantKey === "o:2")?.cells[11]).toBe(pValue(expected[0]));
    expect(rows.find(row => row.variantKey === "o:3")?.cells[11]).toBe(pValue(expected[1]));
    expect(rows.find(row => row.variantKey === "o:2")?.cells[12]).toBe("лучше (разный старт)");
    expect(rows[0].cells[26]).toContain("p с поправкой Холма на 2 вариантов");
    expect(rows[0].cells[1]).toBe("E001");
    expect(rows[0].cells.slice(6, 8)).toEqual(["T001", "T003"]);
    expect(rows.every(row => row.cells.length === 27)).toBe(true);
    input.lifetime.metrics[0].purchases = 29;
    expect(computeLibrary(input)[0].cells[12]).toContain("мало данных");
  });
  it("uses the five-percent revenue and forecast thresholds and subscriber minimum", () => {
    const input = standard();
    input.campaigns[0].name = "E001 [GLOBAL]";
    input.registry.E001 = { row: 8, name: "Registry experiment" };
    input.paid = { "1|o:1": { payers: 20, maturedIntros: 50 }, "1|o:2": { payers: 30, maturedIntros: 50 } };
    input.lifetime.metrics[1].revenue = 106;
    input.cw![1].predictedRevenue = 2200;
    let cells = computeLibrary(input)[0].cells;
    expect(cells.slice(0, 5)).toEqual([{ value: 8, format: "int" }, "E001 [GLOBAL]", "Registry experiment", "идёт", "01.10"]);
    expect(cells[8]).toEqual({ value: 0.05, format: "percent2" });
    expect(cells[9]).toEqual({ value: 0.07, format: "percent2" });
    expect(cells[14]).toEqual({ value: 0.1, format: "usd2" });
    expect(cells[15]).toEqual({ value: 0.106, format: "usd2" });
    expect(cells[16]).toBe("лучше");
    expect(cells[18]).toEqual({ value: 40, format: "usd1" });
    expect(cells[19]).toEqual({ value: 44, format: "usd1" });
    expect(cells[20]).toEqual({ value: 44 / 40 - 1, format: "signedPercent1" });
    expect(cells[21]).toBe("лучше");
    expect(cells[22]).toEqual({ value: 0.4, format: "percent1" });
    expect(cells[23]).toEqual({ value: 0.6, format: "percent1" });
    input.lifetime.metrics[1].revenue = Infinity;
    expect(computeLibrary(input)[0].cells[15]).toBe("—");
    input.lifetime.metrics[1].revenue = 95;
    input.cw![1].subscribers = 29;
    cells = computeLibrary(input)[0].cells;
    expect(cells[16]).toBe("нет разницы");
    expect(cells[21]).toBe("мало данных");
    expect(cells[26]).toContain("мало подписок");
  });
  it("explains missing subscriber data in matching CW rows", () => {
    const input = standard();
    input.cw!.push({ ...input.cw![0], subscribers: null, predictedRevenue: null });
    const cells = computeLibrary(input)[0].cells;
    expect(cells[17]).toBe("— / 50");
    expect(cells[18]).toBe("—");
    expect(cells[26]).toContain("CW: у T001 нет данных о подписках");
    expect(cells[26]).not.toContain("CW: у T001 нет прогноза выручки (pLTV)");
  });
  it("explains missing CW revenue forecasts without hiding coverage gaps", () => {
    const input = standard();
    input.cw![1].predictedRevenue = null;
    const cells = computeLibrary(input)[0].cells;
    expect(cells[19]).toBe("—");
    expect(cells[26]).toContain("CW: у T002 нет прогноза выручки (pLTV)");
    expect(cells[26]).toContain("CW: у T002 50 подписок при 70 покупках в Binom — разметка неполная");
    input.cw = null;
    input.paid = { "1|o:1": { gap: "CW недоступен" } };
    expect(String(computeLibrary(input)[0].cells[26]).split("CW недоступен")).toHaveLength(2);
  });
  it("shows one-arm, zero-traffic and stopped campaigns honestly", () => {
    const input = fixture([arm(1, 1, "T001", 1000, 50)]);
    input.campaigns.push({ id: 2, name: "E002", groupName: "IQ", groupUuid: null });
    input.history.arms["1|o:1"].lastDay = "2026-10-01";
    const rows = computeLibrary(input);
    expect(rows[0].cells[3]).toBe("стоп с 02.10");
    expect(rows[0].cells[12]).toBe("не сравнить");
    expect(rows[0].cells[26]).toContain("Одиночный запуск: контроля в кампании нет");
    expect(rows[0].cells[26]).not.toContain("Трафика нет с");
    expect(rows[1].cells[3]).toBe("нет трафика");
    expect(rows[1].cells[4]).toBe("—");
    expect(rows[1].cells[12]).toBe("нет данных");
    expect(rows[1].cells[26]).not.toContain("Трафика в Binom нет");
    input.history.arms["1|o:1"].lastDay = "2026-10-03";
    expect(computeLibrary(input)[0].cells[3]).toBe("идёт");
  });
  it("sorts campaigns by all purchases, variants by purchases and shows recent conversions once", () => {
    const input = fixture([arm(1, 1, "T001", 1000, 50), arm(1, 2, "T002", 1000, 70),
      arm(1, 3, "T003", 1000, 80), arm(2, 4, "T004", 1000, 10)]);
    const rows = computeLibrary(input);
    expect(rows.map(row => row.campaignId)).toEqual([1, 1, 2]);
    expect(rows.map(row => row.variantKey)).toEqual(["o:3", "o:2", "o:4"]);
    expect(rows.map(row => row.cells[5])).toEqual([{ value: 9, format: "count" }, "", { value: 9, format: "count" }]);
  });
});
