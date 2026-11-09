import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Store } from "../store/index.js";

export const CW_CREDENTIALS_KEY = "cw:credentials";
export const CW_REFRESH_LOCK_KEY = "cw:refresh-lock";
// CampaignsWell query_cmp_rows page limit since 2026-10-29.
export const CAMPAIGNSWELL_MAX_PAGE_SIZE = 200;

const REQUEST_TIMEOUT_MS = 60_000;
// The refresh lock lives 30 s; both refresh requests together must finish inside it.
const REFRESH_REQUEST_TIMEOUT_MS = 12_000;
const REFRESH_LOCK_TTL_SECONDS = 30;
const REFRESH_SKEW_MS = 30 * 60 * 1000;

function combinedSignal(...signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== null && signal !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

function boundedNetworkSignal(timeoutMs: number, ...signals: Array<AbortSignal | null | undefined>): AbortSignal {
  return AbortSignal.any([...signals.filter((signal): signal is AbortSignal => signal !== null && signal !== undefined),
    AbortSignal.timeout(timeoutMs)]);
}

/** Same shape as the credential entry written by `npm run cw:login`. */
export interface CampaignswellCredentialEntry {
  server_name: string;
  server_url: string;
  source?: string;
  created_at?: string;
  client_id?: string;
  access_token: string;
  expires_at?: number;
  refresh_token?: string;
  scopes?: string[];
}

export interface CwCredentialOptions {
  store: Store;
  /** Never refresh; an expired access token makes CW unavailable. */
  refreshDisabled: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  lockWaitMs?: number;
  lockPollMs?: number;
  signal?: AbortSignal;
}

interface ToolTextResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

export type CampaignswellReadErrorCategory = "transport" | "timeout" | "auth" | "validation" | "remote" | "malformed";

/** A stable, non-sensitive error for Campaignswell read operations. */
export class CampaignswellReadError extends Error {
  constructor(
    readonly category: CampaignswellReadErrorCategory,
    readonly retryable = false,
    readonly statusCode?: number
  ) {
    super(readErrorMessage(category));
    this.name = "CampaignswellReadError";
  }
}

/**
 * Converts untrusted MCP/transport details into a stable error without
 * retaining response text, tokens, or provider error bodies.
 */
export function toCampaignswellReadError(error: unknown): CampaignswellReadError {
  if (error instanceof CampaignswellReadError) return error;
  // The installed SDK keeps HTTP status in .code, not in the message. Its
  // authoritative status must win over arbitrary words in the response body.
  if (error instanceof StreamableHTTPError && typeof error.code === "number" && Number.isInteger(error.code)
    && error.code >= 400 && error.code <= 599) {
    const status = error.code;
    if (status === 401 || status === 403) return new CampaignswellReadError("auth", false, status);
    if (status === 400 || status === 404 || status === 422) return new CampaignswellReadError("validation", false, status);
    if (status === 408 || status === 504) return new CampaignswellReadError("timeout", true, status);
    return new CampaignswellReadError("remote", status === 429 || status >= 500, status);
  }
  const detail = error instanceof Error ? error.message : String(error);
  // Preserve only an explicitly labelled HTTP status, never the provider body.
  const status = /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s+code)?)\s*:?\s*([45]\d{2})\b/i.exec(detail);
  const statusCode = status ? Number(status[1]) : undefined;
  if (/(?:^|\D)-32602\b|invalid params?|validation/i.test(detail)) return new CampaignswellReadError("validation", false, statusCode);
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid token/i.test(detail)) return new CampaignswellReadError("auth", false, statusCode);
  if (/\b(?:408|504)\b|timed?\s*out|abort(?:ed)?/i.test(detail)) return new CampaignswellReadError("timeout", true, statusCode);
  if (/\b429\b|too many requests|rate limit(?:ed|ing)?/i.test(detail)) return new CampaignswellReadError("remote", true, statusCode);
  if (/\b5\d{2}\b|unavailable|gateway|temporar(?:y|ily)/i.test(detail)) return new CampaignswellReadError("remote", true, statusCode);
  if (/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b|network|socket|fetch failed|connection/i.test(detail)) {
    return new CampaignswellReadError("transport", true, statusCode);
  }
  return new CampaignswellReadError("remote", false, statusCode);
}

