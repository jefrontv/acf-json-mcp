// Run all tests in sequence. Exits 0 on success.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const tests = ["smoke.test.mjs", "mutation.test.mjs", "write.test.mjs", "guards.test.mjs"];
let failed = 0;

for (const t of tests) {
  const file = resolve(import.meta.dirname, t);
  console.log(`\n--- ${t} ---`);
  const r = spawnSync("node", [file], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`${t} FAILED (exit ${r.status})`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} test file(s) FAILED`);
  process.exit(1);
}
console.log("\nALL TEST FILES PASSED");