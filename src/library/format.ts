import type { LibraryCell } from "./compute.js";

const DASH = "—";

function decimal(value: number, digits: number): string { return value.toFixed(digits).replace(".", ","); }
export function percent(value: number | null | undefined, digits: number, signed = false): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const rounded = Number((value * 100).toFixed(digits));
  return `${signed && rounded > 0 ? "+" : ""}${decimal(rounded, digits)}%`;
}
export function effect(value: number | null, low: number | null, high: number | null): string {
  if (value === null || low === null || high === null) return DASH;
  return `${percent(value, 1, true)} [${percent(low, 1, true)}; ${percent(high, 1, true)}]`;
}
export function pValue(value: number | null): string {
  return value === null || !Number.isFinite(value) ? DASH : value < 0.001 ? "<0,001" : decimal(value, 3);
}
export function money(value: number | null | undefined, digits: number): string {
  return value == null || !Number.isFinite(value) ? DASH : `$${decimal(value, digits)}`;
}
export function pair(left: number | null | undefined, right: number | null | undefined): string {
  return `${left == null || !Number.isFinite(left) ? DASH : thousands(left)} / ` +
    `${right == null || !Number.isFinite(right) ? DASH : thousands(right)}`;
}
export function thousands(value: number): string { return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
export function cellText(cell: LibraryCell): string {
  if (typeof cell === "string") return cell;
  const value = typeof cell === "number" ? cell : cell.value;
  if (!Number.isFinite(value)) return DASH;
  if (typeof cell === "number" || cell.format === "int") return String(value);
  switch (cell.format) {
    case "count": return thousands(value);
    case "percent1": return percent(value, 1);
    case "percent2": return percent(value, 2);
    case "signedPercent1": return percent(value, 1, true);
    case "usd1": return money(value, 1);
    case "usd2": return money(value, 2);
  }
}
export function shortDate(day: string): string { return `${day.slice(8, 10)}.${day.slice(5, 7)}`; }
export function fullDate(day: string): string { return `${shortDate(day)}.${day.slice(0, 4)}`; }
