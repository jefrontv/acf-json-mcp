// Write test: real acf_add_field against a temp copy of the efront corpus.
// Confirms disk write + modified stamp. Exits 0 on success.

import { join } from "node:path";
import { cpSync, mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { startHarness, assert, CORPUS } from "./harness.mjs";

const SRC = join(CORPUS, "acf-json");

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "acf-mcp-write-"));
  const destAcf = join(tmp, "acf-json");
  cpSync(SRC, destAcf, { recursive: true });

  const h = startHarness(tmp);

  h.call(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "write-test", version: "0.0.0" },
  });

  const firstGroup = readdirSync(destAcf).find((f) => /^group_.*\.json$/.test(f));
  if (!firstGroup) throw new Error("no group file in corpus");
  const groupKey = firstGroup.replace(/\.json$/, "");

  h.call(2, "tools/call", {
    name: "acf_add_field",
    arguments: {
      groupKey,
      field: { type: "text", name: "test_write_field", label: "Test Write Field" },
    },
  });

  await h.wait();
  h.kill();

  const addResult = h.get(2);
  const addText = addResult?.result?.content?.[0]?.text ?? "";
  if (addResult?.result?.isError) throw new Error(`acf_add_field error: ${addText}`);
  assert(addText.includes("Added field field_"), `acf_add_field text wrong:\n${addText.slice(0, 400)}`);

  const groupFile = join(destAcf, firstGroup);
  assert(existsSync(groupFile), `group file missing: ${groupFile}`);
  const content = readFileSync(groupFile, "utf8");
  assert(content.includes("test_write_field"), "new field NOT on disk");
  const parsed = JSON.parse(content);
  assert(typeof parsed["modified"] === "number", "modified not stamped");

  console.log(`acf_add_field: wrote field_ key to ${groupKey} on disk OK`);
  console.log(`modified=${parsed["modified"]} OK`);
  console.log("ALL WRITE TESTS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });