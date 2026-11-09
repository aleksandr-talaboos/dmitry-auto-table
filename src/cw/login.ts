import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Store } from "../store/index.js";
import { CW_CREDENTIALS_KEY, type CampaignswellCredentialEntry } from "./client.js";

const DEFAULT_SCOPE = "openid profile email phone";
const DEFAULT_LOGIN_TIMEOUT_MS = 900_000;

interface OAuthServerMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
}

interface ClientRegistrationResponse {
  client_id?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface AuthorizationUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
}

export function buildCampaignswellAuthorizationUrl(input: AuthorizationUrlInput): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", input.scope);
  return url.toString();
}

export function buildOpenBrowserCommand(url: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === "win32") return { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { file: "open", args: [url] };
  return { file: "xdg-open", args: [url] };
}

export function buildCampaignswellCredentialEntry(input: {
  serverUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  nowMs: number;
  scopes: string[];
}): CampaignswellCredentialEntry {
  return {
    server_name: "campaignswell",
    server_url: input.serverUrl,
    source: "ab-test-library-cw-login",
    created_at: new Date(input.nowMs).toISOString(),
    client_id: input.clientId,
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    ...(input.expiresIn === undefined ? {} : { expires_at: input.nowMs + input.expiresIn * 1000 }),
    scopes: input.scopes
  };
}

/** Interactive OAuth 2 login (PKCE, dynamic client registration, local callback); saves the tokens into the store. */
export async function runCampaignswellLogin(options: {
  store: Store;
  /** Printed after a successful login, e.g. "Upstash Redis" or ".state/ (local file)". */
  storeLabel?: string;
  serverUrl: string;
  scope?: string;
  timeoutMs?: number;
  openBrowser?: boolean;
  print?: (line: string) => void;
}): Promise<void> {
  const serverUrl = options.serverUrl.replace(/\/$/, "");
  requireHttps(serverUrl, "CW_SERVER_URL");
  const scope = options.scope ?? DEFAULT_SCOPE;
  const print = options.print ?? (line => console.log(line));
  const metadata = await fetchMetadata(serverUrl);
  const callback = await waitForOAuthCallback(options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  try {
    const clientId = await registerClient(metadata, callback.redirectUri, scope);
    const codeVerifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    callback.expectState(state);
    const authUrl = buildCampaignswellAuthorizationUrl({
      authorizationEndpoint: requireMetadata(metadata.authorization_endpoint, "authorization_endpoint"),
      clientId,
      redirectUri: callback.redirectUri,
      state,
      codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
      scope
    });

    print(`Open this CampaignsWell authorization URL if the browser does not open automatically:\n${authUrl}`);
    if (options.openBrowser !== false) await openBrowser(authUrl);
    const code = await callback.code(state);
    const token = await exchangeCode(metadata, { code, codeVerifier, clientId, redirectUri: callback.redirectUri });
    if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string") {
      throw new Error("CampaignsWell OAuth login did not return access_token and refresh_token.");
    }
    const entry = buildCampaignswellCredentialEntry({
      serverUrl,
      clientId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresIn: token.expires_in,
      nowMs: Date.now(),
      scopes: (token.scope ?? scope).split(/\s+/).filter(Boolean)
    });
    await options.store.set(CW_CREDENTIALS_KEY, entry);
    print(`CampaignsWell credentials saved to ${options.storeLabel ?? "the store"} (key ${CW_CREDENTIALS_KEY}).`);
  } finally {
    await callback.close();
  }
}

async function fetchMetadata(serverUrl: string): Promise<OAuthServerMetadata> {
  const response = await fetch(`${serverUrl}/.well-known/oauth-authorization-server`);
  if (!response.ok) {
    throw new Error(`CampaignsWell OAuth metadata request failed with ${response.status}.`);
  }
  return (await response.json()) as OAuthServerMetadata;
}

async function registerClient(metadata: OAuthServerMetadata, redirectUri: string, scope: string): Promise<string> {
  const registrationEndpoint = requireMetadata(metadata.registration_endpoint, "registration_endpoint");
  const response = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ab-test-library",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope
    })
  });
  const payload = (await response.json()) as ClientRegistrationResponse;
  if (!response.ok || typeof payload.client_id !== "string") {
    throw new Error(`CampaignsWell OAuth client registration failed with ${response.status}.`);
  }
  return payload.client_id;
}

async function exchangeCode(
  metadata: OAuthServerMetadata,
  input: { code: string; codeVerifier: string; clientId: string; redirectUri: string }
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    client_id: input.clientId,
    redirect_uri: input.redirectUri
  });
  const response = await fetch(requireMetadata(metadata.token_endpoint, "token_endpoint"), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = (await response.json()) as TokenResponse;
  if (!response.ok) {
    throw new Error(`CampaignsWell OAuth code exchange failed: ${payload.error_description ?? payload.error ?? response.status}.`);
  }
  return payload;
}

async function waitForOAuthCallback(timeoutMs: number): Promise<{
  redirectUri: string;
  expectState(state: string): void;
  code(expectedState: string): Promise<string>;
  close(): Promise<void>;
}> {
  let expected: string | null = null;
  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((error: Error) => void) | null = null;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    // A callback without our state is not ours (an old tab, another login, a forged link): ignore it and keep waiting.
    if (expected === null || state !== expected) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        .end("This callback does not belong to the current login and was ignored.");
      return;
    }
    if (error !== null) {
      rejectCode?.(new Error(`CampaignsWell OAuth returned ${error}.`));
      response.writeHead(400).end("Authorization failed. You can close this tab.");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("CampaignsWell authorization completed. You can close this tab.");
    resolveCode?.(`${state ?? ""}\n${code ?? ""}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not start local OAuth callback server.");
  }
  const timer = setTimeout(() => rejectCode?.(new Error("CampaignsWell OAuth login timed out.")), timeoutMs);
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    expectState(state: string): void { expected = state; },
    async code(expectedState: string): Promise<string> {
      const value = await codePromise;
      clearTimeout(timer);
      const [actualState, code] = value.split("\n");
      if (actualState !== expectedState) {
        throw new Error("CampaignsWell OAuth state mismatch.");
      }
      if (code === "") {
        throw new Error("CampaignsWell OAuth callback did not include a code.");
      }
      return code;
    },
    close: async () => {
      clearTimeout(timer);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

async function openBrowser(url: string): Promise<void> {
  const command = buildOpenBrowserCommand(url);
  await new Promise<void>((resolve) => {
    execFile(command.file, command.args, () => resolve());
  });
}

function requireMetadata(value: string | undefined, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`CampaignsWell OAuth metadata did not include ${name}.`);
  }
  requireHttps(value, name);
  return value;
}

function requireHttps(value: string, name: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} is not a valid URL.`); }
  if (url.protocol !== "https:") throw new Error(`${name} must be an https:// URL.`);
}
