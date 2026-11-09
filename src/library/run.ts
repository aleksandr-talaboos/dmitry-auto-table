import { randomUUID, timingSafeEqual } from "node:crypto";
import { BinomRequestGate } from "../binom/gate.js";
import { ExperimentBinomSource } from "../binom/client.js";
import { assertAllowedTab, parseLibraryConfig, type LibraryConfig } from "../config.js";
import { readCampaignswellCredentials } from "../cw/client.js";
import { createSheetsApi, type SheetsApi } from "../sheets/client.js";
import type { Store } from "../store/index.js";
import { addDays } from "../utils/time.js";
import { assertLibraryDay, collectLibrary } from "./collect.js";
import { computeLibrary, type LibraryCell } from "./compute.js";
import { cellText } from "./format.js";
import { LIBRARY_HEADER } from "./layout.js";
import { writeLibrarySheet } from "./sheet.js";

type Log = (entry: Record<string, unknown>) => void;
export type LibraryPass = "early" | "final";
export const LOCK_KEY = "library:lock";
/** The lock outlives the run deadline only briefly, so a killed invocation blocks the next cron for about a minute. */
export const lockTtlSeconds = (config: Pick<LibraryConfig, "deadlineSeconds">) => config.deadlineSeconds + 60;
export const FINAL_TTL_SECONDS = 30 * 24 * 3600;
export const finalKey = (day: string) => `library:final:${day}`;
export const PARENT_SKIPPED_NOTE = "Контроль по T-номеру: кампания-родитель не прочитана из Binom";

export interface LibraryRunDeps {
  store: Store;
  /** Test seams; production builds them from the config. */
  binom?: ExperimentBinomSource;
  sheets?: SheetsApi;
  writeSheet?: typeof writeLibrarySheet;
  now?: Date;
  signal?: AbortSignal;
  log?: Log;
}
export interface LibrarySummary {
  date: string; pass: LibraryPass; rows: number; binomRequests: number; durationMs: number;
  sheet: { gid: number; title: string } | null; warnings: string[];
  /** false when CW was unavailable: a final pass is then not marked done, so the next final cron retries. */
  complete: boolean;
}
export type LibraryRunResult =
  | { status: "skipped"; reason: "off" | "final-done"; date?: string; pass?: LibraryPass }
  | { status: "locked" }
  | { status: "done"; dryRun: boolean; summary: LibrarySummary; csv?: string };

