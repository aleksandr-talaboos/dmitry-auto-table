import { setTimeout as delay } from "node:timers/promises";
import { GoogleAuth } from "google-auth-library";

export type SheetValue = string | number | boolean | null;
/** Parsed Google service-account key file (see `parseServiceAccount` in config.ts). */
export type ServiceAccountKey = { client_email: string; private_key: string } & Record<string, unknown>;
export interface SheetsApi {
  getSpreadsheet(id: string): Promise<{ properties?: { locale?: string }; sheets?: Array<{ properties?: {
    sheetId?: number; title?: string; index?: number; gridProperties?: { rowCount?: number; columnCount?: number }
  }; basicFilter?: { range?: { startRowIndex?: number; endColumnIndex?: number };
    filterSpecs?: unknown[]; sortSpecs?: unknown[] } }> }>;
  batchGetValues(id: string, ranges: string[]): Promise<SheetValue[][][]>;
  batchUpdate(id: string, requests: unknown[]): Promise<{ replies?: unknown[] }>;
}

export function createSheetsApi(options: { credentials: ServiceAccountKey; fetchImpl?: typeof fetch }): SheetsApi {
  const auth = new GoogleAuth({ credentials: options.credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request<T>(endpoint: string, method = "GET", body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let token: string | null | undefined;
      try { token = await auth.getAccessToken(); } catch { throw new Error("Google Sheets authentication failed"); }
      if (!token) throw new Error("Google Sheets authentication returned no token");
      let response: Response;
      try {
        response = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets${endpoint}`, {
          method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000)
        });
      } catch { throw new Error("Google Sheets request failed or timed out"); }
      if (response.ok) {
        try { return await response.json() as T; }
        catch { throw new Error(`Google Sheets invalid JSON response: HTTP ${response.status}`); }
      }
      if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
        await response.body?.cancel();
        await delay(attempt === 0 ? 1000 : 2000);
        continue;
      }
      throw new Error(`Google Sheets request failed: HTTP ${response.status}`);
    }
  }
  const path = (id: string) => `/${encodeURIComponent(id)}`;
  return {
    getSpreadsheet: id => request(`${path(id)}?fields=properties.locale,sheets(properties,basicFilter)`),
    async batchGetValues(id, ranges) {
      const query = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE" });
      for (const range of ranges) query.append("ranges", range);
      const result = await request<{ valueRanges?: { values?: SheetValue[][] }[] }>(`${path(id)}/values:batchGet?${query}`);
      if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== ranges.length ||
        result.valueRanges.some(range => !range || (range.values !== undefined &&
          (!Array.isArray(range.values) || range.values.some(row => !Array.isArray(row)))))) {
        throw new Error("Incomplete Google Sheets values response; refusing replacement");
      }
      return result.valueRanges.map(range => range.values ?? []);
    },
    batchUpdate: (id, requests) => request(`${path(id)}:batchUpdate`, "POST", { requests })
  };
}
