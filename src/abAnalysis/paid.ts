import type { BinomBreakdown, BinomOfferMetrics } from "../binom/client.js";

/** Validate one or more source arms against the status report's offer totals. */
export function parsePaidStatuses(report: { metrics: BinomOfferMetrics[]; breakdown: BinomBreakdown[] },
  sources: readonly { campaignId: number; offerId: number }[], offerName: string):
  { payers: number; maturedIntros: number; maturedClicks: number; gap?: never } | { gap: string } {
  const selected = (row: { campaignId: number; offerId: number | null }) => sources.some(source =>
    source.campaignId === row.campaignId && source.offerId === row.offerId);
  const rows = report.breakdown.filter(selected);
  if (rows.some(row => !["payer", "subscriber", "Unknown"].includes(row.name))) {
    return { gap: `Binom paid data: unknown conversion status for ${offerName}` };
  }
  const sum = (name: string) => rows.filter(row => row.name === name).reduce((n, row) => n + (row.purchases ?? 0), 0);
  const payers = sum("payer");
  const maturedIntros = payers + sum("subscriber");
  const totals = report.metrics.filter(selected);
  const complete = sources.every(source => {
    const total = totals.find(row => row.campaignId === source.campaignId && row.offerId === source.offerId);
    const statuses = rows.filter(row => row.campaignId === source.campaignId && row.offerId === source.offerId);
    return total && statuses.length > 0 && statuses.reduce((n, row) => n + (row.purchases ?? 0), 0) === total.purchases;
  });
  if (!complete || totals.reduce((n, row) => n + row.purchases, 0) !== maturedIntros || sum("Unknown") !== 0) {
    return { gap: `Binom paid data: incomplete status rows for ${offerName}` };
  }
  return { payers, maturedIntros, maturedClicks: rows.reduce((n, row) => n + row.clicks, 0) };
}
