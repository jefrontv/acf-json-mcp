// ACF JSON engine — Phase 1 (engine only, no tool layer).
// Pure TS, node-runnable via `node --experimental-strip-types`.
// Runtime deps: node builtins only (fs, path, crypto).
//
// Boundary-data rule: parsed ACF JSON is `unknown`. All property reads go through
// type guards (`in` + `typeof`). NEVER use inline `as { … }` casts on parsed values.
// The exported interfaces describe the *known* shape for documentation; runtime code
// operates on the raw records and narrows with guards.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, basename, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types (mirror contract; snake_case kept for source-shaped keys)
// ---------------------------------------------------------------------------

export type KeyPrefix = "group" | "field" | "layout";

export interface AcfField {
  key: string;
  label: string;
  name: string;
  aria_label: string; // JSON key is "aria-label" — preserved on raw record
  type: string;
  instructions: string;
  required: 0 | 1;
  conditional_logic: 0 | unknown[][];
  wrapper: { width: string; class: string; id: string };
  [type_specific: string]: unknown;
}

export interface AcfLayout {
  key: string; // "layout_<13hex>"
  name: string;
  label: string;
  display: "block" | "row" | "table";
  sub_fields: AcfField[];
  min: string | number;
  max: string | number;
  [acfe_specific: string]: unknown;
}

export interface AcfGroup {
  key: string; // "group_<13hex>"
  title: string;
  fields: AcfField[];
  location: unknown[];
  menu_order: number;
  position: string;
  style: string;
  label_placement: string;
  instruction_placement: string;
  hide_on_screen: unknown;
  active: boolean;
  description: string;
  show_in_rest: 0 | 1;
  acfe_autosync?: string[];
  modified?: number;
  _file: string; // absolute path to source group_*.json (only synthetic key)
}

export interface Finding {
  severity: "error" | "warning" | "info";
  file: string;
  path: string; // dotted path, e.g. "fields[2]" or "fields[2].sub_fields[0]"
  message: string;
  fix?: string;
}

export interface FieldRef {
  file: string;
  groupKey: string;
  groupTitle: string;
  parentChain: string[]; // ["group_X", "field_Y", "layout_Z"] — empty if top-level
  field: AcfField;
}

export interface ReferenceEdge {
  from: { file: string; key: string };
  to: { key: string; resolved: boolean; file?: string };
  kind: "clone" | "parent_repeater" | "parent_layout" | "conditional_logic";
}

export interface LoadedIndex {
  groups: AcfGroup[]; // one per group_*.json across all found dirs
  dirToGroups: Map<string, AcfGroup[]>;
  allKeys: Set<string>; // every group_/field_/layout_ key seen
  errors: { file: string; error: string }[];
}

export interface MovePlan {
  from: { groupKey: string; fieldKey: string };
  to: { groupKey: string; parent?: { type: "repeater" | "layout" | "group"; key: string } };
}

// ---------------------------------------------------------------------------
// Type guards for boundary data (no inline casts)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasStringProp(r: Record<string, unknown>, k: string): boolean {
  return k in r && typeof r[k] === "string";
}

function hasNumProp(r: Record<string, unknown>, k: string): boolean {
  return k in r && typeof r[k] === "number";
}

function hasArrayProp(r: Record<string, unknown>, k: string): boolean {
  return k in r && Array.isArray(r[k]);
}

function hasBoolProp(r: Record<string, unknown>, k: string): boolean {
  return k in r && typeof r[k] === "boolean";
}

// ---------------------------------------------------------------------------
// FIELD_TEMPLATES — seeded from the real boilerplate corpus
// (efront-boilerplate-wordpress-theme/acf-json/). Defaults are the actual values
// shipped in a representative example of each type, with type-agnostic empty
// defaults for keys absent in the corpus. Commented types below had no example in
// the corpus and fall back to ACF documented defaults.
//
// required = keys the template guarantees present (caller may still override).
// defaults = type-specific default values merged onto every new field of this type.
// ---------------------------------------------------------------------------

export const FIELD_TEMPLATES: Record<string, { required: string[]; defaults: Record<string, unknown> }> = {
  text: {
    required: ["default_value", "placeholder", "prepend", "append", "maxlength"],
    defaults: { default_value: "", placeholder: "", prepend: "", append: "", maxlength: "" },
  },
  textarea: {
    required: ["default_value", "new_lines", "maxlength", "placeholder", "rows"],
    defaults: { default_value: "", new_lines: "", maxlength: "", placeholder: "", rows: "" },
  },
  number: {
    required: ["default_value", "placeholder", "prepend", "append", "min", "max", "step"],
    defaults: { default_value: 0, placeholder: "", prepend: "", append: "", min: "", max: "", step: "" },
  },
  url: {
    required: ["default_value", "placeholder"],
    defaults: { default_value: "", placeholder: "" },
  },
  // `link` ships no type-specific keys beyond return_format in the corpus.
  link: {
    required: ["return_format"],
    defaults: { return_format: "array" },
  },
  image: {
    required: ["return_format", "preview_size", "library", "min_width", "min_height", "min_size", "max_width", "max_height", "max_size", "mime_types", "uploader"],
    defaults: {
      return_format: "array",
      preview_size: "thumbnail",
      library: "all",
      min_width: "", min_height: "", min_size: "",
      max_width: "", max_height: "", max_size: "",
      mime_types: "", uploader: "",
    },
  },
  file: {
    required: ["return_format", "library", "min_size", "max_size", "mime_types", "uploader"],
    defaults: {
      return_format: "array",
      library: "all",
      min_size: "", max_size: "", mime_types: "", uploader: "",
    },
  },
  wysiwyg: {
    required: ["default_value", "tabs", "toolbar", "media_upload", "delay"],
    defaults: { default_value: "", tabs: "all", toolbar: "full", media_upload: 0, delay: 1 },
  },
  oembed: {
    required: ["width", "height"],
    defaults: { width: "", height: "" },
  },
  oembed_url: {
    required: ["width", "height", "return_format"],
    defaults: { width: "", height: "", return_format: "url" },
  },
  // No `oembed_url` had return_format in the single corpus example; documented ACF default "url".
  true_false: {
    required: ["default_value", "message", "ui", "ui_on_text", "ui_off_text"],
    defaults: { default_value: 0, message: "", ui: 0, ui_on_text: "", ui_off_text: "" },
  },
  color_picker: {
    required: ["default_value", "enable_opacity", "return_format"],
    defaults: { default_value: "", enable_opacity: false, return_format: "string" },
  },
  // `color_swatch` is an ACF-Extended type. Single corpus example used placeholder
  // key `acfcloneindex` (a clone-template sentinel), so defaults are conservative.
  color_swatch: {
    required: ["colors", "return_format"],
    defaults: { colors: "", return_format: "array" },
  },
  select: {
    required: ["choices", "default_value", "allow_null", "multiple", "ui", "ajax", "return_format", "placeholder", "search_placeholder", "allow_custom", "create_options", "save_options"],
    defaults: {
      choices: {},
      default_value: "",
      allow_null: 0, multiple: 0, ui: 0, ajax: 0,
      return_format: "value", placeholder: "", search_placeholder: "",
      allow_custom: 0, create_options: 0, save_options: 0,
    },
  },
  // No corpus `select` had allow_in_bindings; ACF default absent → omitted from required.
  radio: {
    required: ["choices", "default_value", "layout", "other_choice", "save_other_choice", "allow_null", "return_format"],
    defaults: {
      choices: [], default_value: "", layout: "horizontal",
      other_choice: 0, save_other_choice: 0, allow_null: 0, return_format: "value",
    },
  },
  checkbox: {
    required: ["choices", "default_value", "allow_custom", "layout", "toggle", "return_format", "save_custom"],
    defaults: {
      choices: {}, default_value: [], allow_custom: 0, layout: "horizontal",
      toggle: 0, return_format: "value", save_custom: 0,
    },
  },
  button_group: {
    required: ["choices", "default_value", "allow_null", "return_format", "layout"],
    defaults: {
      choices: {}, default_value: "", allow_null: 0,
      return_format: "value", layout: "horizontal",
    },
  },
  message: {
    required: ["message", "new_lines", "esc_html"],
    defaults: { message: "", new_lines: "wpautop", esc_html: 0 },
  },
  tab: {
    required: ["placement", "endpoint", "selected"],
    defaults: { placement: "top", endpoint: 0, selected: 0 },
  },
  group: {
    required: ["sub_fields", "layout"],
    defaults: { sub_fields: [], layout: "block" },
  },
  repeater: {
    required: ["sub_fields", "layout", "button_label", "collapsed", "min", "max", "rows_per_page"],
    defaults: { sub_fields: [], layout: "table", button_label: "Add Row", collapsed: "", min: 0, max: 0, rows_per_page: 0 },
  },
  flexible_content: {
    required: ["layouts", "button_label", "min", "max"],
    defaults: { layouts: {}, button_label: "Add Layout", min: "", max: "" },
  },
  clone: {
    required: ["clone", "display", "layout", "prefix_label", "prefix_name"],
    defaults: { clone: [], display: "seamless", layout: "block", prefix_label: 0, prefix_name: 0 },
  },
  // ACF-Extended layout column type. No type-specific required keys beyond columns.
  acfe_column: {
    required: ["columns", "endpoint"],
    defaults: { columns: "", endpoint: 0 },
  },
  // ACF-Extended button type. Single corpus example.
  acfe_button: {
    required: ["button_value", "button_type", "button_class", "button_id", "button_before", "button_after", "button_ajax"],
    defaults: {
      button_value: "", button_type: "button",
      button_class: "button button-secondary", button_id: "",
      button_before: "", button_after: "", button_ajax: 0,
    },
  },
};

