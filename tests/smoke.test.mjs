// Smoke test: list tools, acf_list_groups, acf_validate, acf_generate_key.
// Exits 0 on success.

import { resolve } from "node:path";
import { startHarness, assert } from "./harness.mjs";

const CORPUS = resolve(process.env.HOME ?? "", "Documents/Sites/efront-boilerplate-wordpress-theme");

async function main() {
  const h = startHarness(CORPUS);

  h.call(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  h.call(2, "tools/list", {});
  h.call(3, "tools/call", { name: "acf_list_groups", arguments: {} });
  h.call(4, "tools/call", { name: "acf_validate", arguments: {} });
  h.call(5, "tools/call", { name: "acf_generate_key", arguments: { prefix: "field" } });

  await h.wait();
  h.kill();

  const list = h.get(2);
  const toolNames = list?.result;
  const count = toolNames && typeof toolNames === "object" && "tools" in toolNames
    ? toolNames.tools.length
    : 0;
  assert(count === 22, `expected 22 tools, got ${count}`);
  console.log(`tools/list: ${count} tools OK`);

  const groupsText = h.get(3)?.result?.content?.[0]?.text ?? "";
  assert(groupsText.includes("group_"), `acf_list_groups missing group_: ${groupsText.slice(0, 200)}`);
  console.log(`acf_list_groups: ${groupsText.split("\n").length} lines OK`);

  const validateText = h.get(4)?.result?.content?.[0]?.text ?? "";
  assert(validateText.includes("[") || validateText.includes("No findings"), `acf_validate unexpected: ${validateText.slice(0, 200)}`);
  console.log(`acf_validate: ${validateText.split("\n")[0]} OK`);

  const keyText = h.get(5)?.result?.content?.[0]?.text ?? "";
  const keyLine = keyText.split("\n")[0] ?? "";
  assert(/^field_[0-9a-f]{13}$/.test(keyLine), `acf_generate_key bad key: ${keyLine}`);
  console.log(`acf_generate_key: ${keyLine} OK`);

  console.log("ALL SMOKE TESTS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });