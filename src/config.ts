import { z } from "zod";
import { daySchema } from "./abAnalysis/contract.js";
import type { ServiceAccountKey } from "./sheets/client.js";

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(value => value === "" ? undefined : value, schema);
const flag = optional(z.enum(["true", "false"]).default("false").transform(value => value === "true"));
const lagDefaults = { IQ: 10, Zodeya: 16, Subcaddy: 14, "34": 19 };

export function parseAbPaidLagDays(raw?: string): Record<string, number> {
  if (!raw) return { ...lagDefaults };
  try {
    const overrides = z.record(z.string().regex(/^(IQ|Zodeya|Subcaddy|[1-9]\d*)$/),
      z.number().int().nonnegative().safe()).parse(JSON.parse(raw));
    return { ...lagDefaults, ...overrides };
  } catch { throw new Error("LIBRARY_PAID_LAG_DAYS must be a JSON object of product/offer integer days >= 0"); }
}

export function abPaidLagDays(project: string, offers: readonly { offerId: number }[], config: Record<string, number>): number {
  return Math.max(...offers.map(offer => config[String(offer.offerId)] ?? config[project] ?? 14));
}

export function parseServiceAccount(raw?: string): ServiceAccountKey | undefined {
  if (!raw) return undefined;
  try {
    const data: unknown = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
    return z.object({ client_email: z.string().email(), private_key: z.string().min(1) }).passthrough().parse(data);
  } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must contain a valid service account JSON key"); }
}

export function assertAllowedTab(gid: number, allowed: boolean): void {
  if (!allowed && (gid === 1514034458 || gid === 1991356788)) {
    throw new Error("Protected sheet tab: this is the production tab or Dmitry's hand-made draft; " +
      "set LIBRARY_ALLOW_PROTECTED_TAB=true only if you intend to overwrite it");
  }
}

export function parseLibraryConfig(env: NodeJS.ProcessEnv = process.env) {
  const schema = z.object({
    LIBRARY_MODE: optional(z.enum(["off", "dry-run", "write"]).default("dry-run")),
    LIBRARY_FROM: optional(daySchema.default("2026-06-01")),
    LIBRARY_REQUEST_BUDGET: optional(z.coerce.number().int().positive().safe().default(80)),
    LIBRARY_DAYS_CHUNK: optional(z.coerce.number().int().min(1).max(10).default(4)),
    LIBRARY_ALIASES: optional(z.string().default('{"14":"E011","15":"E012","16":"E014"}')),
    LIBRARY_SPREADSHEET_ID: optional(z.string().min(1).optional()),
    LIBRARY_SHEET_GID: optional(z.coerce.number().int().nonnegative().safe().optional()),
    LIBRARY_SHEET_TITLE: optional(z.string().min(1).default("Драфт отчета по всем тестам - авто (Vercel)")),
    LIBRARY_ARCHIVE: flag,
    LIBRARY_REGISTRY_TAB: optional(z.string().min(1).default("Тесты")),
    LIBRARY_ALLOW_PROTECTED_TAB: flag,
    BINOM_BASE_URL: optional(z.string().optional()),
    BINOM_API_KEY: optional(z.string().optional()),
    CW_SERVER_URL: optional(z.string().url().default("https://mcp.campaignswell.com")),
    CW_REFRESH_DISABLED: flag,
    LIBRARY_DEADLINE_SECONDS: optional(z.coerce.number().int().min(30).max(1750).default(270)),
    LIBRARY_ALERT_WEBHOOK_URL: optional(z.string().url().startsWith("https://").optional())
  });
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid settings: ${result.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  const v = result.data;
  let aliases: Record<string, string>;
  try { aliases = z.record(z.string().regex(/^[1-9]\d*$/), z.string().min(1)).parse(JSON.parse(v.LIBRARY_ALIASES)); }
  catch { throw new Error("LIBRARY_ALIASES must be a JSON object of campaign IDs and labels"); }
  const overrides: Record<number, number> = {};
  if (env.LIBRARY_BASE_OFFER_OVERRIDES) for (const pair of env.LIBRARY_BASE_OFFER_OVERRIDES.split(",")) {
    const match = /^(\d+):(\d+)$/.exec(pair.trim());
    if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) {
      throw new Error("LIBRARY_BASE_OFFER_OVERRIDES must contain campaignId:offerId pairs");
    }
    overrides[Number(match[1])] = Number(match[2]);
  }
  if (v.LIBRARY_MODE !== "off") {
    let url: URL;
    try { url = new URL(v.BINOM_BASE_URL ?? ""); } catch { throw new Error("BINOM_BASE_URL must be an HTTPS origin"); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("BINOM_BASE_URL must be an HTTPS origin");
    }
    if (!v.BINOM_API_KEY || v.BINOM_API_KEY.length < 20) throw new Error("BINOM_API_KEY must have at least 20 characters");
  }
  const credentials = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (v.LIBRARY_MODE === "write" && (!v.LIBRARY_SPREADSHEET_ID || !credentials)) {
    throw new Error("Library write mode requires LIBRARY_SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON");
  }
  return { mode: v.LIBRARY_MODE, from: v.LIBRARY_FROM, requestBudget: v.LIBRARY_REQUEST_BUDGET,
    daysChunk: v.LIBRARY_DAYS_CHUNK, aliases, spreadsheetId: v.LIBRARY_SPREADSHEET_ID, sheetGid: v.LIBRARY_SHEET_GID,
    sheetTitle: v.LIBRARY_SHEET_TITLE, archive: v.LIBRARY_ARCHIVE, registryTab: v.LIBRARY_REGISTRY_TAB,
    allowProtectedTab: v.LIBRARY_ALLOW_PROTECTED_TAB, binomBaseUrl: v.BINOM_BASE_URL, binomApiKey: v.BINOM_API_KEY,
    cwServerUrl: v.CW_SERVER_URL.replace(/\/$/, ""), cwRefreshDisabled: v.CW_REFRESH_DISABLED, credentials, overrides,
    paidLagDays: parseAbPaidLagDays(env.LIBRARY_PAID_LAG_DAYS), deadlineSeconds: v.LIBRARY_DEADLINE_SECONDS,
    alertWebhookUrl: v.LIBRARY_ALERT_WEBHOOK_URL };
}
export type LibraryConfig = ReturnType<typeof parseLibraryConfig>;
