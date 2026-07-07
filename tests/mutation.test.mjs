// Mutation dryRun test: acf_create_group dryRun + acf_outline. No disk writes.
// Exits 0 on success.

import { resolve } from "node:path";
import { startHarness, assert } from "./harness.mjs";

const CORPUS = resolve(process.env.HOME ?? "", "Documents/Sites/efront-boilerplate-wordpress-theme");

async function main() {
  const h = startHarness(CORPUS);

  h.call(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mut-test", version: "0.0.0" },
  });
  h.call(2, "tools/call", {
    name: "acf_create_group",
    arguments: { title: "Test Mut Group", active: true, dryRun: true },
  });
  h.call(3, "tools/call", { name: "acf_outline", arguments: {} });

  await h.wait();
  h.kill();

  const createText = h.get(2)?.result?.content?.[0]?.text ?? "";
  assert(createText.includes("DRY RUN") && createText.includes("Test Mut Group"), `acf_create_group dryRun wrong:\n${createText.slice(0, 400)}`);
  console.log("acf_create_group dryRun: OK");

  const outlineText = h.get(3)?.result?.content?.[0]?.text ?? "";
  assert(outlineText.length > 0 && outlineText.includes("group_"), `acf_outline wrong:\n${outlineText.slice(0, 400)}`);
  console.log(`acf_outline: ${outlineText.split("\n").length} lines OK`);

  console.log("ALL MUTATION (DRY-RUN) TESTS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });