// UI-object tests: ACF post types, taxonomies and options pages
// (post_type_*.json / taxonomy_*.json / ui_options_page_*.json).
// Builds its own fixture, so it does not depend on an external corpus.
// Exits 0 on success.

import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { startHarness, assert } from "./harness.mjs";

const text = (res) => res?.result?.content?.[0]?.text ?? "";

// An acf-json dir holding only UI objects — no group_*.json at all. The theme
// that registers a CPT before it has any field group must still be discovered.
function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "acf-ui-"));
  const dir = join(tmp, "wp-content/themes/only/acf-json");
  mkdirSync(dir, { recursive: true });
  return { tmp, dir };
}

async function testCreateReadUpdateDelete() {
  const { tmp, dir } = fixture();
  const h = startHarness(tmp);
  h.call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ui", version: "0" } });
  h.call(2, "tools/call", {
    name: "acf_create_post_type",
    arguments: { title: "Projects", postType: "cpt_project", singular: "Project", plural: "Projects", hasArchive: true, archiveSlug: "projects" },
  });
  await h.wait();

  const ptKey = (text(h.get(2)).match(/post_type_[0-9a-f]{13}/) ?? [])[0];
  assert(Boolean(ptKey), `acf_create_post_type returned no key: ${text(h.get(2)).slice(0, 300)}`);
  const ptFile = join(dir, `${ptKey}.json`);
  assert(existsSync(ptFile), `post type file not written: ${ptFile}`);
  const pt = JSON.parse(readFileSync(ptFile, "utf8"));
  assert(pt.post_type === "cpt_project", `post_type key wrong: ${pt.post_type}`);
  assert(pt.labels.add_new_item === "Add New Project", `labels not generated: ${pt.labels.add_new_item}`);
  assert(pt.labels.not_found === "No projects found", `plural label wrong: ${pt.labels.not_found}`);
  assert(!("_kind" in pt) && !("_file" in pt), "synthetic keys leaked to disk");
  console.log(`acf_create_post_type: ${ptKey} written with generated labels OK`);

  // A taxonomy attaches to the post type just created; an options page nests
  // under it. Both go through the same index, so the key mint must not collide.
  h.call(3, "tools/call", {
    name: "acf_create_taxonomy",
    arguments: { title: "Sectors", taxonomy: "ct_sector", objectType: ["cpt_project"], singular: "Sector", plural: "Sectors", hierarchical: true },
  });
  h.call(4, "tools/call", {
    name: "acf_create_options_page",
    arguments: { title: "Projects Landing", parentSlug: "edit.php?post_type=cpt_project" },
  });
  await h.wait();

  const taxKey = (text(h.get(3)).match(/taxonomy_[0-9a-f]{13}/) ?? [])[0];
  const opKey = (text(h.get(4)).match(/ui_options_page_[0-9a-f]{13}/) ?? [])[0];
  assert(Boolean(taxKey), `acf_create_taxonomy returned no key: ${text(h.get(3)).slice(0, 300)}`);
  assert(Boolean(opKey), `acf_create_options_page returned no key: ${text(h.get(4)).slice(0, 300)}`);
  const tax = JSON.parse(readFileSync(join(dir, `${taxKey}.json`), "utf8"));
  assert(JSON.stringify(tax.object_type) === JSON.stringify(["cpt_project"]), `object_type wrong: ${JSON.stringify(tax.object_type)}`);
  assert(tax.hierarchical === true && !("popular_items" in tax.labels), "hierarchical taxonomy got the tag-style label set");
  const op = JSON.parse(readFileSync(join(dir, `${opKey}.json`), "utf8"));
  assert(op.menu_slug === "projects-landing", `menu_slug not derived from title: ${op.menu_slug}`);
  console.log(`acf_create_taxonomy + acf_create_options_page: ${taxKey}, ${opKey} OK`);

  h.call(5, "tools/call", { name: "acf_list_ui_objects", arguments: {} });
  h.call(6, "tools/call", { name: "acf_update_ui_object", arguments: { key: opKey, patch: { capability: "manage_options" } } });
  await h.wait();

  const listed = text(h.get(5));
  for (const k of [ptKey, taxKey, opKey]) assert(listed.includes(k), `acf_list_ui_objects missing ${k}`);
  const opAfter = JSON.parse(readFileSync(join(dir, `${opKey}.json`), "utf8"));
  assert(opAfter.key === opKey, "update changed the key");
  assert(opAfter.capability === "manage_options", `patch not applied: ${opAfter.capability}`);
  assert(opAfter.menu_slug === "projects-landing", "update dropped an untouched setting");
  console.log("acf_list_ui_objects + acf_update_ui_object: OK");

  h.call(7, "tools/call", { name: "acf_delete_ui_object", arguments: { key: taxKey, dryRun: true } });
  h.call(8, "tools/call", { name: "acf_delete_ui_object", arguments: { key: taxKey } });
  await h.wait();
  h.kill();

  assert(text(h.get(7)).startsWith("DRY RUN"), `dryRun delete not previewed: ${text(h.get(7)).slice(0, 200)}`);
  assert(!existsSync(join(dir, `${taxKey}.json`)), "taxonomy file still on disk after delete");
  console.log("acf_delete_ui_object: dry run kept the file, real run removed it OK");
  rmSync(tmp, { recursive: true, force: true });
}

