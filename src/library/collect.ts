import { daySchema } from "../abAnalysis/contract.js";
import { resolveBinomProject } from "../binom/projects.js";
import type { SheetsApi } from "../sheets/client.js";
import { addDays } from "../utils/time.js";
import { parsePaidStatuses } from "../abAnalysis/paid.js";
import { APPLICATIONS, fetchLibraryCw } from "../cw/cw.js";
import { AbRequestBudgetError, BOTS_TRAP, type BinomListRow, type ExperimentBinomSource } from "../binom/client.js";
import { abPaidLagDays, type LibraryConfig } from "../config.js";
import type { Store } from "../store/index.js";
import { armHistoryKey, loadArmHistory, saveArmHistory, updateArmHistory } from "./arms.js";
import { qualifyingArms, type LibraryInput, type LibraryPaid } from "./compute.js";
import { campaignsWithSkippedParents, loadParents, parentCandidates, parentSharesFor } from "./control.js";

type Log = (entry: Record<string, unknown>) => void;
const chunks = <T>(rows: T[], size: number) => Array.from({ length: Math.ceil(rows.length / size) },
  (_, index) => rows.slice(index * size, (index + 1) * size));
export function includedCampaigns(rows: BinomListRow[], aliases: Record<string, string>): BinomListRow[] {
  return rows.filter(row => !BOTS_TRAP.test(row.name) && !/bots?[\s_-]*trap/i.test(row.name) && !/\[MAIN\]/i.test(row.name) &&
    (/^E\d+/i.test(row.name) || /\[TEST/i.test(row.name) || /\btest\b/i.test(row.name) || Object.hasOwn(aliases, row.id)));
}
async function readRegistry(api: SheetsApi | undefined, config: LibraryConfig, log: Log): Promise<LibraryInput["registry"]> {
  if (!api || !config.spreadsheetId) {
    log({ level: "warn", msg: "Library registry unavailable: Google Sheets not configured" });
    return {};
  }
  try {
    const spreadsheet = await api.getSpreadsheet(config.spreadsheetId);
    if (!spreadsheet.sheets?.some(sheet => sheet.properties?.title === config.registryTab)) {
      log({ level: "warn", msg: "Library registry tab missing" });
      return {};
    }
    const range = `'${config.registryTab.replaceAll("'", "''")}'!A:B`;
    const [rows] = await api.batchGetValues(config.spreadsheetId, [range]);
    const registry: LibraryInput["registry"] = {};
    rows.forEach((row, index) => {
      if (typeof row[0] !== "string") return;
      const code = /^(E\d+)(?=\D|$)/i.exec(row[0])?.[1].toUpperCase();
      if (code && !registry[code]) registry[code] = { row: index + 1, name: row[1] == null ? "" : String(row[1]) };
    });
    return registry;
  } catch {
    log({ level: "warn", msg: "Library registry read failed" });
    return {};
  }
}

/** Throws unless `day` is a complete UTC day on or after LIBRARY_FROM. */
export function assertLibraryDay(day: string, from: string, now = new Date()): void {
  daySchema.parse(day);
  if (day >= now.toISOString().slice(0, 10)) throw new Error("Library requires a complete UTC day");
  if (day < from) throw new Error("Library date is before LIBRARY_FROM");
}

export async function collectLibrary(options: { binom: ExperimentBinomSource; config: LibraryConfig; day: string;
  store: Store; sheets?: SheetsApi; signal?: AbortSignal; now?: Date; log: Log }): Promise<{ input: LibraryInput; requests: number;
  parentsSkipped: number[] }> {
  const { binom, config, day, store, log } = options;
  assertLibraryDay(day, config.from, options.now);
  const persistedHistory = await loadArmHistory(store);
  const history = structuredClone(persistedHistory);
  // Historical CLI runs need an as-of-day view but must not roll the shared latest-traffic cache backwards.
  // Also saved after every lifetime-days chunk, so a cold run cut off by the function timeout keeps its progress.
  const persistHistory = async () => {
    for (const [key, value] of Object.entries(history.arms)) {
      const existing = persistedHistory.arms[key];
      if (!existing) persistedHistory.arms[key] = { ...value };
      else {
        if (value.firstDay < existing.firstDay) existing.firstDay = value.firstDay;
        if (value.lastDay > existing.lastDay) existing.lastDay = value.lastDay;
      }
    }
    await saveArmHistory(store, persistedHistory);
  };
  let parentsSkipped: number[] = [];
  const projects: Record<number, string | undefined> = {};
  let parentShares: LibraryInput["parentShares"] = {};
  const paid: Record<string, LibraryPaid> = {};
  const result = await binom.withAnalysisBudget(async () => {
    const listed = await binom.campaignList();
    const campaigns = includedCampaigns(listed, config.aliases);
    const ids = campaigns.map(row => row.id);
    for (const campaign of campaigns) projects[campaign.id] = resolveBinomProject(campaign);
    const lifetime = await binom.libraryReport(ids, config.from, day, false);
    const recentFrom = addDays(day, -2);
    const recent = await binom.libraryReport(ids, recentFrom, day, true);
    const missingCampaigns = new Set<number>();
    for (const campaign of campaigns) {
      const qualified = qualifyingArms(campaign.id, lifetime);
      const recentTraffic = recent.campaigns.find(row => row.campaignId === campaign.id)?.uniqueClicks ?? 0;
      for (const arm of lifetime.metrics.filter(row => row.campaignId === campaign.id && row.uniqueClicks > 0)) {
        const key = armHistoryKey(arm);
        if (history.arms[key] && history.arms[key].firstDay <= day && history.arms[key].lastDay <= day) continue;
        const recentArm = recent.metrics.find(row => armHistoryKey(row) === key);
        const days = recent.days.filter(row => armHistoryKey(row) === key && row.uniqueClicks > 0);
        if (recentArm?.uniqueClicks === arm.uniqueClicks && days.length) {
          delete history.arms[key];
          updateArmHistory(history, days);
        } else if (qualified.includes(arm) || recentTraffic === 0) missingCampaigns.add(campaign.id);
      }
    }
    for (const group of chunks([...missingCampaigns], config.daysChunk)) {
      const full = await binom.libraryReport(group, config.from, day, true);
      for (const arm of full.metrics) {
        const key = armHistoryKey(arm);
        if (history.arms[key]?.lastDay && history.arms[key].lastDay > day) delete history.arms[key];
      }
      updateArmHistory(history, full.days);
      await persistHistory();
    }
    for (const row of recent.days) {
      if (history.arms[armHistoryKey(row)]) updateArmHistory(history, [row]);
    }
    for (const campaign of campaigns) {
      for (const arm of qualifyingArms(campaign.id, lifetime)) {
        if (!history.arms[armHistoryKey(arm)]) throw new Error(`Binom: missing traffic days for campaign ${campaign.id}`);
      }
    }
    const lags = config.paidLagDays;
    const groups = new Map<string, number[]>();
    for (const campaign of campaigns) {
      const arms = qualifyingArms(campaign.id, lifetime);
      const offerArms = arms.filter(arm => arm.offerId !== null);
      const lag = offerArms.length ? abPaidLagDays(projects[campaign.id] ?? "", offerArms.map(arm => ({ offerId: arm.offerId! })), lags)
        : lags[projects[campaign.id] ?? ""] ?? 14;
      const paidTo = addDays(day, -lag);
      let needsPaid = false;
      for (const arm of arms) {
        const key = armHistoryKey(arm);
        const first = history.arms[key].firstDay;
        if (first > paidTo) paid[key] = { availableOn: addDays(first, lag) };
        else if (arm.offerId === null) paid[key] = { gap: "trial→paid: прямые ссылки не сопоставляются" };
        else if (paidTo < config.from) paid[key] = { availableOn: addDays(first, lag) };
        else needsPaid = true;
      }
      if (needsPaid) groups.set(paidTo, [...(groups.get(paidTo) ?? []), campaign.id]);
    }
    let stopped = false;
    for (const [paidTo, group] of groups) for (const idsChunk of chunks(group, config.daysChunk)) {
      if (!stopped) {
        try {
          const report = await binom.paidReport(idsChunk, config.from, paidTo);
          for (const id of idsChunk) for (const arm of qualifyingArms(id, lifetime)) {
            const key = armHistoryKey(arm);
            if (arm.offerId === null || paid[key]) continue;
            const value = parsePaidStatuses(report, [{ campaignId: id, offerId: arm.offerId }], arm.offerName);
            paid[key] = "payers" in value ? { payers: value.payers, maturedIntros: value.maturedIntros } : { gap: value.gap };
          }
        } catch (error) {
          if (error instanceof AbRequestBudgetError) throw error;
          stopped = true;
          log({ level: "warn", msg: "Library paid report failed; remaining chunks skipped" });
        }
      }
      if (stopped) for (const id of idsChunk) for (const arm of qualifyingArms(id, lifetime)) {
        const key = armHistoryKey(arm);
        paid[key] ??= { gap: "trial→paid: Binom не ответил" };
      }
    }
    // Parents matter only where an override does not already fix the control. They are read last, so these
    // optional reads never take budget from the required reports above.
    const needsParent = ids.filter(id => {
      const arms = qualifyingArms(id, lifetime);
      return arms.length > 1 && arms.some(arm => arm.offerId !== null)
        && !arms.some(arm => arm.offerId !== null && arm.offerId === config.overrides[id]);
    });
    const parents = await loadParents(binom, store, parentCandidates(needsParent, projects, listed), log, options.signal);
    parentShares = parentSharesFor(ids, projects, listed, parents.cache);
    parentsSkipped = campaignsWithSkippedParents(needsParent, projects, listed, parents.skipped);
    return { campaigns, lifetime, recent };
  }, config.requestBudget);
  await persistHistory();
  const registry = await readRegistry(options.sheets, config, log);
  let cw: LibraryInput["cw"] = [];
  const cwProjects = [...new Set(Object.values(projects).filter((project): project is string => !!project && !!APPLICATIONS[project]))];
  if (cwProjects.length) {
    try {
      cw = await fetchLibraryCw({ store, refreshDisabled: config.cwRefreshDisabled, signal: options.signal },
        cwProjects, config.from, day, log);
    }
    catch (error) {
      cw = null;
      // CW errors are fixed texts or OAuth error codes (see cw/client.ts); they never contain tokens.
      log({ level: "warn", msg: "Library CW unavailable", reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
  }
  return { requests: result.requests, parentsSkipped, input: { day, ...result.data, history, aliases: config.aliases, overrides: config.overrides,
    parentShares, projects, cw, configuredProjects: Object.keys(APPLICATIONS), paid, registry } };
}
