import { z } from "zod";
import { BINOM_REQUEST_TIMEOUT_MS, type BinomRequestGate } from "./gate.js";
type ReportWindow = { key: "day" | "d3" | "d7"; from: string; to: string; label: string };

export interface ExperimentBinomSourceOptions {
  baseUrl: string;
  apiKey: string;
  gate: BinomRequestGate;
  analysisRequestBudget?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onRequest?: (details: { path: string; durationMs: number; ok: boolean }) => void;
}

export interface BinomOffer { id: number | null; name: string }
export interface BinomOfferMetrics {
  campaignId: number;
  offerId: number | null;
  offerName: string;
  uniqueClicks: number;
  purchases: number;
  cost?: number;
  /** Included by the analysis report for traffic-based arm detection. */
  clicks?: number;
}
export interface LibraryBinomMetrics extends BinomOfferMetrics { revenue: number }
export interface LibraryBinomReport {
  campaigns: Array<{ campaignId: number; uniqueClicks: number; purchases: number }>;
  metrics: LibraryBinomMetrics[];
  days: Array<LibraryBinomMetrics & { day: string }>;
}
export interface BinomBreakdown {
  campaignId: number;
  offerId: number | null;
  offerName: string;
  name: string;
  clicks: number;
  purchases?: number;
  rawClicks?: number;
  cost?: number;
}
const PAGE_SIZE = 300;

const rawPathSchema = z.object({
  enabled: z.boolean(), weight: z.number().nonnegative(), offers: z.array(z.object({
    offerId: z.number().int().nonnegative(), campaignId: z.number().int().nonnegative(),
    weight: z.number().nonnegative(), enabled: z.boolean(), name: z.string().nullish(), url: z.string().nullish()
  }))
});
export const rawCampaignSchema = z.object({
  id: z.number().int().positive(), name: z.string().min(1), link: z.string(), createdAt: z.string().nullish(),
  groupUuid: z.string().nullish(), groupName: z.string().nullish(),
  customRotation: z.object({ defaultPaths: z.array(rawPathSchema), rules: z.array(z.object({
    name: z.string().nullish(), enabled: z.boolean(), criteria: z.unknown(), paths: z.array(rawPathSchema)
  })).default([]) })
});
export interface BinomListRow { id: number; name: string; groupUuid: string | null; groupName: string | null }
/** Binom bots-trap campaigns: excluded from reports and never announcement parents. */
export const BOTS_TRAP = /bots\s+trap/i;
export type RawBinomCampaign = z.infer<typeof rawCampaignSchema>;

export class InvalidBinomCampaignError extends Error {
  constructor(readonly campaignId: number) {
    super(`Binom: invalid raw campaign=${campaignId}`);
    this.name = "InvalidBinomCampaignError";
  }
}

export class AbRequestBudgetError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Binom: invalid object");
  return value as Record<string, unknown>;
}

function integer(value: unknown): number {
  if (!(typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)))) {
    throw new Error("Binom: invalid integer");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Binom: invalid integer");
  return number;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Binom: invalid string");
  return value;
}

export function binomOfferKey(offerId: number | null, offerName: string): string {
  return offerId === null ? `u:${offerName}` : `o:${offerId}`;
}