async function testAcfKeyRulesAreEnforced() {
  const { tmp } = fixture();
  const h = startHarness(tmp);
  h.call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ui", version: "0" } });
  // ACF refuses each of these in its admin; the tool must refuse them too
  // rather than writing JSON that fails to register.
  h.call(2, "tools/call", { name: "acf_create_post_type", arguments: { title: "Order", postType: "order" } });
  h.call(3, "tools/call", { name: "acf_create_post_type", arguments: { title: "Long", postType: "a_very_long_post_type_key" } });
  h.call(4, "tools/call", { name: "acf_create_taxonomy", arguments: { title: "Bad", taxonomy: "Bad Slug", objectType: ["post"] } });
  await h.wait();
  h.kill();

  for (const [id, needle] of [[2, "reserved term"], [3, "under 20 characters"], [4, "lowercase alphanumerics"]]) {
    const res = h.get(id)?.result;
    assert(res?.isError === true, `expected isError for case ${id}: ${text(h.get(id)).slice(0, 200)}`);
    assert(text(h.get(id)).includes(needle), `expected "${needle}" for case ${id}, got: ${text(h.get(id)).slice(0, 200)}`);
  }
  console.log("ACF key rules (reserved term, length, charset) refused OK");
  rmSync(tmp, { recursive: true, force: true });
}

async function testValidateFlagsDuplicateMenuSlug() {
  const { tmp } = fixture();
  const h = startHarness(tmp);
  h.call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ui", version: "0" } });
  h.call(2, "tools/call", { name: "acf_create_options_page", arguments: { title: "Settings", menuSlug: "site-settings" } });
  await h.wait();
  // A second page with the same menu_slug is refused at create time, so the
  // clash is forced through acf_update_ui_object and caught by validation.
  h.call(3, "tools/call", { name: "acf_create_options_page", arguments: { title: "Settings Two", menuSlug: "site-settings-two" } });
  await h.wait();
  const secondKey = (text(h.get(3)).match(/ui_options_page_[0-9a-f]{13}/) ?? [])[0];
  assert(Boolean(secondKey), `second options page not created: ${text(h.get(3)).slice(0, 200)}`);
  h.call(4, "tools/call", { name: "acf_update_ui_object", arguments: { key: secondKey, patch: { menu_slug: "site-settings" } } });
  await h.wait();
  h.call(5, "tools/call", { name: "acf_validate", arguments: {} });
  await h.wait();
  h.kill();

  const findings = text(h.get(5));
  assert(findings.includes("[error]"), `expected an error finding, got: ${findings.slice(0, 300)}`);
  assert(/menu_slug .*site-settings.* is also used by/.test(findings), `duplicate menu_slug not reported: ${findings.slice(0, 300)}`);
  console.log("acf_validate: duplicate options-page menu_slug reported OK");
  rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  await testCreateReadUpdateDelete();
  await testAcfKeyRulesAreEnforced();
  await testValidateFlagsDuplicateMenuSlug();
  console.log("ALL UI-OBJECT TESTS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
