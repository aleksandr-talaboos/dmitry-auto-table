import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { parseLibraryConfig } from "../config.js";
import { runLibrary, yesterdayUtc } from "../library/run.js";
import { configuredStore } from "../store/index.js";

// Usage: npm run run:local -- --date YYYY-MM-DD [--pass early|final] [--dry-run] [--force] [--csv out.csv]
dotenv.config({ quiet: true });
const { values } = parseArgs({ options: {
  date: { type: "string" }, pass: { type: "string", default: "final" }, "dry-run": { type: "boolean", default: false },
  force: { type: "boolean", default: false }, csv: { type: "string" }
} });
if (values.pass !== "early" && values.pass !== "final") throw new Error("--pass must be early or final");
const config = parseLibraryConfig(process.env);
const result = await runLibrary(config, { day: values.date ?? yesterdayUtc(), pass: values.pass,
  dryRun: values["dry-run"], force: values.force }, { store: configuredStore(process.env, true) });
if (result.status === "done" && result.csv !== undefined && values.csv) {
  await writeFile(values.csv, result.csv, { encoding: "utf8", mode: 0o600 });
}
if (result.status === "done") console.log(JSON.stringify({ ...result.summary, dryRun: result.dryRun,
  ...(values.csv && result.csv !== undefined ? { csv: values.csv } : {}) }, null, 2));
else console.log(JSON.stringify(result.status === "locked" ? { error: "Another library run is in progress" }
  : { skipped: result.reason, date: result.date, pass: result.pass }));
if (result.status === "locked") process.exitCode = 1;
