import { compareProportions, holm } from "../abAnalysis/stats.js";
import type { ComparisonResult } from "../abAnalysis/contract.js";
import { addDays } from "../utils/time.js";
import type { LibraryCwRow } from "../cw/cw.js";
import { binomOfferKey, type BinomListRow, type LibraryBinomMetrics, type LibraryBinomReport } from "../binom/client.js";
import { armHistoryKey, type LibraryArmHistory } from "./arms.js";
import { effect, pValue, pair, shortDate, thousands } from "./format.js";

export type LibraryNumberFormat = "int" | "count" | "percent1" | "percent2" | "signedPercent1" | "usd1" | "usd2";
export type LibraryCell = string | number | { value: number; format: LibraryNumberFormat };
export type LibraryPaid = { payers: number; maturedIntros: number } | { gap: string } | { availableOn: string };
export interface LibraryInput {
  day: string; campaigns: BinomListRow[]; lifetime: LibraryBinomReport; recent: LibraryBinomReport;
  history: LibraryArmHistory; aliases: Record<string, string>; overrides: Readonly<Record<number, number>>;
  parentShares: Record<number, Record<number, number>>; projects: Record<number, string | undefined>;
  cw: LibraryCwRow[] | null; configuredProjects: readonly string[]; paid: Record<string, LibraryPaid>;
  registry: Record<string, { row: number; name: string }>;
}
export interface LibraryRow { campaignId: number; controlKey: string | null; variantKey: string | null; cells: LibraryCell[] }

