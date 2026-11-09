import { describe, expect, it } from "vitest";
import { assertAllowedTab, parseLibraryConfig, parseServiceAccount } from "./config.js";

const binom = { BINOM_BASE_URL: "https://binom.example", BINOM_API_KEY: "k".repeat(20) };
const key = { type: "service_account", client_email: "bot@project.iam.gserviceaccount.com", private_key: "-----BEGIN-----" };

describe("library config", () => {
  it("uses the documented defaults for missing and empty settings", () => {
    const config = parseLibraryConfig({ ...binom, LIBRARY_MODE: "", LIBRARY_DAYS_CHUNK: "", CW_SERVER_URL: "" });
    expect(config).toMatchObject({ mode: "dry-run", from: "2026-06-01", requestBudget: 80, daysChunk: 4,
      aliases: { 14: "E011", 15: "E012", 16: "E014" }, sheetTitle: "Драфт отчета по всем тестам - авто (Vercel)",
      archive: false, registryTab: "Тесты", allowProtectedTab: false, cwServerUrl: "https://mcp.campaignswell.com",
      cwRefreshDisabled: false, overrides: {}, paidLagDays: { IQ: 10, Zodeya: 16, Subcaddy: 14, "34": 19 } });
    expect(config.spreadsheetId).toBeUndefined();
    expect(config.sheetGid).toBeUndefined();
    expect(parseLibraryConfig({ ...binom, LIBRARY_BASE_OFFER_OVERRIDES: "101:7, 202:9" }).overrides).toEqual({ 101: 7, 202: 9 });
    expect(() => parseLibraryConfig({ ...binom, LIBRARY_BASE_OFFER_OVERRIDES: "101" })).toThrow("LIBRARY_BASE_OFFER_OVERRIDES");
    expect(() => parseLibraryConfig({ BINOM_API_KEY: binom.BINOM_API_KEY })).toThrow("BINOM_BASE_URL");
    expect(() => parseLibraryConfig({ ...binom, BINOM_API_KEY: "short" })).toThrow("BINOM_API_KEY");
    expect(parseLibraryConfig({ LIBRARY_MODE: "off" }).mode).toBe("off");
  });
  it("refuses to write the protected production and hand-made tabs unless explicitly allowed", () => {
    for (const gid of [1514034458, 1991356788]) {
      expect(() => assertAllowedTab(gid, false)).toThrow("LIBRARY_ALLOW_PROTECTED_TAB");
      expect(() => assertAllowedTab(gid, true)).not.toThrow();
    }
    expect(() => assertAllowedTab(0, false)).not.toThrow();
    expect(parseLibraryConfig({ ...binom, LIBRARY_ALLOW_PROTECTED_TAB: "true" }).allowProtectedTab).toBe(true);
  });
  it("reads the service account as raw or base64 JSON and requires it with the spreadsheet in write mode", () => {
    const raw = JSON.stringify(key);
    expect(parseServiceAccount(raw)).toEqual(key);
    expect(parseServiceAccount(Buffer.from(raw).toString("base64"))).toEqual(key);
    expect(() => parseServiceAccount("bm90IGpzb24=")).toThrow("GOOGLE_SERVICE_ACCOUNT_JSON");
    expect(() => parseServiceAccount(JSON.stringify({ client_email: "x" }))).toThrow("GOOGLE_SERVICE_ACCOUNT_JSON");
    const write = { ...binom, LIBRARY_MODE: "write", LIBRARY_SPREADSHEET_ID: "sheet", GOOGLE_SERVICE_ACCOUNT_JSON: raw };
    expect(parseLibraryConfig(write).credentials).toEqual(key);
    for (const field of ["LIBRARY_SPREADSHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"]) {
      expect(() => parseLibraryConfig({ ...write, [field]: "" })).toThrow(field);
    }
  });
});
