import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleRun } from "../src/library/run.js";
import { configuredStore } from "../src/store/index.js";

/** Vercel Cron entry point: `GET /api/run?pass=early|final[&date=YYYY-MM-DD][&dryRun=1][&force=1]`. */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await handleRun({ headers: req.headers, query: req.query }, process.env,
    { store: () => configuredStore(process.env) });
  res.status(result.status).setHeader("Content-Type", result.contentType);
  res.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
  res.send(result.body);
}