function readErrorMessage(category: CampaignswellReadErrorCategory): string {
  switch (category) {
    case "transport": return "CW transport failure.";
    case "timeout": return "CW request timed out.";
    case "auth": return "CW authentication failed.";
    case "validation": return "CW request validation failed.";
    case "malformed": return "CW returned invalid data.";
    case "remote": return "CW remote service failed.";
  }
}

export class CampaignswellMcpClient {
  constructor(
    private readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport,
    private readonly signal?: AbortSignal
  ) {}

  static async connect(options: CwCredentialOptions): Promise<CampaignswellMcpClient> {
    const { signal } = options;
    signal?.throwIfAborted();
    const entry = await readCampaignswellCredentials(options);
    try {
      return await connectWithEntry(entry, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!isUnauthorizedError(error) || entry.refresh_token === undefined || options.refreshDisabled) {
        throw error;
      }
      return connectWithEntry(await refreshCampaignswellCredentials(options, entry), signal);
    }
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  async getDefaultOrganizationId(signal?: AbortSignal): Promise<string> {
    const profile = await this.callJson<{ defaultOrganizationId: string }>("get_user_profile", {}, signal);
    return profile.defaultOrganizationId;
  }

  async callToolJson<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.callJson<T>(name, args, signal);
  }

  private async callJson<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (name === "query_cmp_rows" && typeof args.pageSize === "number" && args.pageSize > CAMPAIGNSWELL_MAX_PAGE_SIZE) {
      throw new CampaignswellReadError("validation");
    }
    let result: ToolTextResult;
    try {
      result = (await this.client.callTool({ name, arguments: args }, undefined, {
        signal: combinedSignal(this.signal, signal), timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS
      })) as ToolTextResult;
    } catch (error) {
      throw toCampaignswellReadError(error);
    }
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (result.isError === true) {
      // MCP error text is untrusted diagnostic data, never a JSON payload.
      throw toCampaignswellReadError(text ?? "MCP tool error");
    }
    if (typeof text !== "string") {
      throw new CampaignswellReadError("malformed");
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CampaignswellReadError("malformed");
    }
  }
}

