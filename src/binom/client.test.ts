import { afterEach, describe, expect, it, vi } from "vitest";
import { BinomRequestGate } from "./gate.js";
import { ExperimentBinomSource } from "./client.js";

const reply = (body: unknown) => new Response(JSON.stringify(body));
const row = (level: string, name: string, id: number | undefined, clicks = 10000, leads = 0) => ({
  level, name, ...(id ? { entity_id: String(id) } : {}), clicks: String(clicks + 10),
  unique_clicks: String(clicks), leads: String(leads)
});
// Reconstructed from production sources (2026-10-26): status rows of two offers under one campaign.
const statusReport = () => {
  const report = [row("1", "E052", 41), ...[[19, "T017", 900, 817], [24, "T027", 1059, 810]].flatMap(
    ([offer, name, subscribers, payers]) => [row("2", String(name), Number(offer), 10000, Number(subscribers) + Number(payers)),
      row("3", "Unknown", undefined, 8000), row("3", "subscriber", undefined, 1200, Number(subscribers)),
      row("3", "payer", undefined, 800, Number(payers))])];
  return { report, totals: { total_count: String(report.length), unique_clicks: "20000", clicks: "20200" } };
};
function source(read: (url: URL) => unknown) {
  const gate = new BinomRequestGate({ minIntervalMs: 0 });
  const beforeRequest = vi.spyOn(gate, "beforeRequest").mockResolvedValue();
  const complete = vi.spyOn(gate, "complete").mockResolvedValue();
  const fetchImpl = vi.fn(async (input: string | URL | Request) => reply(read(new URL(String(input)))));
  const binom = new ExperimentBinomSource({ baseUrl: "https://binom.example", apiKey: "secret", gate,
    fetchImpl: fetchImpl as typeof fetch });
  return { binom, fetchImpl, beforeRequest, complete };
}

afterEach(() => vi.restoreAllMocks());

describe("ExperimentBinomSource", () => {
  it("retains and sums repeated direct URLs with revenue in the library report", async () => {
    const rows = [
      { level: "1", entity_id: "40", name: "E001", unique_clicks: "100", leads: "8", clicks: "110", revenue: "10" },
      { level: "2", entity_id: "", name: "https://example.test/path?a=1", unique_clicks: "40", leads: "3", clicks: "45", revenue: "4.50" },
      { level: "2", entity_id: "", name: "https://example.test/path?b=2", unique_clicks: "60", leads: "5", clicks: "65", revenue: "5.50" }
    ];
    const { binom, fetchImpl } = source(() => ({ report: rows, totals: { total_count: "3" } }));
    const result = await binom.libraryReport([40], "2026-06-01", "2026-10-05", false);
    expect(result.metrics).toEqual([{ campaignId: 40, offerId: null, offerName: "https://example.test/path",
      uniqueClicks: 100, purchases: 8, clicks: 110, revenue: 10 }]);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect([...url.searchParams.entries()]).toEqual([
      ["datePreset", "custom_time"], ["dateFrom", "2026-06-01 00:00:00"], ["dateTo", "2026-10-05 23:59:59"],
      ["timezone", "UTC"], ["sortColumn", "clicks"], ["sortType", "desc"], ["limit", "300"], ["offset", "0"],
      ["ids[]", "40"], ["groupings[]", "campaign"], ["groupings[]", "offer"]
    ]);
  });
  it("uses only the exact verified request shape and preserves status-row unique clicks including Unknown", async () => {
    const { binom, fetchImpl } = source(() => statusReport());
    const report = await binom.paidReport(41, "2026-10-01", "2026-10-18");
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe("/public/api/v1/report/campaign");
    expect([...url.searchParams]).toEqual([
      ["datePreset", "custom_time"], ["dateFrom", "2026-10-01 00:00:00"], ["dateTo", "2026-10-18 23:59:59"],
      ["timezone", "UTC"], ["sortColumn", "clicks"], ["sortType", "desc"], ["limit", "300"], ["offset", "0"],
      ["ids[]", "41"], ["groupings[]", "campaign"], ["groupings[]", "offer"], ["groupings[]", "conversionStatusOne"]
    ]);
    expect(report.breakdown.filter(row => row.offerId === 19).map(row => [row.name, row.clicks, row.purchases]))
      .toEqual([["Unknown", 8000, 0], ["subscriber", 1200, 900], ["payer", 800, 817]]);
  });
  it("rejects duplicate status rows and incomplete pages through the existing report guards", async () => {
    const data = statusReport(); data.report.push({ ...data.report[4] });
    data.totals.total_count = String(data.report.length);
    await expect(source(() => data).binom.paidReport(41, "2026-10-01", "2026-10-18"))
      .rejects.toThrow("duplicate breakdown");
    data.report.pop(); data.totals.total_count = "300";
    await expect(source(() => data).binom.paidReport(41, "2026-10-01", "2026-10-18"))
      .rejects.toThrow("truncated page");
  });
  it("stops on a slow successful response but records gate success", async () => {
    const test = source(() => []);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10_001);
    await expect(test.binom.campaignList()).rejects.toThrow("Binom: slow response; collection paused to reduce load");
    expect(test.complete).toHaveBeenCalledExactlyOnceWith(true);
    expect(test.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("counts every request against the run budget and refuses requests beyond it", async () => {
    const test = source(() => []);
    const run = test.binom.withAnalysisBudget(async () => { await test.binom.campaignList(); await test.binom.campaignList(); }, 1);
    await expect(run).rejects.toThrow("request budget exceeded (1)");
    expect(test.fetchImpl).toHaveBeenCalledTimes(1);
    expect(test.beforeRequest).toHaveBeenCalledTimes(1);
  });
});
