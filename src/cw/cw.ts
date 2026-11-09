import { CampaignswellMcpClient, toCampaignswellReadError, type CwCredentialOptions } from "./client.js";

export interface LibraryCwRow { campaign: string; offer: string; subscribers: number | null; predictedRevenue: number | null }

// Canonical measured CampaignsWell application names per Binom project.
export const APPLICATIONS: Readonly<Record<string, string>> = {
  IQ: "Iqnio (KlymboIQ)", Subcaddy: "Subcaddy (Reclaim)", Zodeya: "Zodeya", Planbix: "Planbix", Monetao: "Monetao"
};
type CwClient = Pick<CampaignswellMcpClient, "getDefaultOrganizationId" | "callToolJson" | "close">;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CW: invalid response object");
  return value as Record<string, unknown>;
}
function number(value: unknown): number | null {
  if (value === null) return null;
  if ((typeof value !== "number" && (typeof value !== "string" || !value.trim())) || !Number.isFinite(Number(value))) {
    throw new Error("CW: invalid metric");
  }
  return Number(value);
}
function checkedPage(value: unknown): { rows: unknown[]; hasNextPage: boolean } {
  const page = object(value);
  if (!Array.isArray(page.rows) || typeof page.hasNextPage !== "boolean" || page.rows.length > 200
    || (page.hasNextPage && page.rows.length !== 200)) throw new Error("CW: incomplete page contract");
  return { rows: page.rows, hasNextPage: page.hasNextPage };
}
function reconcileTotals<T extends string>(before: Record<string, unknown>, after: Record<string, unknown>,
  rows: Array<{ metrics: Record<T, number | null> }>, metrics: readonly T[]) {
  const diffs: Record<string, { rowsRelative: number | null; beforeAfterRelative: number | null }> = {};
  let failedMetric: T | undefined;
  for (const metric of metrics) {
    const initial = number(before[metric]) ?? 0;
    const final = number(after[metric]) ?? 0;
    const sum = rows.reduce((total, row) => total + (row.metrics[metric] ?? 0), 0);
    const rowsDifference = Math.abs(sum - final);
    const beforeAfterDifference = Math.abs(initial - final);
    const tolerance = Math.max(1, 0.005 * Math.abs(final));
    diffs[metric] = { rowsRelative: final ? rowsDifference / Math.abs(final) : null,
      beforeAfterRelative: final ? beforeAfterDifference / Math.abs(final) : null };
    if (beforeAfterDifference > tolerance || rowsDifference > tolerance) failedMetric ??= metric;
  }
  return { diffs, failedMetric };
}

/** Lifetime library query: strict paging and before/after reconciliation of additive totals. */
export async function collectLibraryCw(client: CwClient, projects: readonly string[], from: string, day: string,
  log: (entry: Record<string, unknown>) => void = entry => console.log(JSON.stringify(entry))): Promise<LibraryCwRow[]> {
  const organizationId = await client.getDefaultOrganizationId();
  const result: LibraryCwRow[] = [];
  const metrics = ["subscribers_all", "revenue_net_base_currency", "p_revenue_net_base_currency_90"] as const;
  for (const project of new Set(projects)) {
    const application = APPLICATIONS[project];
    if (!application) continue;
    const common = { organizationId, dateRange: { start: from, end: day }, probabilisticAttribution: true,
      dimensionsFilters: [{ id: "application_name", value: { type: "include", options: [application] } }],
      user_prompt: "DEV-347 test library (read only)" };
    const total = async () => object(object(await client.callToolJson("get_cmp_total", { ...common, metrics: [...metrics] })).total);
    const before = await total();
    const rows: Array<{ campaign: string; offer: string; metrics: Record<typeof metrics[number], number | null> }> = [];
    const seen = new Set<string>();
    for (let offset = 0; ; offset += 200) {
      if (offset >= 2_000_000) throw new Error("CW: pagination ceiling; incomplete snapshot");
      const dimensions = ["application_name", "cw_param3", "cw_param2"];
      const page = checkedPage(await client.callToolJson("query_cmp_rows", { ...common, dimensions, metrics: [...metrics],
        metricsFilters: [], dateScale: "day", sort: dimensions.map(name => ({ name, value: "ASC" })), pageSize: 200, offset }));
      for (const raw of page.rows) {
        const row = object(raw);
        if (row.application_name !== application || typeof row.cw_param3 !== "string" || typeof row.cw_param2 !== "string") {
          throw new Error("CW: invalid arm dimensions");
        }
        const key = JSON.stringify([row.cw_param3, row.cw_param2]);
        if (seen.has(key)) throw new Error("CW: repeated grouped row");
        seen.add(key);
        rows.push({ campaign: row.cw_param3, offer: row.cw_param2,
          metrics: Object.fromEntries(metrics.map(metric => [metric, number(row[metric])])) as typeof rows[number]["metrics"] });
      }
      if (!page.hasNextPage) break;
    }
    const after = await total();
    const { diffs, failedMetric } = reconcileTotals(before, after, rows, metrics);
    log({ level: "info", msg: "Library CW totals check", app: application, diffs });
    if (failedMetric) throw new Error(`CW: changed or incomplete totals for ${failedMetric}`);
    result.push(...rows.map(row => ({ campaign: row.campaign, offer: row.offer,
      subscribers: row.metrics.subscribers_all, predictedRevenue: row.metrics.p_revenue_net_base_currency_90 })));
  }
  return result;
}

export async function fetchLibraryCw(credentials: CwCredentialOptions, projects: readonly string[], from: string, day: string,
  log?: (entry: Record<string, unknown>) => void): Promise<LibraryCwRow[]> {
  let client: CampaignswellMcpClient | undefined;
  try {
    client = await CampaignswellMcpClient.connect(credentials);
    return await collectLibraryCw(client, projects, from, day, log);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("CW:") || error.message.startsWith("CW "))) throw error;
    throw toCampaignswellReadError(error);
  } finally { await client?.close(); }
}