function directUrlName(url: string): string {
  return text(url.split(/[?#]/, 1)[0]);
}

// Only click totals are stable for closed days: late postbacks keep changing leads/revenue/profit
// of past clicks between page reads (seen in production), so those must not reject the snapshot.
const STABLE_TOTALS = ["total_count", "clicks", "unique_clicks"] as const;
function totalsSignature(totals: Record<string, unknown>): string {
  return JSON.stringify(STABLE_TOTALS.map(key => totals[key] === undefined ? null : integer(totals[key])));
}

/** Complete, serial collection. Any malformed or changing report rejects the snapshot. */
export class ExperimentBinomSource {
  private requestBudget: { requests: number; limit: number } | undefined;
  private readonly origin: string;
  readonly analysisRequestBudget: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ExperimentBinomSourceOptions) {
    let url: URL;
    try { url = new URL(options.baseUrl); }
    catch { throw new Error("Binom: HTTPS origin required"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Binom: HTTPS origin required");
    if (!options.apiKey) throw new Error("Binom: API key required");
    this.origin = url.origin;
    this.analysisRequestBudget = options.analysisRequestBudget ?? 80;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async get(path: string, params = new URLSearchParams()): Promise<unknown> {
    if (this.requestBudget) {
      if (this.requestBudget.requests >= this.requestBudget.limit) {
        throw new AbRequestBudgetError(`Binom: A/B request budget exceeded (${this.requestBudget.limit})`);
      }
      this.requestBudget.requests++;
    }
    const url = new URL(`/public/api/v1/${path}`, this.origin);
    url.search = params.toString();
    if (this.options.signal?.aborted) throw new Error("Binom: collection cancelled");
    await this.options.gate.beforeRequest("read", this.options.signal);
    const started = Date.now();
    let ok = false;
    try {
      if (this.options.signal?.aborted) throw new Error("Binom: collection cancelled");
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(BINOM_REQUEST_TIMEOUT_MS);
        response = await this.fetchImpl(url, {
          headers: { "Api-Key": this.options.apiKey, Accept: "application/json", "User-Agent": "ExperimentReport/1.0" },
          redirect: "error",
          signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout
        });
      } catch { throw new Error("Binom: request failed; automatic retries disabled"); }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Binom: HTTP ${response.status}`);
      }
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new Error("Binom: response read failed"); }
      // The read itself succeeded, so the shared gate records success; the caller still stops on a slow response.
      ok = true;
      if (Date.now() - started >= 10_000) throw new Error("Binom: slow response; collection paused to reduce load");
      return data;
    } finally {
      await this.options.gate.complete(ok);
      this.options.onRequest?.({ path, durationMs: Date.now() - started, ok });
    }
  }

  /** Every list row, bots-trap rows included; `beforeRead` runs before each page request. */
  async campaignList(beforeRead?: () => void): Promise<BinomListRow[]> {
    const campaigns: BinomListRow[] = [];
    const seen = new Set<number>();
    for (let offset = 0; offset < 100_000; offset += PAGE_SIZE) {
      const params = new URLSearchParams({ sortType: "asc", limit: String(PAGE_SIZE), offset: String(offset) });
      beforeRead?.();
      const page = await this.get("campaign/list/filtered", params);
      if (!Array.isArray(page) || page.length > PAGE_SIZE) throw new Error("Binom: invalid campaign page");
      for (const value of page) {
        const row = record(value);
        const id = integer(row.id);
        const name = text(row.name);
        if (id === 0 || seen.has(id)) throw new Error("Binom: repeated or invalid campaign id");
        seen.add(id);
        campaigns.push({ id, name, groupUuid: typeof row.groupUuid === "string" ? row.groupUuid : null,
          groupName: typeof row.groupName === "string" ? row.groupName : null });
      }
      if (page.length < PAGE_SIZE) return campaigns;
    }
    throw new Error("Binom: campaign pagination limit exceeded");
  }

  async rawCampaign(id: number): Promise<RawBinomCampaign> {
    const parsed = rawCampaignSchema.safeParse(await this.get(`campaign/${id}`));
    if (!parsed.success || parsed.data.id !== id) throw new InvalidBinomCampaignError(id);
    return parsed.data;
  }

  /** Scope includes discovery pages and all report pages; enforced before touching the shared gate. */
  async withAnalysisBudget<T>(run: () => Promise<T>, limit = this.analysisRequestBudget): Promise<{ data: T; requests: number }> {
    if (this.requestBudget) throw new Error("Binom: analysis already running");
    const budget = { requests: 0, limit };
    this.requestBudget = budget;
    try { return { data: await run(), requests: budget.requests }; }
    catch (error) {
      if (error instanceof Error) Object.assign(error, { abRequests: budget.requests });
      throw error;
    }
    finally { this.requestBudget = undefined; }
  }

  async paidReport(campaignId: number | readonly number[], from: string, to: string) {
    const ids = typeof campaignId === "number" ? [campaignId] : campaignId;
    return this.report(ids, { key: "d7", from, to, label: "A/B paid" }, "conversionStatusOne", true);
  }

  /** Lifetime library rows preserve and combine direct-URL templates sharing the same stripped URL. */
  async libraryReport(ids: readonly number[], from: string, to: string, withDays: boolean): Promise<LibraryBinomReport> {
    const result: LibraryBinomReport = { campaigns: [], metrics: [], days: [] };
    if (!ids.length) return result;
    const allowed = new Set(ids);
    const campaignIds = new Set<number>();
    const offers = new Map<string, LibraryBinomMetrics>();
    const days = new Map<string, LibraryBinomMetrics & { day: string }>();
    const pages = new Set<string>();
    let campaignId: number | undefined;
    let offer: { id: number | null; name: string } | undefined;
    let signature: string | undefined;
    let countRows = 0;
    for (let offset = 0; offset < 100_000; offset += PAGE_SIZE) {
      const params = new URLSearchParams({ datePreset: "custom_time", dateFrom: `${from} 00:00:00`,
        dateTo: `${to} 23:59:59`, timezone: "UTC", sortColumn: "clicks", sortType: "desc",
        limit: String(PAGE_SIZE), offset: String(offset) });
      for (const id of ids) params.append("ids[]", String(id));
      for (const grouping of ["campaign", "offer", ...(withDays ? ["days"] : [])]) params.append("groupings[]", grouping);
      const page = record(await this.get("report/campaign", params));
      const totals = record(page.totals);
      const count = integer(totals.total_count);
      const current = totalsSignature(totals);
      if (signature !== undefined && signature !== current) throw new Error("Binom: report totals changed during pagination");
      signature = current;
      if (!Array.isArray(page.report) || page.report.length > PAGE_SIZE) throw new Error("Binom: invalid report page");
      const fingerprint = JSON.stringify(page.report);
      if (page.report.length && pages.has(fingerprint)) throw new Error("Binom: repeated report page");
      pages.add(fingerprint);
      for (const value of page.report) {
        const row = record(value);
        const name = text(row.name);
        const uniqueClicks = integer(row.unique_clicks);
        const purchases = integer(row.leads);
        const clicks = integer(row.clicks);
        if ((typeof row.revenue !== "string" && typeof row.revenue !== "number")
          || typeof row.revenue === "string" && !row.revenue.trim() || !Number.isFinite(Number(row.revenue))) {
          throw new Error("Binom: invalid revenue");
        }
        const revenue = Number(row.revenue);
        if (row.level === "1") {
          campaignId = integer(row.entity_id);
          if (!allowed.has(campaignId) || campaignIds.has(campaignId)) throw new Error("Binom: unknown or duplicate campaign row");
          campaignIds.add(campaignId);
          result.campaigns.push({ campaignId, uniqueClicks, purchases });
          offer = undefined;
        } else if (row.level === "2") {
          if (campaignId === undefined) throw new Error("Binom: offer row without campaign");
          const id = row.entity_id === undefined || row.entity_id === null || row.entity_id === "" ? null : integer(row.entity_id);
          if (id === 0) throw new Error("Binom: invalid offer id");
          offer = { id, name: id === null ? directUrlName(name) : name };
          const key = JSON.stringify([campaignId, binomOfferKey(id, offer.name)]);
          const existing = offers.get(key);
          if (existing && id !== null) throw new Error("Binom: duplicate offer under campaign");
          if (existing) { existing.uniqueClicks += uniqueClicks; existing.purchases += purchases; existing.revenue += revenue;
            existing.clicks = (existing.clicks ?? 0) + clicks; }
          else offers.set(key, { campaignId, offerId: id, offerName: offer.name, uniqueClicks, purchases, revenue, clicks });
        } else if (row.level === "3" && withDays) {
          if (campaignId === undefined || !offer) throw new Error("Binom: day row without campaign/offer");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || name < from || name > to) throw new Error("Binom: day outside report window");
          const key = JSON.stringify([campaignId, binomOfferKey(offer.id, offer.name), name]);
          const existing = days.get(key);
          if (existing && offer.id !== null) throw new Error("Binom: duplicate breakdown row");
          if (existing) { existing.uniqueClicks += uniqueClicks; existing.purchases += purchases; existing.revenue += revenue;
            existing.clicks = (existing.clicks ?? 0) + clicks; }
          else days.set(key, { campaignId, offerId: offer.id, offerName: offer.name,
            uniqueClicks, purchases, revenue, clicks, day: name });
        } else throw new Error("Binom: unknown report level");
        countRows++;
      }
      if (countRows > count) throw new Error("Binom: report row count mismatch");
      if (countRows === count) return { ...result, metrics: [...offers.values()], days: [...days.values()] };
      if (page.report.length < PAGE_SIZE) throw new Error("Binom: report row count mismatch; truncated page");
    }
    throw new Error("Binom: report pagination limit exceeded");
  }

  private async report(
    ids: readonly number[], window: ReportWindow,
    dimension?: "days" | "geoCountry" | "osName" | "conversionStatusOne", includePurchases = false
  ): Promise<{ metrics: BinomOfferMetrics[]; breakdown: BinomBreakdown[]; skippedDirectUrlRows: number }> {
    const metrics: BinomOfferMetrics[] = [];
    const breakdown: BinomBreakdown[] = [];
    const allowedIds = new Set(ids);
    const campaigns = new Set<number>();
    const offers = new Set<string>();
    const breakdownKeys = new Set<string>();
    const pages = new Set<string>();
    let campaignId: number | undefined;
    let offer: BinomOffer | null | undefined;
    let signature: string | undefined;
    let rowCount = 0;
    let skippedDirectUrlRows = 0;
    for (let offset = 0; offset < 100_000; offset += PAGE_SIZE) {
      const params = new URLSearchParams({
        datePreset: "custom_time", dateFrom: `${window.from} 00:00:00`, dateTo: `${window.to} 23:59:59`,
        timezone: "UTC", sortColumn: "clicks", sortType: "desc", limit: String(PAGE_SIZE), offset: String(offset)
      });
      for (const id of ids) params.append("ids[]", String(id));
      for (const grouping of ["campaign", "offer", ...(dimension ? [dimension] : [])]) params.append("groupings[]", grouping);
      const page = record(await this.get("report/campaign", params));
      const totals = record(page.totals);
      const count = integer(totals.total_count);
      const currentSignature = totalsSignature(totals);
      if (signature !== undefined && signature !== currentSignature) throw new Error("Binom: report totals changed during pagination");
      signature = currentSignature;
      if (!Array.isArray(page.report) || page.report.length > PAGE_SIZE) throw new Error("Binom: invalid report page");
      const fingerprint = JSON.stringify(page.report);
      if (page.report.length && pages.has(fingerprint)) throw new Error("Binom: repeated report page");
      pages.add(fingerprint);
      for (const value of page.report) {
        const row = record(value);
        const name = text(row.name);
        const uniqueClicks = integer(row.unique_clicks);
        const purchases = integer(row.leads);
        const clicks = integer(row.clicks);
        const cost = !includePurchases || row.cost == null || row.cost === "" ? undefined : Number(row.cost);
        if (cost !== undefined && (typeof row.cost !== "number" && typeof row.cost !== "string"
          || typeof row.cost === "string" && !row.cost.trim() || !Number.isFinite(cost) || cost < 0)) {
          throw new Error("Binom: invalid cost");
        }
        const economics = includePurchases && cost !== undefined ? { cost } : {};
        if (row.level === "1") {
          campaignId = integer(row.entity_id);
          if (!allowedIds.has(campaignId) || campaigns.has(campaignId)) throw new Error("Binom: unknown or duplicate campaign row");
          campaigns.add(campaignId);
          offer = undefined;
        } else if (row.level === "2") {
          if (campaignId === undefined) throw new Error("Binom: offer row without campaign");
          const offerId = row.entity_id === undefined || row.entity_id === null || row.entity_id === ""
            ? null : integer(row.entity_id);
          if (includePurchases && offerId === null) {
            offer = null;
            skippedDirectUrlRows++;
            rowCount++;
            continue;
          }
          const offerName = offerId === null ? directUrlName(name) : name;
          const key = JSON.stringify([campaignId, binomOfferKey(offerId, offerName)]);
          if (offerId === null && offers.has(key)) throw new Error("Binom: ambiguous direct-URL offer");
          if (offerId === 0 || offers.has(key)) throw new Error("Binom: duplicate or invalid offer under campaign");
          offers.add(key);
          offer = { id: offerId, name: offerName };
          metrics.push({ campaignId, offerId, offerName, uniqueClicks, purchases,
            ...(includePurchases ? { clicks } : {}), ...economics });
        } else if (row.level === "3" && dimension) {
          if (campaignId === undefined) throw new Error("Binom: breakdown row without campaign/offer");
          if (offer === null && includePurchases) {
            skippedDirectUrlRows++;
            rowCount++;
            continue;
          }
          if (!offer) throw new Error("Binom: breakdown row without campaign/offer");
          const key = JSON.stringify([campaignId, offer.id, offer.name, name]);
          if ((dimension === "days" || dimension === "conversionStatusOne") && breakdownKeys.has(key)) {
            throw new Error("Binom: duplicate breakdown row");
          }
          breakdownKeys.add(key);
          if (dimension === "days" && (!/^\d{4}-\d{2}-\d{2}$/.test(name) || name < window.from || name > window.to)) {
            throw new Error("Binom: day outside report window");
          }
          breakdown.push({ campaignId, offerId: offer.id, offerName: offer.name, name, clicks: uniqueClicks,
            ...(includePurchases ? { purchases, rawClicks: clicks } : {}), ...economics });
        } else {
          throw new Error("Binom: unknown report level");
        }
        rowCount++;
      }
      if (rowCount > count) throw new Error("Binom: report row count mismatch");
      if (rowCount === count) {
        if (!includePurchases || dimension === "days" || dimension === "conversionStatusOne") {
          return { metrics, breakdown, skippedDirectUrlRows };
        }
        // Production can expose several distinct source buckets named Unknown. The contract groups by display value.
        const grouped = new Map<string, BinomBreakdown>();
        for (const row of breakdown) {
          const key = JSON.stringify([row.campaignId, row.offerId, row.offerName, row.name]);
          const existing = grouped.get(key);
          if (existing) {
            existing.clicks += row.clicks;
            existing.purchases = (existing.purchases ?? 0) + (row.purchases ?? 0);
            existing.rawClicks = (existing.rawClicks ?? 0) + (row.rawClicks ?? 0);
          } else grouped.set(key, { ...row });
        }
        return { metrics, breakdown: [...grouped.values()], skippedDirectUrlRows };
      }
      if (page.report.length < PAGE_SIZE) throw new Error("Binom: report row count mismatch; truncated page");
    }
    throw new Error("Binom: report pagination limit exceeded");
  }
}
