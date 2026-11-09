const GROUPS: Record<string, string> = {
  "1e784d7b-835b-4b9a-be2f-0a3ad81f9f61": "IQ", "0a9487bc-cc54-41e0-a03e-ac954b9ea01f": "IQ",
  "5a1869dc-e4c3-4dd7-b805-af7d0b11bb0f": "Subcaddy", "3fc69cbe-bc96-4873-917e-a866bcc862ab": "Planbix",
  "dbcf8821-35f6-4b7e-8a1c-642a011c804b": "Monetao",
};
const GROUP_NAMES: Record<string, string> = { iq: "IQ", iqnio: "IQ", subcaddy: "Subcaddy", planbix: "Planbix", monetao: "Monetao", zodeya: "Zodeya" };
/** Shared with deployment verification; verified campaign overrides survive group changes. */
export function resolveBinomProject(campaign: { id: number; groupUuid?: unknown; groupName?: unknown }): string | undefined {
  if (campaign.id === 12 || campaign.id === 13) return "Subcaddy";
  const uuid = typeof campaign.groupUuid === "string" ? campaign.groupUuid : "";
  const name = typeof campaign.groupName === "string" ? campaign.groupName.trim().toLowerCase() : "";
  return (Object.hasOwn(GROUPS, uuid) ? GROUPS[uuid] : undefined)
    ?? (Object.hasOwn(GROUP_NAMES, name) ? GROUP_NAMES[name] : undefined);
}
