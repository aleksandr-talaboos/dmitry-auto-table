import { resolveBinomProject } from "../binom/projects.js";
import type { BinomListRow, RawBinomCampaign } from "../binom/client.js";

export const isParent = (row: { name: string }) => /\[(MAIN|GLOBAL)\]/i.test(row.name);
function activePaths(campaign: RawBinomCampaign) {
  return [...campaign.customRotation.defaultPaths,
    ...campaign.customRotation.rules.filter(rule => rule.enabled).flatMap(rule => rule.paths)]
    .filter(path => path.enabled && path.weight > 0);
}
export function parentContext(campaignId: number, project: string, listed: BinomListRow[], cache: Map<number, RawBinomCampaign>) {
  const parents = listed.filter(row => row.id !== campaignId && isParent(row) && resolveBinomProject(row) === project);
  const shares = new Map<number, number>();
  const ancestors = new Set([campaignId]);
  // Follow cached enabled routes backwards; another main of the project is not necessarily this test's parent.
  for (let size = 0; size !== ancestors.size;) {
    size = ancestors.size;
    for (const row of parents) {
      const parent = cache.get(row.id);
      if (parent && activePaths(parent).some(path => path.offers.some(offer => offer.enabled && offer.weight > 0
        && ancestors.has(offer.campaignId)))) ancestors.add(row.id);
    }
  }
  for (const row of parents) {
    const parent = cache.get(row.id);
    if (!parent || !ancestors.has(row.id)) continue;
    // Normalize within each routing table; rules have no measured traffic share, so use the largest direct share.
    const tables = [parent.customRotation.defaultPaths,
      ...parent.customRotation.rules.filter(rule => rule.enabled).map(rule => rule.paths)];
    for (const table of tables) {
      const active = table.filter(path => path.enabled && path.weight > 0);
      const pathTotal = active.reduce((sum, path) => sum + path.weight, 0);
      const direct = new Map<number, number>();
      for (const path of active) {
        const offers = path.offers.filter(offer => offer.enabled && offer.weight > 0);
        const total = offers.reduce((sum, offer) => sum + offer.weight, 0);
        for (const offer of offers.filter(offer => offer.offerId > 0 && offer.campaignId === 0)) {
          direct.set(offer.offerId, (direct.get(offer.offerId) ?? 0) + path.weight / pathTotal * offer.weight / total);
        }
      }
      for (const [id, share] of direct) shares.set(id, Math.max(shares.get(id) ?? 0, share));
    }
  }
  const routed = ancestors.size > 1;
  return { shares, routed, missing: !routed && parents.some(row => !cache.has(row.id)) };
}