async function connectWithEntry(entry: CampaignswellCredentialEntry, signal?: AbortSignal): Promise<CampaignswellMcpClient> {
  const client = new Client({ name: "ab-test-library", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(entry.server_url), {
    requestInit: { headers: { Authorization: `Bearer ${entry.access_token}` } },
    fetch: (input, init) => fetch(input, { ...init, signal: boundedNetworkSignal(REQUEST_TIMEOUT_MS, signal, init?.signal) })
  });
  try {
    await client.connect(transport, { signal, timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS });
    return new CampaignswellMcpClient(client, transport, signal);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

/** Accepts the entry itself or a whole token-store file (`{ "campaignswell": entry }`). */
export function parseCampaignswellCredentials(value: unknown): CampaignswellCredentialEntry {
  const object = (item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? item as Record<string, unknown> : undefined;
  const root = object(value);
  const candidates = root ? [root, object(root.campaignswell),
    ...Object.values(root).map(object).filter(item => item?.server_name === "campaignswell")] : [];
  const entry = candidates.find(item => typeof item?.server_url === "string" && typeof item.access_token === "string");
  if (!entry) throw new Error("CW credentials not found.");
  return entry as unknown as CampaignswellCredentialEntry;
}

export function shouldRefreshCampaignswellCredentials(entry: CampaignswellCredentialEntry, nowMs = Date.now()): boolean {
  return (
    entry.refresh_token !== undefined &&
    typeof entry.expires_at === "number" &&
    entry.expires_at - nowMs <= REFRESH_SKEW_MS
  );
}

export async function readCampaignswellCredentials(options: CwCredentialOptions): Promise<CampaignswellCredentialEntry> {
  const raw = await options.store.get<unknown>(CW_CREDENTIALS_KEY);
  if (raw === null) throw new Error("CW credentials not configured; run npm run cw:login");
  const entry = parseCampaignswellCredentials(raw);
  const nowMs = options.now?.() ?? Date.now();
  options.signal?.throwIfAborted();
  if (options.refreshDisabled) {
    if (typeof entry.expires_at === "number" && entry.expires_at <= nowMs) {
      throw new Error("CW access token expired and CW_REFRESH_DISABLED=true");
    }
    return entry;
  }
  if (shouldRefreshCampaignswellCredentials(entry, nowMs)) {
    try {
      return await refreshCampaignswellCredentials(options, entry);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (typeof entry.expires_at === "number" && entry.expires_at > nowMs) return entry;
      throw error;
    }
  }
  return entry;
}

interface OAuthServerMetadata {
  token_endpoint?: string;
}

interface RefreshTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_code?: string;
  error_description?: string;
  msg?: string;
}

/**
 * Rotates the refresh token under a store lock. Another invocation may have rotated it while this one
 * waited, so the entry is re-read after the lock is held; the new token is written with compare-and-set.
 */
export async function refreshCampaignswellCredentials(
  options: CwCredentialOptions,
  original: CampaignswellCredentialEntry
): Promise<CampaignswellCredentialEntry> {
  const { store, signal } = options;
  const now = options.now ?? Date.now;
  const owner = randomUUID();
  const deadline = Date.now() + (options.lockWaitMs ?? 30_000);
  while (!(await store.setIfAbsent(CW_REFRESH_LOCK_KEY, owner, REFRESH_LOCK_TTL_SECONDS))) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the CW credential refresh lock.");
    await delay(options.lockPollMs ?? 250, undefined, { signal });
  }
  try {
    const latestRaw = await store.get<unknown>(CW_CREDENTIALS_KEY);
    if (latestRaw === null) throw new Error("CW credentials not configured; run npm run cw:login");
    const latest = parseCampaignswellCredentials(latestRaw);
    if (
      original.refresh_token !== undefined &&
      latest.refresh_token !== original.refresh_token &&
      !shouldRefreshCampaignswellCredentials(latest, now())
    ) {
      return latest;
    }
    const refreshed = await requestRefresh(latest, options);
    // A fresh `cw:login` written meanwhile wins; this run still uses its own valid access token.
    await store.compareAndSet(CW_CREDENTIALS_KEY, latestRaw, refreshed);
    // A fully received rotation has already invalidated the old refresh token.
    // Persist it before propagating cancellation to the caller.
    signal?.throwIfAborted();
    return refreshed;
  } finally {
    await store.deleteIfValue(CW_REFRESH_LOCK_KEY, owner).catch(() => undefined);
  }
}

async function requestRefresh(entry: CampaignswellCredentialEntry, options: CwCredentialOptions): Promise<CampaignswellCredentialEntry> {
  if (entry.client_id === undefined || entry.refresh_token === undefined) {
    throw new Error("CW credentials cannot be refreshed: missing client_id or refresh_token.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const metadataSignal = boundedNetworkSignal(REFRESH_REQUEST_TIMEOUT_MS, options.signal);
  const metadataResponse = await fetchImpl(`${entry.server_url}/.well-known/oauth-authorization-server`, { signal: metadataSignal });
  metadataSignal.throwIfAborted();
  if (!metadataResponse.ok) {
    throw new Error(`CW OAuth metadata request failed with ${metadataResponse.status}.`);
  }
  const metadata = (await metadataResponse.json()) as OAuthServerMetadata;
  metadataSignal.throwIfAborted();
  if (typeof metadata.token_endpoint !== "string") {
    throw new Error("CW OAuth metadata did not include token_endpoint.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: entry.refresh_token,
    client_id: entry.client_id
  });
  const tokenResponse = await fetchImpl(metadata.token_endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: boundedNetworkSignal(REFRESH_REQUEST_TIMEOUT_MS, options.signal)
  });
  const tokenJson = (await tokenResponse.json()) as RefreshTokenResponse;
  if (!tokenResponse.ok || typeof tokenJson.access_token !== "string") {
    throw new Error(`CW OAuth refresh failed: ${formatRefreshError(tokenJson, tokenResponse.status)}.`);
  }
  if (typeof tokenJson.refresh_token !== "string") {
    throw new Error("CW OAuth refresh failed: token endpoint did not return a rotated refresh_token.");
  }
  const now = options.now?.() ?? Date.now();
  return {
    ...entry,
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token,
    expires_at: typeof tokenJson.expires_in === "number" ? now + tokenJson.expires_in * 1000 : entry.expires_at
  };
}

function formatRefreshError(tokenJson: RefreshTokenResponse, status: number): string {
  const code = tokenJson.error_code ?? tokenJson.error;
  const message = tokenJson.error_description ?? tokenJson.msg;
  if (code !== undefined && message !== undefined) return `${code}: ${message}`;
  return message ?? code ?? String(status);
}

function isUnauthorizedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("401") || error.message.toLowerCase().includes("invalid token"))
  );
}