function csvCell(value: LibraryCell): string {
  const text = cellText(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export const yesterdayUtc = (now = new Date()) => addDays(now.toISOString().slice(0, 10), -1);

/** The tab a write would touch: the configured gid, else the existing tab with the configured title. */
async function targetGid(api: SheetsApi, config: LibraryConfig): Promise<number | undefined> {
  if (config.sheetGid !== undefined) return config.sheetGid;
  const spreadsheet = await api.getSpreadsheet(config.spreadsheetId!);
  return spreadsheet.sheets?.find(sheet => sheet.properties?.title === config.sheetTitle)?.properties?.sheetId;
}

export async function runLibrary(config: LibraryConfig, options: { day: string; pass: LibraryPass; dryRun: boolean;
  force?: boolean }, deps: LibraryRunDeps): Promise<LibraryRunResult> {
  const started = Date.now();
  const { store } = deps;
  const { day, pass } = options;
  if (config.mode === "off") return { status: "skipped", reason: "off" };
  const dryRun = config.mode === "dry-run" || options.dryRun;
  assertLibraryDay(day, config.from, deps.now);
  if (!dryRun && (!config.spreadsheetId || !config.credentials)) {
    throw new Error("Library write requires LIBRARY_SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON");
  }
  const owner = randomUUID();
  if (!(await store.setIfAbsent(LOCK_KEY, owner, lockTtlSeconds(config)))) return { status: "locked" };
  const warnings: string[] = [];
  const log: Log = entry => {
    if (entry.level === "warn" && typeof entry.msg === "string") warnings.push(entry.msg);
    (deps.log ?? (item => console.log(JSON.stringify(item))))(entry);
  };
  try {
    if (!dryRun && await store.get(finalKey(day)) !== null && (pass === "early" || !options.force)) {
      return { status: "skipped", reason: "final-done", date: day, pass };
    }
    const sheets = deps.sheets ?? (config.spreadsheetId && config.credentials
      ? createSheetsApi({ credentials: config.credentials }) : undefined);
    const binom = deps.binom ?? new ExperimentBinomSource({ baseUrl: config.binomBaseUrl!, apiKey: config.binomApiKey!,
      gate: new BinomRequestGate(), analysisRequestBudget: config.requestBudget, signal: deps.signal });
    if (!dryRun) {
      // Refuse protected tabs before spending any Binom requests.
      const gid = await targetGid(sheets!, config);
      if (gid !== undefined) assertAllowedTab(gid, config.allowProtectedTab);
    }
    if (!config.cwRefreshDisabled) {
      // Rotate a near-expiry CW token now, while the run is far from its deadline: a rotation cut off between
      // the token response and the store write loses the refresh token and needs a new `npm run cw:login`.
      try { await readCampaignswellCredentials({ store, refreshDisabled: false, signal: deps.signal }); }
      catch (error) {
        deps.signal?.throwIfAborted();
        log({ level: "warn", msg: "CW token check failed before collection",
          reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      }
    }
    const collected = await collectLibrary({ binom, config, day, store, sheets, signal: deps.signal, now: deps.now, log });
    const rows = computeLibrary(collected.input);
    const skippedParents = new Set(collected.parentsSkipped);
    for (const row of rows) if (skippedParents.has(row.campaignId)) {
      const last = row.cells.length - 1;
      row.cells[last] = [cellText(row.cells[last]), PARENT_SKIPPED_NOTE].filter(Boolean).join("; ");
    }
    const complete = collected.input.cw !== null;
    const summary = (sheet: LibrarySummary["sheet"]): LibrarySummary => ({ date: day, pass, rows: rows.length,
      binomRequests: collected.requests, durationMs: Date.now() - started, sheet, warnings, complete });
    if (dryRun) {
      const csv = [LIBRARY_HEADER, ...rows.map(row => row.cells)].map(row => row.map(csvCell).join(",")).join("\n");
      return { status: "done", dryRun: true, summary: summary(null), csv: `\uFEFF${csv}\n` };
    }
    const sheet = await (deps.writeSheet ?? writeLibrarySheet)(sheets!, config.spreadsheetId!, {
      gid: config.sheetGid, title: config.sheetTitle, archive: config.archive,
      registryTitle: config.registryTab, preliminary: pass === "early"
    }, day, rows);
    log({ level: "info", msg: "Library sheet written", ...sheet });
    if (pass === "final" && complete) {
      await store.set(finalKey(day), { at: new Date().toISOString(), rows: rows.length }, { ttlSeconds: FINAL_TTL_SECONDS });
    }
    return { status: "done", dryRun: false, summary: summary({ gid: sheet.sheetId, title: sheet.title }) };
  } finally {
    await store.deleteIfValue(LOCK_KEY, owner).catch(() => undefined);
  }
}

/** Error text without any configured secret, bounded in length. */
export function safeMessage(error: unknown, secrets: Array<string | undefined>): string {
  let message = error instanceof Error ? error.message : "Unexpected error";
  for (const secret of secrets) if (secret && secret.length >= 8) message = message.replaceAll(secret, "[redacted]");
  return message.slice(0, 300);
}
function secretMatches(header: unknown, secret: string): boolean {
  if (typeof header !== "string") return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export interface HttpResult { status: number; contentType: string; body: string; headers?: Record<string, string> }
const json = (status: number, body: unknown): HttpResult =>
  ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
/** HTTP header values must be Latin-1: escape everything else as JSON \u sequences. */
const asciiJson = (value: unknown) => JSON.stringify(value).replace(/[\u0080-\uffff]/g,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
export const MIN_CRON_SECRET_LENGTH = 32;

/** Optional Slack-compatible incoming webhook (`{"text": …}`); a failed alert never fails the run. */
async function postAlert(env: NodeJS.ProcessEnv, text: string, log: Log, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = env.LIBRARY_ALERT_WEBHOOK_URL;
  if (!url || !url.startsWith("https://")) return;
  try {
    const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) log({ level: "warn", msg: "Library alert webhook failed", status: response.status });
  } catch {
    log({ level: "warn", msg: "Library alert webhook failed" });
  }
}

/** Framework-free core of `api/run.ts`. */
export async function handleRun(request: { headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined> }, env: NodeJS.ProcessEnv,
  deps: Omit<LibraryRunDeps, "store"> & { store: () => Store; run?: typeof runLibrary; fetchImpl?: typeof fetch }):
  Promise<HttpResult> {
  const secrets = [env.CRON_SECRET, env.BINOM_API_KEY, env.UPSTASH_REDIS_REST_TOKEN, env.KV_REST_API_TOKEN,
    env.LIBRARY_ALERT_WEBHOOK_URL];
  if (!env.CRON_SECRET) return json(500, { error: "CRON_SECRET is not configured" });
  if (env.CRON_SECRET.length < MIN_CRON_SECRET_LENGTH) {
    return json(500, { error: `CRON_SECRET must have at least ${MIN_CRON_SECRET_LENGTH} characters` });
  }
  if (!secretMatches(first(request.headers.authorization), env.CRON_SECRET)) return json(401, { error: "Unauthorized" });
  const log: Log = deps.log ?? (entry => console.log(JSON.stringify(entry)));
  const pass = first(request.query.pass) ?? "final";
  let day: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const config = parseLibraryConfig(env);
    if (config.mode === "off") return json(200, { skipped: "off" });
    if (pass !== "early" && pass !== "final") return json(400, { error: "pass must be early or final" });
    day = first(request.query.date) ?? yesterdayUtc(deps.now);
    try { assertLibraryDay(day, config.from, deps.now); }
    catch (error) {
      return json(400, { error: error instanceof Error && error.message.startsWith("Library")
        ? error.message : "date must be YYYY-MM-DD" });
    }
    // Vercel kills the function at maxDuration without running `finally`; stop a little earlier so the lock is
    // released and the failure is logged and alerted. LIBRARY_DEADLINE_SECONDS must stay below maxDuration.
    const deadline = new AbortController();
    timer = setTimeout(() => deadline.abort(new Error(`Library run stopped at its ${config.deadlineSeconds} s deadline`)),
      config.deadlineSeconds * 1000);
    const signal = deps.signal ? AbortSignal.any([deadline.signal, deps.signal]) : deadline.signal;
    const result = await (deps.run ?? runLibrary)(config, { day, pass, dryRun: first(request.query.dryRun) === "1",
      force: first(request.query.force) === "1" }, { ...deps, store: deps.store(), signal, log });
    if (result.status === "locked") return json(409, { error: "Another library run is in progress" });
    if (result.status === "skipped") return json(200, { skipped: result.reason, date: result.date, pass: result.pass });
    if (result.dryRun) {
      return { status: 200, contentType: "text/csv; charset=utf-8", body: result.csv ?? "",
        headers: { "X-Library-Dry-Run": "1", "X-Library-Summary": asciiJson(result.summary) } };
    }
    if (!result.summary.complete && pass === "final") {
      await postAlert(env, `Библиотека A/B-тестов: окончательный проход за ${day} записан без данных CampaignsWell ` +
        "(колонки pLTV пустые). Следующий окончательный cron повторит его.", log, deps.fetchImpl);
    }
    return json(200, result.summary);
  } catch (error) {
    const errorId = randomUUID().slice(0, 8);
    log({ level: "error", msg: "Library run failed", errorId, error: safeMessage(error, secrets) });
    await postAlert(env, `Библиотека A/B-тестов: проход ${pass}${day ? ` за ${day}` : ""} не выполнен ` +
      `(errorId ${errorId}). Подробности — Vercel → Logs.`, log, deps.fetchImpl);
    return json(500, { error: "Library run failed; details are in the function logs", errorId });
  } finally {
    clearTimeout(timer);
  }
}