export function qualifyingArms(campaignId: number, report: LibraryBinomReport): LibraryBinomMetrics[] {
  const total = report.campaigns.find(row => row.campaignId === campaignId)?.uniqueClicks ?? 0;
  return report.metrics.filter(row => row.campaignId === campaignId && row.uniqueClicks >= 100 && row.uniqueClicks >= total * 0.05);
}
function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url.split(/[?#]/, 1)[0]; }
}
function shortName(arm: LibraryBinomMetrics): string {
  return /^T\d+/i.exec(arm.offerName)?.[0] ?? (arm.offerId === null
    ? pathOf(arm.offerName).split("/").filter(Boolean).at(-1) ?? arm.offerName : arm.offerName);
}
const armKey = (arm: LibraryBinomMetrics) => binomOfferKey(arm.offerId, arm.offerName);
function selectControl(input: LibraryInput, campaignId: number, arms: LibraryBinomMetrics[]): LibraryBinomMetrics {
  const matching = (id: number | null | undefined) => id == null ? undefined : arms.find(arm => arm.offerId === id);
  const explicit = matching(input.overrides[campaignId]);
  if (explicit) return explicit;
  const shares = input.parentShares[campaignId] ?? {};
  const parent = arms.filter(arm => arm.offerId !== null && shares[arm.offerId] > 0)
    .sort((a, b) => shares[b.offerId!] - shares[a.offerId!] || a.offerId! - b.offerId!)[0];
  if (parent) return parent;
  const offers = arms.filter(arm => arm.offerId !== null);
  const testNumber = (name: string) => Math.min(Infinity, ...Array.from(name.matchAll(/T(\d+)/gi), match => Number(match[1])));
  if (offers.length) return offers.sort((a, b) => {
    return testNumber(a.offerName) - testNumber(b.offerName) || a.offerId! - b.offerId!;
  })[0];
  const appearances = (arm: LibraryBinomMetrics) => new Set(input.lifetime.metrics.filter(row => row.offerId === null
    && row.campaignId !== campaignId && pathOf(row.offerName) === pathOf(arm.offerName)).map(row => row.campaignId)).size;
  return [...arms].sort((a, b) => appearances(b) - appearances(a)
    || (input.history.arms[armHistoryKey(a)]?.firstDay ?? "9999").localeCompare(
      input.history.arms[armHistoryKey(b)]?.firstDay ?? "9999")
    || (a.offerName < b.offerName ? -1 : a.offerName > b.offerName ? 1 : 0))[0];
}
function adjusted(comparisons: Array<ComparisonResult | null>): Array<number | null> {
  const eligible = comparisons.flatMap((comparison, index) => comparison?.pValue == null ? [] : [index]);
  const values = holm(eligible.map(index => comparisons[index]!.pValue!));
  return comparisons.map((_, index) => values[eligible.indexOf(index)] ?? null);
}
function verdict(comparison: ComparisonResult | null, p: number | null): string {
  if (!comparison) return "нет данных";
  if (comparison.status === "insufficient") return "мало данных";
  if (p !== null && p < 0.10) return (comparison.diffPp ?? 0) > 0 ? "лучше" : "хуже";
  return "нет разницы";
}
function threshold(control: number | null, variant: number | null): string {
  if (control === null || variant === null || control === 0) return "нет данных";
  const ratio = variant / control;
  return ratio > 1.05 ? "лучше" : ratio < 0.95 ? "хуже" : "нет разницы";
}
function numberCell(value: number | null | undefined, format: LibraryNumberFormat): LibraryCell {
  return value == null || !Number.isFinite(value) ? "—" : { value, format };
}
function cwArm(input: LibraryInput, arm: LibraryBinomMetrics | null): { subs: number | null; pltv: number | null; gap?: string } {
  if (!arm) return { subs: null, pltv: null };
  if (!input.projects[arm.campaignId] || !input.configuredProjects.includes(input.projects[arm.campaignId]!)) {
    return { subs: null, pltv: null, gap: "CW: приложение проекта не настроено" };
  }
  if (arm.offerId === null) return { subs: null, pltv: null, gap: "CW: варианты — прямые ссылки, разметка не сопоставляется" };
  if (input.lifetime.metrics.some(other => other.campaignId === arm.campaignId && other.offerId !== null
    && other.offerId !== arm.offerId && other.offerName === arm.offerName)) {
    return { subs: null, pltv: null, gap: "CW: одинаковые названия офферов — нельзя разнести" };
  }
  if (input.cw === null) return { subs: null, pltv: null, gap: "CW недоступен" };
  const rows = input.cw.filter(row => row.campaign === String(arm.campaignId) && row.offer === arm.offerName);
  if (!rows.length) return { subs: null, pltv: null, gap: `CW: у ${shortName(arm)} нет строк с cw_p3=${arm.campaignId}` };
  const subs = rows.every(row => row.subscribers !== null) ? rows.reduce((n, row) => n + row.subscribers!, 0) : null;
  const prediction = rows.every(row => row.predictedRevenue !== null) ? rows.reduce((n, row) => n + row.predictedRevenue!, 0) : null;
  const pltv = subs !== null && subs > 0 && prediction !== null ? prediction / subs : null;
  const coverage = subs !== null ? (arm.purchases > 0 ? subs / arm.purchases : subs > 0 ? Infinity : null) : null;
  const gaps: string[] = [];
  if (subs === null) gaps.push(`CW: у ${shortName(arm)} нет данных о подписках`);
  else if (prediction === null) gaps.push(`CW: у ${shortName(arm)} нет прогноза выручки (pLTV)`);
  if (coverage !== null && (coverage < 0.8 || coverage > 1.25)) {
    gaps.push(`CW: у ${shortName(arm)} ${thousands(subs!)} подписок при ${thousands(arm.purchases)} покупках в Binom — разметка неполная`);
  }
  return { subs, pltv, gap: gaps.join("; ") || undefined };
}
function paidArm(input: LibraryInput, arm: LibraryBinomMetrics | null): LibraryPaid | null {
  if (!arm) return null;
  return input.paid[armHistoryKey(arm)] ?? { gap: "trial→paid: данные недоступны" };
}
function paidRate(paid: LibraryPaid | null): number | null {
  return paid && "payers" in paid && paid.maturedIntros ? paid.payers / paid.maturedIntros : null;
}

export function computeLibrary(input: LibraryInput): LibraryRow[] {
  const baseLabel = (campaign: BinomListRow) =>
    input.aliases[String(campaign.id)] ?? /^E\d+/i.exec(campaign.name)?.[0] ?? `#${campaign.id}`;
  const baseLabelCounts = new Map<string, number>();
  for (const campaign of input.campaigns) {
    const base = baseLabel(campaign);
    baseLabelCounts.set(base, (baseLabelCounts.get(base) ?? 0) + 1);
  }
  const ordered = [...input.campaigns].sort((a, b) =>
    (input.lifetime.campaigns.find(row => row.campaignId === b.id)?.purchases ?? 0)
    - (input.lifetime.campaigns.find(row => row.campaignId === a.id)?.purchases ?? 0) || b.id - a.id);
  const output: LibraryRow[] = [];
  for (const campaign of ordered) {
    const all = input.lifetime.metrics.filter(row => row.campaignId === campaign.id);
    const arms = qualifyingArms(campaign.id, input.lifetime);
    const control = arms.length > 1 ? selectControl(input, campaign.id, arms) : null;
    const variants = (control ? arms.filter(arm => arm !== control) : arms).sort((a, b) => b.purchases - a.purchases
      || armKey(a).localeCompare(armKey(b)));
    const nonqualifying = all.filter(arm => !arms.includes(arm));
    const campaignTotal = input.lifetime.campaigns.find(row => row.campaignId === campaign.id);
    const recent = input.recent.campaigns.find(row => row.campaignId === campaign.id)?.purchases ?? 0;
    const isEmpty = !campaignTotal || campaignTotal.uniqueClicks === 0;
    const variantRows: Array<LibraryBinomMetrics | null> = variants.length ? variants : [null];
    const comparisons = variantRows.map(variant => control && variant ? compareProportions(
      { x: control.purchases, n: control.uniqueClicks }, { x: variant.purchases, n: variant.uniqueClicks },
      { alpha: 0.10, minConversions: 30 }) : null);
    const cvrP = adjusted(comparisons);
    const paidControl = paidArm(input, control);
    const paidVariants = variantRows.map(variant => paidArm(input, variant));
    const paidComparisons = paidVariants.map(paid => paidControl && "payers" in paidControl && paid && "payers" in paid
      ? compareProportions({ x: paidControl.payers, n: paidControl.maturedIntros },
        { x: paid.payers, n: paid.maturedIntros }, { alpha: 0.10, minConversions: 10 }) : null);
    const paidP = adjusted(paidComparisons);
    const base = baseLabel(campaign);
    const registryKey = /^E\d+/i.exec(base)?.[0].toUpperCase();
    const labelBase = baseLabelCounts.get(base)! > 1 ? `${base} (#${campaign.id})` : base;
    const registry = registryKey ? input.registry[registryKey] : undefined;
    const recentHistory = all.filter(arm => arm.uniqueClicks > 0).map(arm => input.history.arms[armHistoryKey(arm)]);
    const last = recentHistory.length && recentHistory.every(Boolean) ? recentHistory.map(item => item!.lastDay).sort().at(-1) : undefined;
    const first = !isEmpty && recentHistory.length && recentHistory.every(Boolean)
      ? recentHistory.map(item => item!.firstDay).sort()[0] : undefined;
    const status = isEmpty ? "нет трафика" : !last ? "—"
      : last < addDays(input.day, -2) ? `стоп с ${shortDate(addDays(last, 1))}` : "идёт";
    variantRows.forEach((variant, index) => {
      const comment: string[] = [];
      if (!isEmpty && nonqualifying.length) comment.push(`Ещё ${nonqualifying.length} офферов с малым трафиком ` +
        `(${thousands(nonqualifying.reduce((n, arm) => n + arm.uniqueClicks, 0))} кликов) не показаны`);
      if (!isEmpty && !control) comment.push(variant ? "Одиночный запуск: контроля в кампании нет" : "Нет плеч с достаточным трафиком");
      if (control && variant && variants.length > 1) comment.push(`p с поправкой Холма на ${variants.length} вариантов`);
      const first1 = control && input.history.arms[armHistoryKey(control)]?.firstDay;
      const first2 = variant && input.history.arms[armHistoryKey(variant)]?.firstDay;
      const staggered = first1 && first2 && Math.abs(Date.parse(first1) - Date.parse(first2)) > 86400_000;
      if (staggered && control && variant) comment.push(`Плечи стартовали в разные дни: ${shortName(control)} с ${shortDate(first1)}, ` +
        `${shortName(variant)} с ${shortDate(first2)} — сравнение за весь срок смещено; ` +
        "выровненное окно — на панели A/B");
      for (const paid of [paidControl, paidVariants[index]]) {
        if (paid && "gap" in paid) comment.push(paid.gap);
        if (paid && "availableOn" in paid) comment.push(`trial→paid созреет ${shortDate(paid.availableOn)}`);
      }
      const cw1 = cwArm(input, control);
      const cw2 = cwArm(input, variant);
      const cwComment: string[] = [];
      if (input.cw === null && (control || variant)) cwComment.push("CW недоступен");
      if ((cw1.subs !== null && cw1.subs < 30) || (cw2.subs !== null && cw2.subs < 30)) cwComment.push("мало подписок");
      if (cw1.gap) cwComment.push(cw1.gap);
      if (cw2.gap) cwComment.push(cw2.gap);
      const pltvVerdict = !control || !variant ? (isEmpty ? "нет данных" : "не сравнить")
        : (cw1.subs !== null && cw1.subs < 30) || (cw2.subs !== null && cw2.subs < 30) ? "мало данных"
          : cw1.subs === null || cw2.subs === null ? "нет данных" : threshold(cw1.pltv, cw2.pltv);
      const revenue1 = control ? control.revenue / control.uniqueClicks : null;
      const revenue2 = variant ? variant.revenue / variant.uniqueClicks : null;
      const revenueVerdict = !control || !variant ? (isEmpty ? "нет данных" : "не сравнить")
        : Math.min(control.purchases, variant.purchases) < 30 ? "мало данных" : threshold(revenue1, revenue2);
      const cvrVerdict = !control || !variant ? (isEmpty ? "нет данных" : "не сравнить") : verdict(comparisons[index], cvrP[index]);
      const paidVerdict = !control || !variant ? (isEmpty ? "нет данных" : "не сравнить") : verdict(paidComparisons[index], paidP[index]);
      const cmp = comparisons[index];
      const label = `${labelBase}${/\[GLOBAL\]/i.test(campaign.name) ? " [GLOBAL]" : ""}`;
      const cells: LibraryCell[] = [registry ? numberCell(registry.row, "int") : "", label, registry?.name || campaign.name,
        status, first ? shortDate(first) : "—", index === 0 && !isEmpty ? numberCell(recent, "count") : "",
        control ? shortName(control) : "—", variant ? shortName(variant) : "—",
        numberCell(control ? control.purchases / control.uniqueClicks : null, "percent2"),
        numberCell(variant ? variant.purchases / variant.uniqueClicks : null, "percent2"),
        cmp ? effect(cmp.lift, cmp.liftCiLow, cmp.liftCiHigh) : "—", pValue(cvrP[index]),
        cvrVerdict + (staggered ? " (разный старт)" : ""), isEmpty ? "—" : pair(control?.purchases, variant?.purchases),
        numberCell(revenue1, "usd2"), numberCell(revenue2, "usd2"), revenueVerdict,
        isEmpty ? "—" : pair(cw1.subs, cw2.subs), numberCell(cw1.pltv, "usd1"), numberCell(cw2.pltv, "usd1"),
        numberCell(cw1.pltv && cw2.pltv !== null ? cw2.pltv / cw1.pltv - 1 : null, "signedPercent1"), pltvVerdict,
        numberCell(paidRate(paidControl), "percent1"), numberCell(paidRate(paidVariants[index]), "percent1"),
        pValue(paidP[index]), paidVerdict, [...new Set([...comment, ...cwComment])].join("; ")];
      output.push({ campaignId: campaign.id, controlKey: control ? armKey(control) : null,
        variantKey: variant ? armKey(variant) : null, cells });
    });
  }
  return output;
}
