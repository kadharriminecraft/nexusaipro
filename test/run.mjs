/* Runs every Nexus test suite in order and exits non-zero if any fails.
   Run: node test/run.mjs  (or: npm test) */
import { spawnSync } from "node:child_process";

const suites = ["e2e.mjs", "resume.mjs", "app-status.mjs"];
let failed = 0;

for (const suite of suites) {
  console.log("\n=== " + suite + " ===");
  const r = spawnSync(process.execPath, [new URL(suite, import.meta.url).pathname], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

console.log("\n" + (failed ? failed + " suite(s) FAILED" : "all suites passed"));
process.exit(failed ? 1 : 0);