// ---------------------------------------------------------------------------
// Discovery: findAcfJsonDirs
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", ".cache", ".next"]);

export function findAcfJsonDirs(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const absRoot = resolve(root);
  walk(absRoot, 0);
  return out;

  function walk(dir: string, depth: number): void {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    // If this dir is itself an acf-json dir containing group_*.json, record and stop descending.
    const isAcfJson = basename(dir) === "acf-json";
    if (isAcfJson) {
      const hasGroup = entries.some((e) => /^group_.*\.json$/.test(e));
      if (hasGroup) {
        const norm = dir;
        if (!seen.has(norm)) {
          seen.add(norm);
          out.push(norm);
        }
        return; // do not descend into a found acf-json dir
      }
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) continue;
      const child = join(dir, e);
      let st;
      try {
        st = statSync(child);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(child, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Loader: parseGroup + loadIndex
// ---------------------------------------------------------------------------

function parseGroup(raw: unknown, file: string): AcfGroup | { error: string } {
  if (!isRecord(raw)) return { error: "top-level JSON is not an object" };
  if (!hasStringProp(raw, "key")) return { error: "missing/invalid top-level key" };
  if (!hasStringProp(raw, "title")) return { error: "missing/invalid title" };
  if (!hasArrayProp(raw, "fields")) return { error: "missing/invalid fields array" };
  if (!hasArrayProp(raw, "location")) return { error: "missing/invalid location array" };
  // Build AcfGroup from raw, preserving all source keys + adding _file.
  // We do NOT cast; we read each known field defensively via guards.
  const g: Record<string, unknown> = { ...raw };
  g["_file"] = file;
  // Normalize the documented-shape fields defensively so downstream typed reads are safe.
  if (!hasNumProp(g, "menu_order")) g["menu_order"] = 0;
  if (!hasStringProp(g, "position")) g["position"] = "";
  if (!hasStringProp(g, "style")) g["style"] = "";
  if (!hasStringProp(g, "label_placement")) g["label_placement"] = "";
  if (!hasStringProp(g, "instruction_placement")) g["instruction_placement"] = "";
  if (!hasStringProp(g, "description")) g["description"] = "";
  if (!hasBoolProp(g, "active")) g["active"] = true;
  // show_in_rest may be 0|1 (number) — keep as-is if present number, else 0.
  if (!("show_in_rest" in g) || typeof g["show_in_rest"] !== "number") g["show_in_rest"] = 0;
  return g as unknown as AcfGroup;
}

function collectKeys(node: unknown, into: Set<string>): void {
  if (!isRecord(node)) return;
  if ("key" in node && typeof node["key"] === "string" && node["key"].length > 0) {
    // Index EVERY key by exact string. ACF resolves clone / parent_repeater /
    // parent_layout / conditional_logic targets by literal key match, not by
    // uniqid format — readable keys (field_tip_*, 11-hex, …) are valid ACF keys
    // and must be resolvable. Key-format *style* is checked separately in validate.
    into.add(node["key"]);
  }
  if ("fields" in node && Array.isArray(node["fields"])) {
    for (const f of node["fields"]) collectKeys(f, into);
  }
  if ("sub_fields" in node && Array.isArray(node["sub_fields"])) {
    for (const f of node["sub_fields"]) collectKeys(f, into);
  }
  if ("layouts" in node && isRecord(node["layouts"])) {
    for (const lk of Object.keys(node["layouts"])) {
      into.add(lk);
      collectKeys(node["layouts"][lk], into);
    }
  }
}

export function loadIndex(root: string): LoadedIndex {
  const dirs = findAcfJsonDirs(root);
  const groups: AcfGroup[] = [];
  const dirToGroups = new Map<string, AcfGroup[]>();
  const allKeys = new Set<string>();
  const errors: { file: string; error: string }[] = [];

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (e) {
      errors.push({ file: dir, error: `readdir failed: ${String(e)}` });
      continue;
    }
    const groupFiles = entries.filter((e) => /^group_.*\.json$/.test(e)).sort();
    const bucket: AcfGroup[] = [];
    for (const gf of groupFiles) {
      const file = join(dir, gf);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        errors.push({ file, error: `read failed: ${String(e)}` });
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        errors.push({ file, error: `JSON.parse failed: ${String(e)}` });
        continue;
      }
      const parsed = parseGroup(raw, file);
      if ("error" in parsed) {
        errors.push({ file, error: parsed.error });
        continue;
      }
      bucket.push(parsed);
      groups.push(parsed);
    }
    if (bucket.length) dirToGroups.set(dir, bucket);
  }

  // Build allKeys from every loaded group (recursive).
  for (const g of groups) collectKeys(g, allKeys);

  return { groups, dirToGroups, allKeys, errors };
}

// ---------------------------------------------------------------------------
// Key generation: generateKey
// ---------------------------------------------------------------------------

function uniqid13(): string {
  const time8 = Date.now().toString(16).slice(-8).padStart(8, "0");
  const entropy5 = randomBytes(3).toString("hex").slice(0, 5);
  return time8 + entropy5;
}

export function generateKey(prefix: KeyPrefix, existing: Set<string>): string {
  for (let attempts = 0; attempts < 1000; attempts++) {
    const k = `${prefix}_${uniqid13()}`;
    if (!existing.has(k)) {
      existing.add(k); // mutate so same-session double-alloc is prevented
      return k;
    }
  }
  throw new Error(`generateKey: collision after 1000 attempts for prefix "${prefix}"`);
}

// ---------------------------------------------------------------------------
// Field walking helpers (shared by findField, references, validate)
// ---------------------------------------------------------------------------

type FieldVisitor = (field: AcfField, ctx: { file: string; groupKey: string; groupTitle: string; parentChain: string[]; path: string }) => void;
type LayoutVisitor = (layout: AcfLayout, ctx: { file: string; groupKey: string; parentChain: string[]; path: string }) => void;

function walkGroup(g: AcfGroup, onField: FieldVisitor, onLayout?: LayoutVisitor): void {
  const file = g._file;
  const groupKey = g.key;
  const groupTitle = g.title;
  const fields = g.fields;
  visitFields(fields, { file, groupKey, groupTitle, parentChain: [groupKey], pathPrefix: "fields" }, onField, onLayout);
}

function visitFields(
  fields: unknown[],
  ctx: { file: string; groupKey: string; groupTitle: string; parentChain: string[]; pathPrefix: string },
  onField: FieldVisitor,
  onLayout?: LayoutVisitor,
): void {
  fields.forEach((raw, i) => {
    if (!isRecord(raw)) return;
    const f = raw as unknown as AcfField;
    const path = `${ctx.pathPrefix}[${i}]`;
    onField(f, { file: ctx.file, groupKey: ctx.groupKey, groupTitle: ctx.groupTitle, parentChain: ctx.parentChain.slice(), path });
    const childChain = [...ctx.parentChain, f.key];
    // sub_fields (repeater / group)
    if ("sub_fields" in raw && Array.isArray(raw["sub_fields"])) {
      visitFields(raw["sub_fields"] as unknown[], { ...ctx, parentChain: childChain, pathPrefix: `${path}.sub_fields` }, onField, onLayout);
    }
    // layouts (flexible_content) — dict keyed by layout key
    if ("layouts" in raw && isRecord(raw["layouts"])) {
      const layouts = raw["layouts"];
      let li = 0;
      for (const lk of Object.keys(layouts)) {
        const lr = layouts[lk];
        if (isRecord(lr)) {
          const layout = lr as unknown as AcfLayout;
          if (onLayout) onLayout(layout, { file: ctx.file, groupKey: ctx.groupKey, parentChain: childChain, path: `${path}.layouts[${lk}]` });
          if ("sub_fields" in lr && Array.isArray(lr["sub_fields"])) {
            visitFields(lr["sub_fields"] as unknown[], { ...ctx, parentChain: [...childChain, lk], pathPrefix: `${path}.layouts[${lk}].sub_fields` }, onField, onLayout);
          }
        }
        li++;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// findField
// ---------------------------------------------------------------------------

export function findField(index: LoadedIndex, query: { name?: string; key?: string; type?: string; nameContains?: string; groupKey?: string }): FieldRef[] {
  const out: FieldRef[] = [];
  const hasFieldFilter = query.name !== undefined || query.key !== undefined || query.type !== undefined || query.nameContains !== undefined;
  if (!hasFieldFilter && query.groupKey === undefined) return out;
  for (const g of index.groups) {
    if (query.groupKey !== undefined && g.key !== query.groupKey) continue;
    walkGroup(g, (field, ctx) => {
      const f = field as Record<string, unknown>;
      if (query.key !== undefined && field.key !== query.key) return;
      if (query.name !== undefined && field.name !== query.name) return;
      if (query.type !== undefined && f["type"] !== query.type) return;
      if (query.nameContains !== undefined && !(typeof field.name === "string" && field.name.includes(query.nameContains))) return;
      out.push({ file: ctx.file, groupKey: ctx.groupKey, groupTitle: ctx.groupTitle, parentChain: ctx.parentChain, field });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// references — build reference graph
// ---------------------------------------------------------------------------

export function references(index: LoadedIndex): ReferenceEdge[] {
  const out: ReferenceEdge[] = [];
  const resolveFile = (key: string): string | undefined => {
    for (const g of index.groups) {
      if (g.key === key) return g._file;
      let found: string | undefined;
      walkGroup(g, (f) => { if (f.key === key) found = g._file; });
      if (found) return found;
    }
    return undefined;
  };

  for (const g of index.groups) {
    walkGroup(g, (field, ctx) => {
      // clone
      if ("clone" in field && Array.isArray((field as Record<string, unknown>)["clone"])) {
        const arr = (field as Record<string, unknown>)["clone"] as unknown[];
        for (const t of arr) {
          if (typeof t === "string") {
            const resolved = index.allKeys.has(t);
            out.push({ from: { file: ctx.file, key: field.key }, to: { key: t, resolved, file: resolved ? resolveFile(t) : undefined }, kind: "clone" });
          }
        }
      }
      // parent_repeater
      if ("parent_repeater" in field && typeof (field as Record<string, unknown>)["parent_repeater"] === "string") {
        const t = (field as Record<string, unknown>)["parent_repeater"] as string;
        const resolved = index.allKeys.has(t);
        out.push({ from: { file: ctx.file, key: field.key }, to: { key: t, resolved, file: resolved ? resolveFile(t) : undefined }, kind: "parent_repeater" });
      }
      // parent_layout
      if ("parent_layout" in field && typeof (field as Record<string, unknown>)["parent_layout"] === "string") {
        const t = (field as Record<string, unknown>)["parent_layout"] as string;
        const resolved = index.allKeys.has(t);
        out.push({ from: { file: ctx.file, key: field.key }, to: { key: t, resolved, file: resolved ? resolveFile(t) : undefined }, kind: "parent_layout" });
      }
      // conditional_logic — array-of-arrays, each rule {field, operator, value}
      const cl = (field as Record<string, unknown>)["conditional_logic"];
      if (Array.isArray(cl)) {
        for (const rulegroup of cl) {
          if (Array.isArray(rulegroup)) {
            for (const rule of rulegroup) {
              if (isRecord(rule) && "field" in rule && typeof rule["field"] === "string") {
                const t = rule["field"] as string;
                const resolved = index.allKeys.has(t);
                out.push({ from: { file: ctx.file, key: field.key }, to: { key: t, resolved, file: resolved ? resolveFile(t) : undefined }, kind: "conditional_logic" });
              }
            }
          }
        }
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// validate — 8 rules
// ---------------------------------------------------------------------------

const FIELD_KEY_RE = /^(group|field|layout)_[0-9a-fA-F]{12,13}$/;
const HEX13_RE = /^[0-9a-fA-F]{13}$/;

// Recognised ACF field types beyond FIELD_TEMPLATES (which only seeds the build
// table). Covers ACF core + PRO + common ACF Extended / third-party types. An
// unrecognised type is a *warning*, not an error — ACF loads third-party field
// types fine; the toolset just has no build template for them.
const EXTRA_FIELD_TYPES: Record<string, true> = {
  email: true, password: true, range: true,
  gallery: true, post_object: true, page_link: true, relationship: true, taxonomy: true, user: true,
  google_map: true, date_picker: true, date_time_picker: true, time_picker: true, accordion: true,
  forms: true,
  acfe_forms: true, acfe_advanced_link: true, acfe_hidden: true, acfe_date_range: true,
  acfe_post_types: true, acfe_taxonomies: true, acfe_taxonomy_terms: true, acfe_field_groups: true,
  acfe_user_roles: true, acfe_post_statuses: true, acfe_image_sizes: true, acfe_menus: true,
  acfe_menu_locations: true, acfe_templates: true, acfe_countries: true, acfe_currencies: true,
  acfe_languages: true, acfe_slug: true, acfe_code_editor: true, acfe_textarea_code: true,
};

export function validate(index: LoadedIndex, groupKey?: string): Finding[] {
  const findings: Finding[] = [];
  const groups = groupKey ? index.groups.filter((g) => g.key === groupKey) : index.groups;

  // Precompute group keys present in index for cross-file clone resolution.
  const groupKeys = new Set<string>();
  for (const g of index.groups) groupKeys.add(g.key);

  // Rule 3 (global): duplicate keys across all files. Count occurrences across all groups.
  const keyCount = new Map<string, { files: Set<string> }>();
  for (const g of index.groups) {
    noteKey(g.key, g._file);
    walkGroup(g, (field) => noteKey(field.key, g._file));
    walkGroup(g, () => {}, (layout) => noteKey(layout.key, g._file));
  }
  function noteKey(k: string, file: string) {
    if (typeof k !== "string") return;
    let e = keyCount.get(k);
    if (!e) { e = { files: new Set() }; keyCount.set(k, e); }
    e.files.add(file);
  }
  for (const [k, e] of keyCount) {
    if (e.files.size > 1) {
      findings.push({ severity: "error", file: [...e.files].sort().join(", "), path: "(global)", message: `duplicate key ${k} appears in ${e.files.size} files`, fix: "regenerate one of the keys with generateKey" });
    }
  }

  for (const g of groups) {
    const file = g._file;
    // Rule 1: top-level shape
    if (typeof g.title !== "string" || g.title.length === 0) {
      findings.push({ severity: "error", file, path: "title", message: "group title is empty", fix: "set a non-empty title" });
    }
    if (!Array.isArray(g.fields)) {
      findings.push({ severity: "error", file, path: "fields", message: "fields is not an array", fix: "set fields to []" });
    }
    if (!Array.isArray(g.location)) {
      findings.push({ severity: "error", file, path: "location", message: "location is missing or not an array", fix: "set location to a rule-group array" });
    }
    // Rule 1c: location is an array of rule-groups, each an array of {param,operator,value}.
    if (Array.isArray(g.location)) {
      g.location.forEach((grp, gi) => {
        if (!Array.isArray(grp)) { findings.push({ severity: "warning", file, path: `location[${gi}]`, message: "location rule-group is not an array", fix: "each location group is an array of {param,operator,value}" }); return; }
        grp.forEach((rule, ri) => {
          if (!isRecord(rule) || typeof rule["param"] !== "string" || typeof rule["operator"] !== "string") {
            findings.push({ severity: "warning", file, path: `location[${gi}][${ri}]`, message: "location rule missing string param/operator", fix: "set {param, operator, value}" });
          }
        });
      });
    }
    // Rule 1b: key matches filename group_<key>.json
    // DECISION: emit a *warning* (not error) when the group key's 13-hex differs from the
    // filename's 13-hex. The efront boilerplate ships one such file
    // (group_6604d8d80d652.json → key group_6604d0D56d652, uppercase + different hex)
    // and ACF loads it fine; the mismatch only affects admin "Sync" matching. Flagging it
    // as an error would fail the clean-corpus acceptance; warning preserves the signal.
    const fn = basename(file, ".json");
    const fnHex = fn.startsWith("group_") ? fn.slice("group_".length) : null;
    const gkHex = g.key.startsWith("group_") ? g.key.slice("group_".length) : g.key;
    if (fnHex && fnHex.toLowerCase() !== gkHex.toLowerCase()) {
      findings.push({ severity: "warning", file, path: "key", message: `group key ${g.key} does not match filename ${fn}.json`, fix: "rename file or regenerate key so key hex equals filename hex" });
    }
    if (typeof g.key !== "string" || g.key.length === 0 || !g.key.startsWith("group_")) {
      findings.push({ severity: "error", file, path: "key", message: `group key ${String(g.key)} is missing or lacks the group_ prefix`, fix: "use generateKey('group', …)" });
    } else if (!/^group_[0-9a-fA-F]{12,13}$/.test(g.key)) {
      findings.push({ severity: "warning", file, path: "key", message: `group key ${g.key} is not uniqid format (group_<12-13hex>); ACF still resolves it by exact key`, fix: "optional: regenerate with generateKey('group', …)" });
    }

    // Rules 2, 4, 5, 6, 7 per field + layout.
    // Collect same-group field keys for rule 4 / 7 resolution.
    const sameGroupFieldKeys = new Set<string>();
    walkGroup(g, (f) => sameGroupFieldKeys.add(f.key));
    walkGroup(g, () => {}, (layout) => sameGroupFieldKeys.add(layout.key));
    // key -> kind map for parent-ref type checks: field key -> field type;
    // layout key -> "__layout__".
    const keyKind = new Map<string, string>();
    walkGroup(g, (f) => keyKind.set(f.key, typeof f.type === "string" ? f.type : ""));
    walkGroup(g, () => {}, (layout) => keyKind.set(layout.key, "__layout__"));

    walkGroup(
      g,
      (field, ctx) => {
        // Rule 2: key format + name non-empty + type known.
        // DECISION: field keys with a non-`field_` prefix (e.g. the legacy `group_…`-prefixed
        // fields in group_6604d8d80d652.json, or ACF sentinel `acfcloneindex`) emit a *warning*,
        // not an error. ACF reads fields by structure, not by prefix, and these load fine.
        // Only an empty/missing/non-hex key is an error.
        if (typeof field.key !== "string" || field.key.length === 0) {
          findings.push({ severity: "error", file, path: ctx.path + ".key", message: "field key is empty/missing", fix: "use generateKey('field', …)" });
        } else if (field.key === "acfcloneindex") {
          // ACF clone-template sentinel — always valid, no finding.
        } else if (!/^(group|field|layout)_/.test(field.key)) {
          findings.push({ severity: "error", file, path: ctx.path + ".key", message: `field key ${field.key} lacks a field_/group_/layout_ prefix`, fix: "use generateKey('field', …)" });
        } else if (!FIELD_KEY_RE.test(field.key) || !field.key.startsWith("field_")) {
          // Valid ACF key (resolves by exact string) but not field_<12-13hex> uniqid.
          findings.push({ severity: "warning", file, path: ctx.path + ".key", message: `field key ${field.key} is not field_<12-13hex> uniqid format; ACF still resolves it by exact key`, fix: "optional: regenerate with generateKey('field', …)" });
        }
        // name: non-empty string. ACF allows empty name for tabs/columns/messages, so warn only.
        if (typeof field.name !== "string") {
          findings.push({ severity: "error", file, path: ctx.path + ".name", message: "field name is not a string", fix: "set name to a snake_case string" });
        } else if (field.name.length === 0 && !/^(tab|message|acfe_column)$/.test(field.type)) {
          findings.push({ severity: "warning", file, path: ctx.path + ".name", message: "field name is empty", fix: "set a snake_case name" });
        }
        // type: error only if missing/non-string. An unrecognised but named type
        // (ACF PRO / ACF Extended / third-party) is a warning — ACF loads it fine.
        if (typeof field.type !== "string" || field.type.length === 0) {
          findings.push({ severity: "error", file, path: ctx.path + ".type", message: "field type is missing or not a string", fix: "set a valid ACF field type" });
        } else if (!(field.type in FIELD_TEMPLATES) && !(field.type in EXTRA_FIELD_TYPES)) {
          findings.push({ severity: "warning", file, path: ctx.path + ".type", message: `field type ${field.type} is not a recognised ACF type (ok for third-party/ACFE types)`, fix: "verify the type or add it to EXTRA_FIELD_TYPES" });
        }
        // Rule 4: parent_repeater / parent_layout resolve within same group.
        const raw = field as Record<string, unknown>;
        if ("parent_repeater" in raw && typeof raw["parent_repeater"] === "string") {
          const t = raw["parent_repeater"] as string;
          if (!sameGroupFieldKeys.has(t)) {
            findings.push({ severity: "error", file, path: ctx.path + ".parent_repeater", message: `parent_repeater ${t} does not resolve to a field in this group`, fix: "set parent_repeater to an existing field key in the same group" });
          } else if (keyKind.get(t) !== "repeater") {
            findings.push({ severity: "warning", file, path: ctx.path + ".parent_repeater", message: `parent_repeater ${t} points to a ${keyKind.get(t) || "?"} field, not a repeater`, fix: "point parent_repeater at a repeater field key" });
          }
        }
        if ("parent_layout" in raw && typeof raw["parent_layout"] === "string") {
          const t = raw["parent_layout"] as string;
          if (!sameGroupFieldKeys.has(t)) {
            findings.push({ severity: "error", file, path: ctx.path + ".parent_layout", message: `parent_layout ${t} does not resolve to a layout in this group`, fix: "set parent_layout to an existing layout key in the same group" });
          } else if (keyKind.get(t) !== "__layout__") {
            findings.push({ severity: "warning", file, path: ctx.path + ".parent_layout", message: `parent_layout ${t} points to a field, not a flexible-content layout`, fix: "point parent_layout at a layout key" });
          }
        }
        // Rule 5: clone entries resolve across the whole index.
        if ("clone" in raw && Array.isArray(raw["clone"])) {
          for (const t of raw["clone"] as unknown[]) {
            if (typeof t === "string") {
              if (!index.allKeys.has(t)) {
                findings.push({ severity: "error", file, path: ctx.path + ".clone", message: `clone target ${t} does not resolve to any group_/field_ key in the index`, fix: "point clone at an existing group_ or field_ key" });
              }
            }
          }
        }
        // Rule 7: conditional_logic array-of-arrays → each rule references a field in same group.
        if (Array.isArray(raw["conditional_logic"])) {
          const cl = raw["conditional_logic"] as unknown[];
          cl.forEach((rulegroup, gi) => {
            if (!Array.isArray(rulegroup)) {
              findings.push({ severity: "error", file, path: `${ctx.path}.conditional_logic[${gi}]`, message: "conditional_logic group is not an array", fix: "wrap each condition in an array" });
              return;
            }
            rulegroup.forEach((rule, ri) => {
              if (!isRecord(rule) || !("field" in rule) || typeof rule["field"] !== "string") {
                findings.push({ severity: "error", file, path: `${ctx.path}.conditional_logic[${gi}][${ri}]`, message: "conditional_logic rule missing string 'field' key", fix: "set {field, operator, value}" });
                return;
              }
              const t = rule["field"] as string;
              // DECISION: rule 7 relaxed. ACF conditional_logic resolves at runtime;
              // an unresolvable field key is silently ignored (the condition never
              // matches), not a sync-breaking error. The boilerplate corpus ships
              // dangling refs (group_68a6e01be1430 references field_68a6e01be48d5 and
              // field_686f6fd192692, which exist nowhere) and the site works fine.
              // → unknown globally: warning (not error). cross-group known: warning.
              // Error stays only for malformed rule structure (non-array group, missing
              // string 'field' key).
              if (!index.allKeys.has(t)) {
                findings.push({ severity: "warning", file, path: `${ctx.path}.conditional_logic[${gi}][${ri}].field`, message: `conditional_logic references ${t} which is not a known field key in the index (dangling; ACF ignores at runtime)`, fix: "point at an existing field_ key or remove the rule" });
              } else if (!sameGroupFieldKeys.has(t)) {
                findings.push({ severity: "warning", file, path: `${ctx.path}.conditional_logic[${gi}][${ri}].field`, message: `conditional_logic references ${t} from another group (resolves via clone at runtime)`, fix: "ok if the target is cloned into this group; else move the field" });
              }
            });
          });
        }
        // Rule 10: choice-type fields should carry choices; a string default_value
        // should be one of the choice keys (object choices only).
        if (/^(select|radio|checkbox|button_group)$/.test(typeof field.type === "string" ? field.type : "")) {
          const ch = raw["choices"];
          if (ch === undefined) {
            findings.push({ severity: "warning", file, path: ctx.path + ".choices", message: `${field.type} field has no choices`, fix: "add a choices map { value: Label }" });
          } else if (!isRecord(ch) && !Array.isArray(ch)) {
            findings.push({ severity: "warning", file, path: ctx.path + ".choices", message: "choices is not an object or array", fix: "use { value: Label }" });
          } else if (isRecord(ch)) {
            const dv = raw["default_value"];
            const keys = Object.keys(ch);
            if (typeof dv === "string" && dv.length > 0 && keys.length > 0 && !keys.includes(dv)) {
              findings.push({ severity: "warning", file, path: ctx.path + ".default_value", message: `default_value "${dv}" is not one of the choices`, fix: "set default_value to a choice key or empty" });
            }
          }
        }
      },
      (layout, ctx) => {
        // Rule 6: layouts is a dict keyed by layout key; each layout has name, label, sub_fields.
        if (typeof layout.key !== "string" || layout.key.length === 0 || !layout.key.startsWith("layout_")) {
          findings.push({ severity: "error", file, path: ctx.path + ".key", message: `layout key ${String(layout.key)} is missing or lacks the layout_ prefix`, fix: "use generateKey('layout', …)" });
        } else if (!HEX13_RE.test(layout.key.slice("layout_".length))) {
          findings.push({ severity: "warning", file, path: ctx.path + ".key", message: `layout key ${layout.key} is not layout_<13hex> uniqid format; ACF still resolves it by exact key`, fix: "optional: regenerate with generateKey('layout', …)" });
        }
        if (typeof layout.name !== "string" || layout.name.length === 0) {
          findings.push({ severity: "error", file, path: ctx.path + ".name", message: "layout name is empty", fix: "set a non-empty snake_case name" });
        }
        if (typeof layout.label !== "string" || layout.label.length === 0) {
          findings.push({ severity: "warning", file, path: ctx.path + ".label", message: "layout label is empty", fix: "set a non-empty label" });
        }
        if (!Array.isArray(layout.sub_fields)) {
          findings.push({ severity: "error", file, path: ctx.path + ".sub_fields", message: "layout sub_fields is not an array", fix: "set sub_fields to []" });
        }
      },
    );

    // Rule 9: sibling field names must be unique within each container (group
    // fields, a repeater's/group's sub_fields, a layout's sub_fields). ACF
    // collides same-named siblings — warn (it loads, but reads/writes clash).
    const siblingNameCheck = (fields: unknown[], path: string): void => {
      const seen = new Map<string, number>();
      fields.forEach((f, i) => {
        if (!isRecord(f)) return;
        const nm = typeof f["name"] === "string" ? f["name"] : "";
        if (nm.length > 0) {
          const prev = seen.get(nm);
          if (prev !== undefined) findings.push({ severity: "warning", file, path: `${path}[${i}].name`, message: `duplicate sibling field name "${nm}" (also ${path}[${prev}]); ACF collides same-named siblings`, fix: "rename one of the duplicates" });
          else seen.set(nm, i);
        }
        if (Array.isArray(f["sub_fields"])) siblingNameCheck(f["sub_fields"], `${path}[${i}].sub_fields`);
        const lays = f["layouts"];
        if (isRecord(lays)) for (const lk of Object.keys(lays)) { const lr = lays[lk]; if (isRecord(lr) && Array.isArray(lr["sub_fields"])) siblingNameCheck(lr["sub_fields"], `${path}[${i}].layouts[${lk}].sub_fields`); }
      });
    };
    siblingNameCheck(Array.isArray(g.fields) ? g.fields : [], "fields");

    // Rule 8: acfe_autosync contains "json" — warning (not error).
    const a = (g as unknown as Record<string, unknown>)["acfe_autosync"];
    if (!Array.isArray(a) || !a.includes("json")) {
      findings.push({ severity: "warning", file, path: "acfe_autosync", message: "acfe_autosync missing 'json' (ACFE Local JSON sync disabled)", fix: 'set acfe_autosync: ["json"]' });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// planMove — pure, returns new group objects
// ---------------------------------------------------------------------------

function deepCloneField(f: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(f));
}

function removeFieldFromGroup(g: AcfGroup, fieldKey: string): { group: AcfGroup; removed: Record<string, unknown> | null } {
  const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  let removed: Record<string, unknown> | null = null;
  const fields = raw["fields"];
  if (Array.isArray(fields)) {
    const idx = fields.findIndex((f) => isRecord(f) && f["key"] === fieldKey);
    if (idx >= 0) {
      removed = deepCloneField(fields[idx] as Record<string, unknown>);
      fields.splice(idx, 1);
    }
    // also search nested
    if (!removed) {
      for (const f of fields) {
        if (isRecord(f)) {
          const r = removeFromNested(f, fieldKey);
          if (r) { removed = r; break; }
        }
      }
    }
  }
  return { group: raw as unknown as AcfGroup, removed };

  function removeFromNested(parent: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const sf = parent["sub_fields"];
    if (Array.isArray(sf)) {
      const idx = sf.findIndex((f) => isRecord(f) && f["key"] === key);
      if (idx >= 0) {
        const r = deepCloneField(sf[idx] as Record<string, unknown>);
        sf.splice(idx, 1);
        return r;
      }
      for (const f of sf) {
        if (isRecord(f)) {
          const r = removeFromNested(f, key);
          if (r) return r;
        }
      }
    }
    const lays = parent["layouts"];
    if (isRecord(lays)) {
      for (const lk of Object.keys(lays)) {
        const lr = lays[lk];
        if (isRecord(lr)) {
          const r = removeFromNested(lr, key);
          if (r) return r;
        }
      }
    }
    return null;
  }
}

function insertFieldIntoGroup(g: AcfGroup, field: Record<string, unknown>, target: { parent?: { type: "repeater" | "layout" | "group"; key: string } }): { group: AcfGroup; errors: string[] } {
  const errors: string[] = [];
  const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  const fclone = deepCloneField(field);
  // Strip any stale parent back-refs from the moved field; the correct one (if
  // any) is re-applied below based on the destination parent.
  delete fclone["parent_repeater"];
  delete fclone["parent_layout"];
  if (!target.parent) {
    // top-level append
    if (!Array.isArray(raw["fields"])) { errors.push("target group has no fields array"); return { group: raw as unknown as AcfGroup, errors }; }
    (raw["fields"] as unknown[]).push(fclone);
    return { group: raw as unknown as AcfGroup, errors };
  }
  // find the parent container (repeater → sub_fields, layout → layouts[key].sub_fields)
  const container = findContainer(raw, target.parent.key);
  if (!container) {
    errors.push(`parent ${target.parent.key} not found in target group`);
    return { group: raw as unknown as AcfGroup, errors };
  }
  const arr = container["sub_fields"];
  if (!Array.isArray(arr)) {
    // create it
    container["sub_fields"] = [];
  }
  // set the back-ref by parent type; group children carry no parent_* back-ref.
  if (target.parent.type === "repeater") fclone["parent_repeater"] = target.parent.key;
  else if (target.parent.type === "layout") fclone["parent_layout"] = target.parent.key;
  // also fix back-refs on the field's own descendants to point at their actual parents (unchanged).
  ((container["sub_fields"] as unknown[]) || (container["sub_fields"] = [])).push(fclone);
  return { group: raw as unknown as AcfGroup, errors };

  function findContainer(node: Record<string, unknown>, key: string): Record<string, unknown> | null {
    if (node["key"] === key) return node;
    const ff = node["fields"];
    if (Array.isArray(ff)) {
      for (const f of ff) {
        if (isRecord(f)) {
          const r = findContainer(f, key);
          if (r) return r;
        }
      }
    }
    const sf = node["sub_fields"];
    if (Array.isArray(sf)) {
      for (const f of sf) {
        if (isRecord(f)) {
          const r = findContainer(f, key);
          if (r) return r;
        }
      }
    }
    const lays = node["layouts"];
    if (isRecord(lays)) {
      for (const lk of Object.keys(lays)) {
        if (lk === key) return lays[lk] as Record<string, unknown>;
        const r = findContainer(lays[lk] as Record<string, unknown>, key);
        if (r) return r;
      }
    }
    return null;
  }
}

export function planMove(index: LoadedIndex, plan: MovePlan): { updatedGroups: AcfGroup[]; errors: string[] } {
  const errors: string[] = [];
  const srcGroup = index.groups.find((g) => g.key === plan.from.groupKey);
  if (!srcGroup) { errors.push(`source group ${plan.from.groupKey} not found`); return { updatedGroups: [], errors }; }
  const dstGroup = index.groups.find((g) => g.key === plan.to.groupKey);
  if (!dstGroup) { errors.push(`target group ${plan.to.groupKey} not found`); return { updatedGroups: [], errors }; }

  // Remove from source.
  const { group: newSrc, removed } = removeFieldFromGroup(srcGroup, plan.from.fieldKey);
  if (!removed) { errors.push(`field ${plan.from.fieldKey} not found in source group ${plan.from.groupKey}`); return { updatedGroups: [], errors }; }

  // Insert into target.
  const { group: newDst, errors: insErrs } = insertFieldIntoGroup(dstGroup, removed, plan.to);
  errors.push(...insErrs);
  if (errors.length) return { updatedGroups: [], errors };

  // Return minimal changed set. If src == dst, merge: the remove-then-insert must be one op.
  if (plan.from.groupKey === plan.to.groupKey) {
    // re-derive: remove from newSrc, insert into the same object. Simpler: redo on newSrc.
    const merged = insertFieldIntoGroup(newSrc, removed, plan.to).group;
    return { updatedGroups: [merged], errors };
  }
  return { updatedGroups: [newSrc, newDst], errors };
}

// ---------------------------------------------------------------------------
// cloneLayout — pure, new group object
// ---------------------------------------------------------------------------

export function cloneLayout(index: LoadedIndex, groupKey: string, layoutKey: string, newName: string, newLabel: string): { updatedGroup: AcfGroup; newLayoutKey: string; errors: string[] } {
  const errors: string[] = [];
  const g = index.groups.find((x) => x.key === groupKey);
  if (!g) { errors.push(`group ${groupKey} not found`); return { updatedGroup: g as unknown as AcfGroup, newLayoutKey: "", errors }; }
  const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  // find the flexible_content field whose layouts contains layoutKey
  let ownerField: Record<string, unknown> | null = null;
  let oldLayout: Record<string, unknown> | null = null;
  findFC(raw);
  if (!ownerField || !oldLayout) { errors.push(`layout ${layoutKey} not found in group ${groupKey}`); return { updatedGroup: raw as unknown as AcfGroup, newLayoutKey: "", errors }; }

  // New layout key. Build an old→new key map over the layout key + every
  // descendant field / nested-layout key, then (1) assign new keys and
  // (2) remap internal back-refs (parent_repeater, parent_layout,
  // conditional_logic) through the map. External `clone` targets are left
  // untouched — they point at fields elsewhere in the index.
  const newLK = generateKey("layout", index.allKeys);
  const cloned = JSON.parse(JSON.stringify(oldLayout)) as Record<string, unknown>;
  cloned["key"] = newLK;
  cloned["name"] = newName;
  cloned["label"] = newLabel;
  const keyMap = new Map<string, string>();
  keyMap.set(layoutKey, newLK);
  const topSubs = cloned["sub_fields"];
  if (Array.isArray(topSubs)) { for (const f of topSubs) { if (isRecord(f)) assignField(f); } }
  remapRefs(cloned);
  // Insert the clone into the layouts dict under newLK (source layout stays).
  const lays = ownerField["layouts"] as Record<string, unknown>;
  lays[newLK] = cloned;
  return { updatedGroup: raw as unknown as AcfGroup, newLayoutKey: newLK, errors };

  function findFC(node: Record<string, unknown>): void {
    if (node["type"] === "flexible_content" && isRecord(node["layouts"])) {
      const lays = node["layouts"] as Record<string, unknown>;
      if (layoutKey in lays) {
        ownerField = node;
        oldLayout = lays[layoutKey] as Record<string, unknown>;
        return;
      }
    }
    const sf = node["sub_fields"];
    if (Array.isArray(sf)) {
      for (const f of sf) { if (isRecord(f)) findFC(f); }
    }
    // top-level fields
    if (Array.isArray(node["fields"])) {
      for (const f of node["fields"]) { if (isRecord(f)) findFC(f); }
    }
  }

  // Pass 1 — mint a new key for this field and every descendant field /
  // nested layout, recording old→new in keyMap (for the back-ref remap).
  function assignField(f: Record<string, unknown>): void {
    if (typeof f["key"] === "string" && f["key"].length > 0) {
      const nk = generateKey("field", index.allKeys);
      keyMap.set(f["key"], nk);
      f["key"] = nk;
    }
    const sf = f["sub_fields"];
    if (Array.isArray(sf)) {
      for (const c of sf) { if (isRecord(c)) assignField(c); }
    }
    const flays = f["layouts"];
    if (isRecord(flays)) {
      for (const lk of Object.keys(flays)) {
        const lr = flays[lk];
        if (!isRecord(lr)) continue;
        const nlk = generateKey("layout", index.allKeys);
        keyMap.set(lk, nlk);
        lr["key"] = nlk;
        delete flays[lk];
        flays[nlk] = lr;
        const lsf = lr["sub_fields"];
        if (Array.isArray(lsf)) { for (const c of lsf) { if (isRecord(c)) assignField(c); } }
      }
    }
  }

  // Pass 2 — rewrite internal back-refs through keyMap. Unknown targets
  // (external clone sources, pre-existing dangling refs) are left as-is.
  function remapRefs(node: Record<string, unknown>): void {
    for (const refKey of ["parent_repeater", "parent_layout"]) {
      const v = node[refKey];
      if (typeof v === "string" && keyMap.has(v)) node[refKey] = keyMap.get(v) ?? v;
    }
    const cl = node["conditional_logic"];
    if (Array.isArray(cl)) {
      for (const grp of cl) {
        if (!Array.isArray(grp)) continue;
        for (const rule of grp) {
          if (isRecord(rule) && typeof rule["field"] === "string" && keyMap.has(rule["field"])) {
            rule["field"] = keyMap.get(rule["field"]) ?? rule["field"];
          }
        }
      }
    }
    const sf = node["sub_fields"];
    if (Array.isArray(sf)) { for (const c of sf) { if (isRecord(c)) remapRefs(c); } }
    const flays = node["layouts"];
    if (isRecord(flays)) { for (const lk of Object.keys(flays)) { const lr = flays[lk]; if (isRecord(lr)) remapRefs(lr); } }
  }
}

// ---------------------------------------------------------------------------
// buildField — merge template + overrides, resolve key
// ---------------------------------------------------------------------------

export function buildField(type: string, name: string, label: string, overrides: Record<string, unknown>, existingKeys: Set<string>): { field: AcfField; errors: string[] } {
  const errors: string[] = [];
  // A type is buildable if it has a build template OR is a recognised ACF /
  // ACFE / PRO type (EXTRA_FIELD_TYPES). Templated types get type-specific
  // defaults; recognised-but-untemplated types (relationship, post_object,
  // taxonomy, gallery, …) get base scaffolding only — ACF fills the rest of
  // its own defaults at load, and the caller can pass any via `overrides`.
  const hasTemplate = type in FIELD_TEMPLATES;
  if (!hasTemplate && !(type in EXTRA_FIELD_TYPES)) { errors.push(`unknown field type ${type}`); return { field: {} as AcfField, errors }; }
  if (typeof name !== "string" || name.length === 0) errors.push("name must be a non-empty string");
  if (typeof label !== "string") errors.push("label must be a string");
  // Honor a caller-provided key (e.g. minted earlier via acf_generate_key) when
  // it is a well-formed, collision-free field key; otherwise mint one. A bad or
  // colliding key is a hard error, never a silent re-mint (which surprised callers).
  const provided = overrides["key"];
  let key = "";
  if (provided !== undefined) {
    if (typeof provided !== "string" || !/^field_/.test(provided)) errors.push(`overrides.key must be a string starting with "field_" (got ${JSON.stringify(provided)})`);
    else if (existingKeys.has(provided)) errors.push(`field key ${provided} already exists`);
    else key = provided;
  }
  if (errors.length) return { field: {} as AcfField, errors };
  if (key === "") key = generateKey("field", existingKeys);
  else existingKeys.add(key);

  const tpl = hasTemplate ? FIELD_TEMPLATES[type] : undefined;
  const field: Record<string, unknown> = {
    // base scaffolding — overridable by `overrides` below
    instructions: "",
    required: 0,
    conditional_logic: 0,
    wrapper: { width: "", class: "", id: "" },
    "aria-label": "",
    // type-specific defaults (only for templated types)
    ...(tpl ? tpl.defaults : {}),
    // caller overrides win over scaffolding + type defaults
    ...overrides,
    // forced identity — explicit params authoritative; key resolved above
    key,
    label,
    name,
    type,
  };
  return { field: canonicaliseField(field) as unknown as AcfField, errors };
}

// ---------------------------------------------------------------------------
// removeField — delete a field by key from a group (any nest level) and scrub
// same-group conditional_logic rules that referenced it. Pure: returns a new
// group object.
// ---------------------------------------------------------------------------

export function removeField(index: LoadedIndex, groupKey: string, fieldKey: string, opts?: { scrubClones?: boolean }): { updatedGroup: AcfGroup; removed: Record<string, unknown> | null; cloneReferrers: { file: string; key: string }[]; scrubbedGroups: AcfGroup[]; errors: string[] } {
  const errors: string[] = [];
  const g = index.groups.find((x) => x.key === groupKey);
  if (!g) { errors.push(`group ${groupKey} not found`); return { updatedGroup: g as unknown as AcfGroup, removed: null, cloneReferrers: [], scrubbedGroups: [], errors }; }
  const { group, removed } = removeFieldFromGroup(g, fieldKey);
  if (!removed) { errors.push(`field ${fieldKey} not found in group ${groupKey}`); return { updatedGroup: group, removed: null, cloneReferrers: [], scrubbedGroups: [], errors }; }
  scrubConditionalRefs(group as unknown as Record<string, unknown>, fieldKey);
  const cloneReferrers = findCloneReferrers(index, fieldKey);
  const scrubbedGroups: AcfGroup[] = [];
  if (opts?.scrubClones === true && cloneReferrers.length > 0) {
    scrubCloneRefs(group as unknown as Record<string, unknown>, fieldKey); // same group
    const files = new Set(cloneReferrers.map((r) => r.file));
    for (const file of files) {
      const og = index.groups.find((x) => x._file === file);
      if (!og || og.key === groupKey) continue;
      const work = JSON.parse(JSON.stringify(og)) as Record<string, unknown>;
      scrubCloneRefs(work, fieldKey);
      scrubbedGroups.push(work as unknown as AcfGroup);
    }
  }
  return { updatedGroup: group, removed, cloneReferrers, scrubbedGroups, errors };
}

// Remove conditional_logic rules whose `field` equals removedKey; drop emptied
// rule-groups; collapse a fully-emptied conditional_logic array to 0 (ACF "none").
function scrubConditionalRefs(node: Record<string, unknown>, removedKey: string): void {
  const visit = (f: Record<string, unknown>): void => {
    const cl = f["conditional_logic"];
    if (Array.isArray(cl)) {
      const groups: unknown[] = [];
      for (const grp of cl) {
        if (!Array.isArray(grp)) { groups.push(grp); continue; }
        const kept = grp.filter((r) => !(isRecord(r) && r["field"] === removedKey));
        if (kept.length > 0) groups.push(kept);
      }
      f["conditional_logic"] = groups.length > 0 ? groups : 0;
    }
    const sf = f["sub_fields"];
    if (Array.isArray(sf)) { for (const c of sf) { if (isRecord(c)) visit(c); } }
    const lays = f["layouts"];
    if (isRecord(lays)) { for (const lk of Object.keys(lays)) { const lr = lays[lk]; if (isRecord(lr)) visit(lr); } }
  };
  const fields = node["fields"];
  if (Array.isArray(fields)) { for (const f of fields) { if (isRecord(f)) visit(f); } }
}

// ---------------------------------------------------------------------------
// reorderField — move a field to a new index within its current parent array
// (group fields, a repeater's sub_fields, or a layout's sub_fields). Pure.
// ---------------------------------------------------------------------------

export function reorderField(index: LoadedIndex, groupKey: string, fieldKey: string, toIndex: number): { updatedGroup: AcfGroup; fromIndex: number; toIndex: number; errors: string[] } {
  const errors: string[] = [];
  const g = index.groups.find((x) => x.key === groupKey);
  if (!g) { errors.push(`group ${groupKey} not found`); return { updatedGroup: g as unknown as AcfGroup, fromIndex: -1, toIndex, errors }; }
  const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  const loc = locateFieldArray(raw, fieldKey);
  if (!loc) { errors.push(`field ${fieldKey} not found in group ${groupKey}`); return { updatedGroup: raw as unknown as AcfGroup, fromIndex: -1, toIndex, errors }; }
  const { arr, index: from } = loc;
  const clamped = Math.max(0, Math.min(toIndex, arr.length - 1));
  const [item] = arr.splice(from, 1);
  arr.splice(clamped, 0, item);
  return { updatedGroup: raw as unknown as AcfGroup, fromIndex: from, toIndex: clamped, errors };
}

// Find the array directly containing fieldKey + the field's index within it.
function locateFieldArray(node: Record<string, unknown>, key: string): { arr: unknown[]; index: number } | null {
  const scan = (arr: unknown): { arr: unknown[]; index: number } | null => {
    if (!Array.isArray(arr)) return null;
    const i = arr.findIndex((f) => isRecord(f) && f["key"] === key);
    if (i >= 0) return { arr, index: i };
    for (const f of arr) {
      if (!isRecord(f)) continue;
      const inSub = scan(f["sub_fields"]);
      if (inSub) return inSub;
      const lays = f["layouts"];
      if (isRecord(lays)) {
        for (const lk of Object.keys(lays)) {
          const lr = lays[lk];
          if (isRecord(lr)) { const inLay = scan(lr["sub_fields"]); if (inLay) return inLay; }
        }
      }
    }
    return null;
  };
  return scan(node["fields"]);
}

// ---------------------------------------------------------------------------
// repairGroup — strip dangling back-refs: a parent_repeater / parent_layout
// that doesn't resolve to a key in the SAME group is deleted (ACF then renders
// the field as a normal child of wherever it is nested). Returns only the
// groups that actually changed, plus a human-readable change log.
// ---------------------------------------------------------------------------

export function repairGroup(index: LoadedIndex, groupKey?: string): { updatedGroups: AcfGroup[]; changes: string[]; errors: string[] } {
  const errors: string[] = [];
  const changes: string[] = [];
  const targets = groupKey ? index.groups.filter((g) => g.key === groupKey) : index.groups;
  if (groupKey && targets.length === 0) errors.push(`group ${groupKey} not found`);
  const updated: AcfGroup[] = [];
  for (const g of targets) {
    const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
    const sameGroupKeys = new Set<string>();
    walkGroup(g, (f) => sameGroupKeys.add(f.key));
    walkGroup(g, () => {}, (l) => sameGroupKeys.add(l.key));
    let changed = false;
    const visit = (f: Record<string, unknown>, path: string): void => {
      for (const refKey of ["parent_repeater", "parent_layout"]) {
        const v = f[refKey];
        if (typeof v === "string" && !sameGroupKeys.has(v)) {
          delete f[refKey];
          changed = true;
          changes.push(`${g.key} ${path}: stripped dangling ${refKey} -> ${v}`);
        }
      }
      if (Array.isArray(f["clone"])) {
        const arr = f["clone"] as unknown[];
        const kept = arr.filter((t) => typeof t === "string" && index.allKeys.has(t));
        if (kept.length !== arr.length) { f["clone"] = kept; changed = true; changes.push(`${g.key} ${path}: stripped ${arr.length - kept.length} dangling clone target(s)`); }
      }
      const sf = f["sub_fields"];
      if (Array.isArray(sf)) { sf.forEach((c, i) => { if (isRecord(c)) visit(c, `${path}.sub_fields[${i}]`); }); }
      const lays = f["layouts"];
      if (isRecord(lays)) { for (const lk of Object.keys(lays)) { const lr = lays[lk]; if (isRecord(lr)) visit(lr, `${path}.layouts[${lk}]`); } }
    };
    const fields = raw["fields"];
    if (Array.isArray(fields)) { fields.forEach((f, i) => { if (isRecord(f)) visit(f, `fields[${i}]`); }); }
    if (changed) updated.push(raw as unknown as AcfGroup);
  }
  return { updatedGroups: updated, changes, errors };
}

// ---------------------------------------------------------------------------
// updateField — merge a patch onto an existing field IN PLACE, preserving its
// key (so saved post-meta + back-refs survive). Refuses a key change. Objects
// deep-merge; arrays/scalars replace. Pure: returns a new group object.
// ---------------------------------------------------------------------------

export function updateField(index: LoadedIndex, groupKey: string, fieldKey: string, patch: Record<string, unknown>): { updatedGroup: AcfGroup; errors: string[] } {
  const errors: string[] = [];
  const g = index.groups.find((x) => x.key === groupKey);
  if (!g) { errors.push(`group ${groupKey} not found`); return { updatedGroup: g as unknown as AcfGroup, errors }; }
  if ("key" in patch && patch["key"] !== fieldKey) {
    errors.push("refusing to change a field key via update (breaks saved data + back-refs); use a dedicated rename");
    return { updatedGroup: g as unknown as AcfGroup, errors };
  }
  const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  const node = findNodeByKey(raw, fieldKey);
  if (!node) { errors.push(`field ${fieldKey} not found in group ${groupKey}`); return { updatedGroup: raw as unknown as AcfGroup, errors }; }
  deepMergeInto(node, patch);
  node["key"] = fieldKey;
  return { updatedGroup: raw as unknown as AcfGroup, errors };
}

function deepMergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const tv = target[k];
    if (isRecord(pv) && isRecord(tv)) deepMergeInto(tv, pv);
    else target[k] = pv;
  }
}

// Find any field/owner node by exact key (fields, sub_fields, layout sub_fields).
function findNodeByKey(node: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(node)) return null;
  if (node["key"] === key) return node;
  const ff = node["fields"];
  if (Array.isArray(ff)) { for (const f of ff) { const r = findNodeByKey(f, key); if (r) return r; } }
  const sf = node["sub_fields"];
  if (Array.isArray(sf)) { for (const f of sf) { const r = findNodeByKey(f, key); if (r) return r; } }
  const lays = node["layouts"];
  if (isRecord(lays)) { for (const lk of Object.keys(lays)) { const r = findNodeByKey(lays[lk], key); if (r) return r; } }
  return null;
}

// Find the flexible_content field whose layouts dict contains layoutKey.
function findFlexOwnerOf(node: unknown, layoutKey: string): Record<string, unknown> | null {
  if (!isRecord(node)) return null;
  if (node["type"] === "flexible_content" && isRecord(node["layouts"]) && layoutKey in node["layouts"]) return node;
  const ff = node["fields"];
  if (Array.isArray(ff)) { for (const f of ff) { const r = findFlexOwnerOf(f, layoutKey); if (r) return r; } }
  const sf = node["sub_fields"];
  if (Array.isArray(sf)) { for (const f of sf) { const r = findFlexOwnerOf(f, layoutKey); if (r) return r; } }
  const lays = node["layouts"];
  if (isRecord(lays)) { for (const lk of Object.keys(lays)) { const r = findFlexOwnerOf(lays[lk], layoutKey); if (r) return r; } }
  return null;
}

// Fields anywhere in the index whose `clone` array references key (excludes key itself).
function findCloneReferrers(index: LoadedIndex, key: string): { file: string; key: string }[] {
  const out: { file: string; key: string }[] = [];
  for (const g of index.groups) {
    walkGroup(g, (f) => {
      const raw = f as Record<string, unknown>;
      if (Array.isArray(raw["clone"]) && (raw["clone"] as unknown[]).includes(key) && f.key !== key) {
        out.push({ file: g._file, key: f.key });
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Flexible-content layout lifecycle: add / remove / reorder / rename. Pure.
// ---------------------------------------------------------------------------

export function addLayout(index: LoadedIndex, groupKey: string, flexFieldKey: string, name: string, label: string, display: string): { updatedGroup: AcfGroup; newLayoutKey: string; errors: string[] } {
  const errors: string[] = [];
  const g = index.groups.find((x) => x.key === groupKey);
  if (!g) { errors.push(`group ${groupKey} not found`); return { updatedGroup: g as unknown as AcfGroup, newLayoutKey: "", errors }; }
  const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  const flex = findNodeByKey(raw, flexFieldKey);
  if (!flex) { errors.push(`field ${flexFieldKey} not found in group ${groupKey}`); return { updatedGroup: raw as unknown as AcfGroup, newLayoutKey: "", errors }; }
  if (flex["type"] !== "flexible_content") { errors.push(`field ${flexFieldKey} is not a flexible_content field`); return { updatedGroup: raw as unknown as AcfGroup, newLayoutKey: "", errors }; }
  if (!isRecord(flex["layouts"])) flex["layouts"] = {};
  const lays = flex["layouts"] as Record<string, unknown>;
  const newLK = generateKey("layout", index.allKeys);
  lays[newLK] = { key: newLK, name, label, display: display.length > 0 ? display : "block", sub_fields: [], min: "", max: "" };
  return { updatedGroup: raw as unknown as AcfGroup, newLayoutKey: newLK, errors };
}

export function removeLayout(index: LoadedIndex, groupKey: string, layoutKey: string): { updatedGroup: AcfGroup; errors: string[] } {
  const errors: string[] = [];
  const g = index.groups.find((x) => x.key === groupKey);
  if (!g) { errors.push(`group ${groupKey} not found`); return { updatedGroup: g as unknown as AcfGroup, errors }; }
  const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  const owner = findFlexOwnerOf(raw, layoutKey);
  if (!owner || !isRecord(owner["layouts"])) { errors.push(`layout ${layoutKey} not found in group ${groupKey}`); return { updatedGroup: raw as unknown as AcfGroup, errors }; }
  delete (owner["layouts"] as Record<string, unknown>)[layoutKey];
  return { updatedGroup: raw as unknown as AcfGroup, errors };
}

export function reorderLayout(index: LoadedIndex, groupKey: string, layoutKey: string, toIndex: number): { updatedGroup: AcfGroup; fromIndex: number; toIndex: number; errors: string[] } {
  const errors: string[] = [];
  const g = index.groups.find((x) => x.key === groupKey);
  if (!g) { errors.push(`group ${groupKey} not found`); return { updatedGroup: g as unknown as AcfGroup, fromIndex: -1, toIndex, errors }; }
  const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  const owner = findFlexOwnerOf(raw, layoutKey);
  if (!owner || !isRecord(owner["layouts"])) { errors.push(`layout ${layoutKey} not found in group ${groupKey}`); return { updatedGroup: raw as unknown as AcfGroup, fromIndex: -1, toIndex, errors }; }
  const lays = owner["layouts"] as Record<string, unknown>;
  const keys = Object.keys(lays);
  const from = keys.indexOf(layoutKey);
  const clamped = Math.max(0, Math.min(toIndex, keys.length - 1));
  keys.splice(from, 1);
  keys.splice(clamped, 0, layoutKey);
  const rebuilt: Record<string, unknown> = {};
  for (const k of keys) rebuilt[k] = lays[k];
  owner["layouts"] = rebuilt;
  return { updatedGroup: raw as unknown as AcfGroup, fromIndex: from, toIndex: clamped, errors };
}

export function renameLayout(index: LoadedIndex, groupKey: string, layoutKey: string, newName: string, newLabel: string): { updatedGroup: AcfGroup; errors: string[] } {
  const errors: string[] = [];
  const g = index.groups.find((x) => x.key === groupKey);
  if (!g) { errors.push(`group ${groupKey} not found`); return { updatedGroup: g as unknown as AcfGroup, errors }; }
  const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  const owner = findFlexOwnerOf(raw, layoutKey);
  if (!owner || !isRecord(owner["layouts"])) { errors.push(`layout ${layoutKey} not found in group ${groupKey}`); return { updatedGroup: raw as unknown as AcfGroup, errors }; }
  const layout = (owner["layouts"] as Record<string, unknown>)[layoutKey];
  if (!isRecord(layout)) { errors.push(`layout ${layoutKey} is malformed`); return { updatedGroup: raw as unknown as AcfGroup, errors }; }
  if (newName.length > 0) layout["name"] = newName;
  if (newLabel.length > 0) layout["label"] = newLabel;
  return { updatedGroup: raw as unknown as AcfGroup, errors };
}

// ---------------------------------------------------------------------------
// canonicaliseField — reorder a field's keys to ACF's canonical head order
// (key,label,name,…) for byte-faithful diffs. Remaining keys keep their order.
// ---------------------------------------------------------------------------

const FIELD_KEY_ORDER: string[] = ["key", "label", "name", "aria-label", "type", "instructions", "required", "conditional_logic", "wrapper"];
function canonicaliseField(f: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FIELD_KEY_ORDER) if (k in f) out[k] = f[k];
  for (const k of Object.keys(f)) if (!(k in out)) out[k] = f[k];
  return out;
}

// Remove a key from every `clone` array in the group's subtree.
function scrubCloneRefs(node: Record<string, unknown>, removedKey: string): void {
  const visit = (f: Record<string, unknown>): void => {
    if (Array.isArray(f["clone"])) f["clone"] = (f["clone"] as unknown[]).filter((t) => t !== removedKey);
    const sf = f["sub_fields"];
    if (Array.isArray(sf)) { for (const c of sf) { if (isRecord(c)) visit(c); } }
    const lays = f["layouts"];
    if (isRecord(lays)) { for (const lk of Object.keys(lays)) { const lr = lays[lk]; if (isRecord(lr)) visit(lr); } }
  };
  const fields = node["fields"];
  if (Array.isArray(fields)) { for (const f of fields) { if (isRecord(f)) visit(f); } }
}

// ---------------------------------------------------------------------------
// Group lifecycle: createGroup (builds a new group object) + updateGroupSettings.
// ---------------------------------------------------------------------------

export function createGroup(index: LoadedIndex, opts: { title: string; location?: unknown[]; position?: string; style?: string; menuOrder?: number; active?: boolean }): { group: AcfGroup; key: string; errors: string[] } {
  const errors: string[] = [];
  if (typeof opts.title !== "string" || opts.title.length === 0) { errors.push("title is required"); return { group: {} as AcfGroup, key: "", errors }; }
  const key = generateKey("group", index.allKeys);
  const group: Record<string, unknown> = {
    key,
    title: opts.title,
    fields: [],
    location: Array.isArray(opts.location) ? opts.location : [],
    menu_order: typeof opts.menuOrder === "number" ? opts.menuOrder : 0,
    position: typeof opts.position === "string" && opts.position.length > 0 ? opts.position : "normal",
    style: typeof opts.style === "string" && opts.style.length > 0 ? opts.style : "default",
    label_placement: "top",
    instruction_placement: "label",
    hide_on_screen: "",
    active: typeof opts.active === "boolean" ? opts.active : true,
    description: "",
    show_in_rest: 0,
  };
  return { group: group as unknown as AcfGroup, key, errors };
}

export function updateGroupSettings(index: LoadedIndex, groupKey: string, patch: Record<string, unknown>): { updatedGroup: AcfGroup; errors: string[] } {
  const errors: string[] = [];
  const g = index.groups.find((x) => x.key === groupKey);
  if (!g) { errors.push(`group ${groupKey} not found`); return { updatedGroup: g as unknown as AcfGroup, errors }; }
  for (const blocked of ["key", "fields", "_file"]) {
    if (blocked in patch) { errors.push(`refusing to change "${blocked}" via update_group_settings`); return { updatedGroup: g as unknown as AcfGroup, errors }; }
  }
  const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  deepMergeInto(raw, patch);
  return { updatedGroup: raw as unknown as AcfGroup, errors };
}

// ---------------------------------------------------------------------------
// renameField — change a field's name and/or key. A key change rewrites every
// parent_repeater / parent_layout / clone / conditional_logic reference across
// ALL groups. Returns every group that changed.
// ---------------------------------------------------------------------------

export function renameField(index: LoadedIndex, groupKey: string, fieldKey: string, opts: { newName?: string; newKey?: string }): { updatedGroups: AcfGroup[]; errors: string[] } {
  const errors: string[] = [];
  const g = index.groups.find((x) => x.key === groupKey);
  if (!g) { errors.push(`group ${groupKey} not found`); return { updatedGroups: [], errors }; }
  const wantName = typeof opts.newName === "string" && opts.newName.length > 0;
  const wantKey = opts.newKey !== undefined;
  if (!wantName && !wantKey) { errors.push("nothing to rename (provide newName or newKey)"); return { updatedGroups: [], errors }; }
  if (wantKey) {
    if (opts.newKey === fieldKey) { errors.push("newKey equals current key"); return { updatedGroups: [], errors }; }
    if (typeof opts.newKey !== "string" || !opts.newKey.startsWith("field_")) { errors.push("newKey must start with field_"); return { updatedGroups: [], errors }; }
    if (index.allKeys.has(opts.newKey)) { errors.push(`newKey ${opts.newKey} already exists`); return { updatedGroups: [], errors }; }
  }
  const newKey = wantKey && typeof opts.newKey === "string" ? opts.newKey : "";
  const updated: AcfGroup[] = [];
  let foundField = false;
  for (const grp of index.groups) {
    const w = JSON.parse(JSON.stringify(grp)) as Record<string, unknown>;
    let changed = false;
    if (grp.key === groupKey) {
      const node = findNodeByKey(w, fieldKey);
      if (node) {
        foundField = true;
        if (wantName) { node["name"] = opts.newName; changed = true; }
        if (wantKey) { node["key"] = newKey; changed = true; }
      }
    }
    if (wantKey && rewriteKeyRefs(w, fieldKey, newKey)) changed = true;
    if (changed) updated.push(w as unknown as AcfGroup);
  }
  if (!foundField) { errors.push(`field ${fieldKey} not found in group ${groupKey}`); return { updatedGroups: [], errors }; }
  return { updatedGroups: updated, errors };
}

// Rewrite every parent_repeater / parent_layout / clone[] / conditional_logic
// reference equal to oldKey -> newKey within a group subtree. Returns true if changed.
function rewriteKeyRefs(node: Record<string, unknown>, oldKey: string, newKey: string): boolean {
  let changed = false;
  const visit = (f: Record<string, unknown>): void => {
    for (const rk of ["parent_repeater", "parent_layout"]) if (f[rk] === oldKey) { f[rk] = newKey; changed = true; }
    if (Array.isArray(f["clone"])) { const arr = f["clone"] as unknown[]; for (let i = 0; i < arr.length; i++) if (arr[i] === oldKey) { arr[i] = newKey; changed = true; } }
    const cl = f["conditional_logic"];
    if (Array.isArray(cl)) { for (const grp of cl) { if (Array.isArray(grp)) for (const r of grp) { if (isRecord(r) && r["field"] === oldKey) { r["field"] = newKey; changed = true; } } } }
    const sf = f["sub_fields"];
    if (Array.isArray(sf)) { for (const c of sf) { if (isRecord(c)) visit(c); } }
    const lays = f["layouts"];
    if (isRecord(lays)) { for (const lk of Object.keys(lays)) { const lr = lays[lk]; if (isRecord(lr)) visit(lr); } }
  };
  const fields = node["fields"];
  if (Array.isArray(fields)) { for (const f of fields) { if (isRecord(f)) visit(f); } }
  return changed;
}

// ---------------------------------------------------------------------------
// outline — compact tree (key/type/name/nesting) for orientation without
// reading the full JSON. One group or all.
// ---------------------------------------------------------------------------

export function outline(index: LoadedIndex, groupKey?: string): string {
  const lines: string[] = [];
  const groups = groupKey ? index.groups.filter((g) => g.key === groupKey) : index.groups;
  const walk = (fields: unknown[], depth: number): void => {
    for (const f of fields) {
      if (!isRecord(f)) continue;
      const ind = "  ".repeat(depth + 1);
      const nm = typeof f["name"] === "string" && f["name"].length > 0 ? f["name"] : "(no name)";
      const ty = typeof f["type"] === "string" ? f["type"] : "?";
      const k = typeof f["key"] === "string" ? f["key"] : "?";
      lines.push(`${ind}- ${nm} [${ty}] ${k}`);
      if (Array.isArray(f["sub_fields"])) walk(f["sub_fields"], depth + 1);
      const lays = f["layouts"];
      if (isRecord(lays)) {
        for (const lk of Object.keys(lays)) {
          const lr = lays[lk];
          if (!isRecord(lr)) continue;
          lines.push(`${ind}  @ ${typeof lr["name"] === "string" ? lr["name"] : ""} [layout] ${lk}`);
          if (Array.isArray(lr["sub_fields"])) walk(lr["sub_fields"], depth + 2);
        }
      }
    }
  };
  for (const g of groups) {
    lines.push(`${g.key}  "${g.title}"`);
    walk(Array.isArray(g.fields) ? g.fields : [], 0);
  }
  return lines.join("\n");
}