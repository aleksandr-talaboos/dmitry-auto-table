import { z } from "zod";
import { daySchema } from "../abAnalysis/contract.js";
import { binomOfferKey, type LibraryBinomMetrics } from "../binom/client.js";
import type { Store } from "../store/index.js";

export const ARMS_KEY = "library:arms";

const armsSchema = z.object({ version: z.literal(1), arms: z.record(z.string(), z.object({
  firstDay: daySchema, lastDay: daySchema
}).strict().refine(value => value.firstDay <= value.lastDay)) }).strict();
export type LibraryArmHistory = z.infer<typeof armsSchema>;
export const armHistoryKey = (row: Pick<LibraryBinomMetrics, "campaignId" | "offerId" | "offerName">) =>
  `${row.campaignId}|${binomOfferKey(row.offerId, row.offerName)}`;
export async function loadArmHistory(store: Store): Promise<LibraryArmHistory> {
  const stored = await store.get<unknown>(ARMS_KEY);
  if (stored === null) return { version: 1, arms: {} };
  try { return armsSchema.parse(stored); }
  catch (error) { throw new Error("Library arm history is corrupt or unreadable", { cause: error }); }
}
export async function saveArmHistory(store: Store, history: LibraryArmHistory): Promise<void> {
  await store.set(ARMS_KEY, armsSchema.parse(history));
}
export function updateArmHistory(history: LibraryArmHistory, rows: Array<LibraryBinomMetrics & { day: string }>): void {
  for (const row of rows) {
    if (!row.uniqueClicks) continue;
    const key = armHistoryKey(row);
    const current = history.arms[key];
    if (!current) history.arms[key] = { firstDay: row.day, lastDay: row.day };
    else {
      if (row.day < current.firstDay) current.firstDay = row.day;
      if (row.day > current.lastDay) current.lastDay = row.day;
    }
  }
}
