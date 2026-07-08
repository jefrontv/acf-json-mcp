// Guard tests: (1) an ambiguous group key (same key in >1 acf-json dir) makes
// mutations FAIL instead of silently writing to one copy; (2) the server
// resolves the project root from CLAUDE_PROJECT_DIR when no ACF_JSON_PROJECT_ROOT
// is set. Exits 0 on success.

import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { startHarness, assert } from "./harness.mjs";

function group(key) {
  return JSON.stringify({ key, title: "Shared", fields: [], location: [], modified: 1 }, null, 4) + "\n";
}

async function testAmbiguousKeyIsRefused() {
  const tmp = mkdtempSync(join(tmpdir(), "acf-guard-ambig-"));
  const key = "group_dupe1234567";
  const files = [];
  for (const theme of ["themeA", "themeB"]) {
    const dir = join(tmp, "wp-content/themes", theme, "acf-json");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${key}.json`);
    writeFileSync(f, group(key));
    files.push(f);
  }

  const h = startHarness(tmp);
  h.call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "guard", version: "0" } });
  h.call(2, "tools/call", {
    name: "acf_add_field",
    arguments: { groupKey: key, field: { type: "text", name: "should_not_write", label: "X" } },
  });
  await h.wait();
  h.kill();

  const res = h.get(2)?.result;
  const text = res?.content?.[0]?.text ?? "";
  assert(res?.isError === true, `expected isError on ambiguous key, got: ${text.slice(0, 200)}`);
  assert(/ambiguous/i.test(text), `expected 'ambiguous' in error, got: ${text.slice(0, 200)}`);
  for (const f of files) {
    assert(!readFileSync(f, "utf8").includes("should_not_write"), `ambiguous mutation wrote to ${f}`);
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log("ambiguous-key mutation refused + no file mutated: OK");
}

async function testClaudeProjectDirResolution() {
  const tmp = mkdtempSync(join(tmpdir(), "acf-guard-cpd-"));
  const dir = join(tmp, "wp-content/themes/only/acf-json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "group_aaaaaaaaaaaaa.json"), group("group_aaaaaaaaaaaaa"));

  // No ACF_JSON_PROJECT_ROOT; only CLAUDE_PROJECT_DIR (as Claude Code injects).
  const h = startHarness(null, { env: { CLAUDE_PROJECT_DIR: tmp } });
  h.call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "guard", version: "0" } });
  h.call(2, "tools/call", { name: "acf_list_groups", arguments: {} });
  await h.wait();
  h.kill();

  const text = h.get(2)?.result?.content?.[0]?.text ?? "";
  assert(text.includes("group_aaaaaaaaaaaaa"), `CLAUDE_PROJECT_DIR not resolved; got: ${text.slice(0, 200)}`);
  rmSync(tmp, { recursive: true, force: true });
  console.log("CLAUDE_PROJECT_DIR project-root resolution: OK");
}

async function main() {
  await testAmbiguousKeyIsRefused();
  await testClaudeProjectDirResolution();
  console.log("ALL GUARD TESTS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
