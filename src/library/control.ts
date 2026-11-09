import { isParent, parentContext } from "../abAnalysis/parent.js";
import { resolveBinomProject } from "../binom/projects.js";
import { AbRequestBudgetError, InvalidBinomCampaignError, rawCampaignSchema, type BinomListRow,
  type ExperimentBinomSource, type RawBinomCampaign } from "../binom/client.js";
import type { Store } from "../store/index.js";
import type { LibraryInput } from "./compute.js";

type Log = (entry: Record<string, unknown>) => void;
export const PARENT_CACHE_TTL_SECONDS = 24 * 3600;
export const parentCacheKey = (id: number) => `binom:campaign:${id}`;

/** Parents `parentContext` would consider: `[MAIN]`/`[GLOBAL]` rows of the same project, never the campaign itself. */
export function parentCandidates(campaignIds: readonly number[], projects: Record<number, string | undefined>,
  listed: BinomListRow[]): number[] {
  const ids = new Set<number>();
  for (const campaignId of campaignIds) {
    const project = projects[campaignId];
    if (!project) continue;
    for (const row of listed) {
      if (row.id !== campaignId && isParent(row) && resolveBinomProject(row) === project) ids.add(row.id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Raw parent campaigns from the 24 h store cache, else from Binom. Parent reads are optional: on budget
 * exhaustion or a failed read the remaining parents are skipped and control falls back to the next rule.
 */
export async function loadParents(binom: Pick<ExperimentBinomSource, "rawCampaign">, store: Store, ids: readonly number[],
  log: Log, signal?: AbortSignal): Promise<{ cache: Map<number, RawBinomCampaign>; skipped: Set<number> }> {
  const cache = new Map<number, RawBinomCampaign>();
  const skipped = new Set<number>();
  const missing: number[] = [];
  for (const id of ids) {
    const parsed = rawCampaignSchema.safeParse(await store.get<unknown>(parentCacheKey(id)));
    if (parsed.success && parsed.data.id === id) cache.set(id, parsed.data);
    else missing.push(id);
  }
  for (const [index, id] of missing.entries()) {
    try {
      const campaign = await binom.rawCampaign(id);
      cache.set(id, campaign);
      await store.set(parentCacheKey(id), campaign, { ttlSeconds: PARENT_CACHE_TTL_SECONDS });
    } catch (error) {
      // The run deadline is not an optional-read failure: stop the whole run.
      signal?.throwIfAborted();
      if (error instanceof InvalidBinomCampaignError) {
        log({ level: "warn", msg: "Library parent campaign invalid; skipped", campaignId: id });
        continue;
      }
      log({ level: "warn", msg: error instanceof AbRequestBudgetError
        ? "Library parent reads skipped: request budget exhausted; control falls back to T number"
        : "Library parent read failed; remaining parents skipped, control falls back to T number",
      skipped: missing.length - index });
      for (const skippedId of missing.slice(index)) skipped.add(skippedId);
      break;
    }
  }
  return { cache, skipped };
}

/** Campaigns whose control may have fallen back to the T number because a parent read was skipped. */
export function campaignsWithSkippedParents(campaignIds: readonly number[], projects: Record<number, string | undefined>,
  listed: BinomListRow[], skipped: ReadonlySet<number>): number[] {
  if (!skipped.size) return [];
  return campaignIds.filter(id => parentCandidates([id], projects, listed).some(parent => skipped.has(parent)));
}

/** Same shares as our production collection, computed only when at least one parent is known. */
export function parentSharesFor(campaignIds: readonly number[], projects: Record<number, string | undefined>,
  listed: BinomListRow[], cache: Map<number, RawBinomCampaign>): LibraryInput["parentShares"] {
  const shares: LibraryInput["parentShares"] = {};
  for (const campaignId of campaignIds) {
    const project = projects[campaignId];
    if (project && cache.size) shares[campaignId] = Object.fromEntries(parentContext(campaignId, project, listed, cache).shares);
  }
  return shares;
}
