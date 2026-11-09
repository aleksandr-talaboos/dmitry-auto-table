import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { runCampaignswellLogin } from "../cw/login.js";
import { configuredStore } from "../store/index.js";

// Usage: npm run cw:login [-- --local]. Saves the tokens to Upstash Redis (the store the Vercel function reads).
// --local writes them to .state/ instead, for local runs only: the deployed function will not see them.
dotenv.config({ quiet: true });
const { values } = parseArgs({ options: { local: { type: "boolean", default: false } } });
const redis = Boolean((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)
  && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN));
if (!redis && !values.local) {
  console.error("Redis is not configured: put UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and " +
    "KV_REST_API_TOKEN) into .env, e.g. with `vercel env pull .env`. Use --local to save the token to .state/ for local runs only.");
  process.exit(1);
}
const storeLabel = redis ? "Upstash Redis" : ".state/ (local file, not visible to Vercel)";
console.log(`CW token will be saved to: ${storeLabel}`);
await runCampaignswellLogin({ store: configuredStore(process.env, true), storeLabel,
  serverUrl: process.env.CW_SERVER_URL || "https://mcp.campaignswell.com" });
