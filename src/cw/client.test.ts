import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store/memory.js";
import { CW_CREDENTIALS_KEY, CW_REFRESH_LOCK_KEY, readCampaignswellCredentials, type CampaignswellCredentialEntry } from "./client.js";
import { fetchLibraryCw } from "./cw.js";

const NOW = Date.parse("2026-11-09T06:30:00Z");
const entry = (expiresInMs: number): CampaignswellCredentialEntry => ({ server_name: "campaignswell",
  server_url: "https://cw.example", client_id: "client", access_token: "access-1", refresh_token: "refresh-1",
  expires_at: NOW + expiresInMs });
function tokenServer() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return new Response(JSON.stringify({ token_endpoint: "https://cw.example/token" }));
    }
    expect(url).toBe("https://cw.example/token");
    expect(String(init?.body)).toContain("refresh_token=refresh-1");
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }));
  });
}

describe("CW credentials", () => {
  it("rotates a near-expiry token once across concurrent invocations and persists it", async () => {
    const store = new MemoryStore();
    await store.set(CW_CREDENTIALS_KEY, entry(10 * 60_000));
    const fetchImpl = tokenServer();
    const options = { store, refreshDisabled: false, fetchImpl, now: () => NOW, lockPollMs: 5 };
    const [first, second] = await Promise.all([readCampaignswellCredentials(options), readCampaignswellCredentials(options)]);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
    expect([first.access_token, second.access_token]).toEqual(["access-2", "access-2"]);
    expect(await store.get(CW_CREDENTIALS_KEY)).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2",
      expires_at: NOW + 3600_000, client_id: "client" });
    expect(await store.get(CW_REFRESH_LOCK_KEY)).toBeNull();
    // A token far from expiry is used as is.
    expect((await readCampaignswellCredentials(options)).access_token).toBe("access-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("never refreshes when disabled; an expired token makes CW unavailable", async () => {
    const store = new MemoryStore();
    const fetchImpl = tokenServer();
    await store.set(CW_CREDENTIALS_KEY, entry(10 * 60_000));
    const options = { store, refreshDisabled: true, fetchImpl, now: () => NOW };
    expect((await readCampaignswellCredentials(options)).access_token).toBe("access-1");
    await store.set(CW_CREDENTIALS_KEY, entry(-1));
    await expect(fetchLibraryCw(options, ["IQ"], "2026-06-01", "2026-11-08")).rejects.toThrow("expired");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await store.get(CW_CREDENTIALS_KEY)).toEqual(entry(-1));
  });
});
