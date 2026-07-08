// acf-json MCP tool registrations — 22 tools, one-to-one port of the oh-my-pi
// acf-json extension's tool handlers onto the MCP `server.registerTool` API.
//
// Differences from the OMP extension:
//   - No `tool_call` guard. An MCP server has no write/edit interception surface;
//     the "don't hand-edit acf-json/group_*.json" rule is advisory in the docs,
//     not enforced here. (The OMP extension enforced it via a host-side hook.)
//   - `ctx.cwd` comes from the `ACF_JSON_PROJECT_ROOT` env var (set per-client)
//     or `process.cwd()`, not a session context object.
//   - Result shape is the MCP `{ content: [{ type: "text", text }], isError? }`.
//
// engine.ts and sync.ts are reused verbatim — the same pure logic the OMP
// extension ships.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

import {
  findAcfJsonDirs,
  generateKey,
  findField,
  planMove,
  cloneLayout,
  validate,
  references,
  buildField,
  removeField,
  reorderField,
  repairGroup,
  updateField,
  addLayout,
  removeLayout,
  reorderLayout,
  renameLayout,
  createGroup,
  updateGroupSettings,
  renameField,
  outline,
  type KeyPrefix,
} from "./engine.ts";
import { runSync } from "./sync.ts";
import {
  getIndex,
  invalidateIndex,
  formatFindings,
  formatEdges,
  formatSyncResult,
  writeGroupFile,
  writeGroupFilesAtomic,
  commit,
  isRecord,
  findFieldByKey,
  findLayoutOwner,
  resolveProjectRoot,
  resolveOneGroup,
} from "./helpers.ts";

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(text: string, details?: Record<string, unknown>): TextResult {
  return { content: [{ type: "text", text: details ? text + "\n\n" + JSON.stringify(details, null, 2) : text }] };
}
function fail(message: string): TextResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}
async function guard(fn: () => Promise<TextResult> | TextResult): Promise<TextResult> {
  try {
    return await fn();
  } catch (e) {
    return fail((e as Error).message);
  }
}

// Per-call cwd fallback (when no explicit projectRoot arg is passed). Order:
//   ACF_JSON_PROJECT_ROOT  — explicit pin set at registration time.
//   CLAUDE_PROJECT_DIR     — injected by Claude Code = the active project root,
//                            so one user-scope install auto-targets whatever WP
//                            project the session is in (no per-project pinning).
// Falls through to process.cwd() in resolveProjectRoot when neither is set.
function ctxCwd(): { cwd?: string } {
  const env = process.env.ACF_JSON_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR;
  return env && env.length > 0 ? { cwd: env } : {};
}

export function registerTools(server: McpServer): void {
  // --- Tool 1: acf_generate_key ---------------------------------------------
  server.registerTool(
    "acf_generate_key",
    {
      description:
        "Generate a collision-free group_/field_/layout_ key (13-hex, uniqid format) verified unique across all loaded ACF groups.",
      inputSchema: {
        prefix: z.enum(["group", "field", "layout"]),
        projectRoot: z.string().optional(),
      },
    },
    async ({ prefix, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const k = generateKey(prefix as KeyPrefix, idx.allKeys);
      return ok(k, { key: k, prefix });
    }),
  );

  // --- Tool 2: acf_find_field ------------------------------------------------
  server.registerTool(
    "acf_find_field",
    {
      description:
        "Locate fields across ACF groups by name, key, type, name-substring (nameContains), and/or groupKey — filters combine (AND). Returns file, parent chain, and the full field object.",
      inputSchema: {
        query: z
          .object({
            name: z.string().optional(),
            key: z.string().optional(),
            type: z.string().optional(),
            nameContains: z.string().optional(),
            groupKey: z.string().optional(),
          })
          .refine(
            (q) => q.name !== undefined || q.key !== undefined || q.type !== undefined || q.nameContains !== undefined || q.groupKey !== undefined,
            "provide at least one filter",
          ),
        projectRoot: z.string().optional(),
      },
    },
    async ({ query, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const hits = findField(idx, query);
      return ok(JSON.stringify(hits, null, 2), { count: hits.length });
    }),
  );

  // --- Tool 3: acf_validate --------------------------------------------------
  server.registerTool(
    "acf_validate",
    {
      description:
        "Validate ACF field group JSON structure: required keys, key format, collisions, parent_repeater/clone/conditional_logic resolution, layouts dict. Severity-tagged findings.",
      inputSchema: {
        groupKey: z.string().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const findings = validate(idx, groupKey);
      const errorCount = findings.filter((f) => f.severity === "error").length;
      const warningCount = findings.filter((f) => f.severity === "warning").length;
      const infoCount = findings.filter((f) => f.severity === "info").length;
      return ok(formatFindings(findings), { errorCount, warningCount, infoCount });
    }),
  );

  // --- Tool 4: acf_references ------------------------------------------------
  server.registerTool(
    "acf_references",
    {
      description:
        "Build the ACF reference graph: clone targets, parent_repeater, conditional_logic edges. Reports unresolved references.",
      inputSchema: {
        projectRoot: z.string().optional(),
      },
    },
    async ({ projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const edges = references(idx);
      return ok(formatEdges(edges), { edgeCount: edges.length });
    }),
  );

  // --- Tool 5: acf_add_field -------------------------------------------------
  server.registerTool(
    "acf_add_field",
    {
      description:
        "Build a type-correct ACF field (valid key, type-specific defaults) and insert it into a group, a repeater's sub_fields, or a flexible-content layout's sub_fields, setting parent_repeater (repeater child) or parent_layout (layout child). Writes the updated group_*.json.",
      inputSchema: {
        groupKey: z.string(),
        parent: z.object({ type: z.enum(["repeater", "layout", "group"]), key: z.string() }).optional(),
        field: z.object({
          type: z.string(),
          name: z.string(),
          label: z.string(),
          overrides: z.record(z.string(), z.unknown()).optional(),
        }),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, parent, field, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const gr = resolveOneGroup(idx, groupKey);
      if ("error" in gr) return fail(gr.error);
      const g = gr.group;
      const built = buildField(field.type, field.name, field.label, field.overrides ?? {}, idx.allKeys);
      if (built.errors.length > 0) return fail(built.errors.join("; "));
      const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
      const newField = built.field as unknown as Record<string, unknown>;

      if (parent) {
        if (parent.type === "repeater" || parent.type === "group") {
          const parentField = findFieldByKey(raw, parent.key);
          if (!parentField || !isRecord(parentField)) return fail(`${parent.type} ${parent.key} not found in ${groupKey}`);
          const pt = typeof parentField["type"] === "string" ? parentField["type"] : "";
          if (pt !== parent.type) return fail(`${parent.key} is type "${pt}", not a ${parent.type}`);
          if (!Array.isArray(parentField["sub_fields"])) parentField["sub_fields"] = [];
          if (parent.type === "repeater") newField["parent_repeater"] = parent.key;
          (parentField["sub_fields"] as unknown[]).push(newField);
        } else {
          const owner = findLayoutOwner(raw, parent.key);
          if (!owner) return fail(`layout ${parent.key} not found in ${groupKey}`);
          const lays = owner["layouts"];
          if (!isRecord(lays)) return fail(`layouts is not a dict on ${owner.key}`);
          const layout = lays[parent.key];
          if (!isRecord(layout)) return fail(`layout ${parent.key} missing`);
          if (!Array.isArray(layout["sub_fields"])) (layout as Record<string, unknown>)["sub_fields"] = [];
          newField["parent_layout"] = parent.key;
          ((layout as Record<string, unknown>)["sub_fields"] as unknown[]).push(newField);
        }
      } else {
        const fields = raw["fields"];
        if (!Array.isArray(fields)) return fail(`group ${groupKey} has no fields array`);
        (fields as unknown[]).push(newField);
      }

      const file = g._file;
      writeGroupFile(file, raw);
      invalidateIndex();
      const fieldKey = typeof newField["key"] === "string" ? newField["key"] : "";
      const summary = `Added field ${fieldKey} (${field.name}) to ${groupKey} at ${file}. Validate? run acf_validate.`;
      return ok(summary, { fieldKey, groupKey, file });
    }),
  );

  // --- Tool 6: acf_move_field ------------------------------------------------
  server.registerTool(
    "acf_move_field",
    {
      description:
        "Move a field between groups/parents — including parents nested inside flexible-content (repeater or layout) — preserving its key. Sets the correct parent_layout/parent_repeater back-ref and strips stale ones. Writes the affected group_*.json files.",
      inputSchema: {
        from: z.object({ groupKey: z.string(), fieldKey: z.string() }),
        to: z.object({
          groupKey: z.string(),
          parent: z.object({ type: z.enum(["repeater", "layout", "group"]), key: z.string() }).optional(),
        }),
        projectRoot: z.string().optional(),
      },
    },
    async ({ from, to, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      for (const gk of new Set([from.groupKey, to.groupKey])) {
        const gr = resolveOneGroup(idx, gk);
        if ("error" in gr) return fail(gr.error);
      }
      const result = planMove(idx, { from, to });
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const entries = result.updatedGroups.map((ug) => ({ file: ug._file, group: ug as unknown as Record<string, unknown> }));
      writeGroupFilesAtomic(entries);
      const writtenFiles = entries.map((e) => e.file);
      invalidateIndex();
      const summary = `Moved field ${from.fieldKey} from ${from.groupKey} to ${to.groupKey}.`;
      return ok(summary, { movedFieldKey: from.fieldKey, writtenFiles });
    }),
  );

  // --- Tool 7: acf_clone_layout ----------------------------------------------
  server.registerTool(
    "acf_clone_layout",
    {
      description:
        "Deep-copy a flexible-content layout: new layout key, regenerated child + nested-layout keys, with parent_repeater/parent_layout/conditional_logic back-refs remapped to the new keys (external clone targets untouched). Writes the updated group_*.json.",
      inputSchema: {
        groupKey: z.string(),
        layoutKey: z.string(),
        newName: z.string(),
        newLabel: z.string(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, layoutKey, newName, newLabel, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const result = cloneLayout(idx, groupKey, layoutKey, newName, newLabel);
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const gr = resolveOneGroup(idx, groupKey);
      if ("error" in gr) return fail(gr.error);
      const g = gr.group;
      writeGroupFile(g._file, result.updatedGroup as unknown as Record<string, unknown>);
      invalidateIndex();
      const summary = `Cloned layout ${layoutKey} -> ${result.newLayoutKey} (${newName}) in ${groupKey}.`;
      return ok(summary, { newLayoutKey: result.newLayoutKey, groupKey, file: g._file });
    }),
  );

  // --- Tool 8: acf_sync -------------------------------------------------------
  server.registerTool(
    "acf_sync",
    {
      description:
        "Sync acf-json/*.json into the WordPress database via wp acf json sync (ACF PRO), a wp eval fallback, or return instructions for the ocsites MCP tool if wp is unavailable. Read-only dryRun supported.",
      inputSchema: {
        projectRoot: z.string().optional(),
        dryRun: z.boolean().optional(),
        key: z.string().optional(),
      },
    },
    async ({ projectRoot, dryRun, key }) => guard(async () => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const dr = typeof dryRun === "boolean" ? dryRun : false;
      const k = typeof key === "string" && key.length > 0 ? key : undefined;
      const res = await runSync(root, { dryRun: dr, key: k });
      return ok(formatSyncResult(res), { method: res.method, ok: res.ok });
    }),
  );

  // --- Tool 9: acf_remove_field ----------------------------------------------
  server.registerTool(
    "acf_remove_field",
    {
      description:
        "Remove a field by key from a group (top level, a repeater, or a flexible-content layout), scrubbing same-group conditional_logic rules that referenced it. Writes the updated group_*.json.",
      inputSchema: {
        groupKey: z.string(),
        fieldKey: z.string(),
        scrubClones: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, fieldKey, scrubClones, dryRun, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const dr = dryRun === true;
      const idx = getIndex(root);
      const result = removeField(idx, groupKey, fieldKey, { scrubClones: scrubClones === true });
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const gr = resolveOneGroup(idx, groupKey);
      if ("error" in gr) return fail(gr.error);
      const g = gr.group;
      const entries = [{ file: g._file, group: result.updatedGroup as unknown as Record<string, unknown> }];
      for (const sg of result.scrubbedGroups) entries.push({ file: sg._file, group: sg as unknown as Record<string, unknown> });
      let summary = `Removed field ${fieldKey} from ${groupKey} at ${g._file}.`;
      if (scrubClones === true && result.cloneReferrers.length > 0) {
        summary += `\nScrubbed ${result.cloneReferrers.length} clone reference(s) (${result.scrubbedGroups.length} other group(s) rewritten).`;
      } else if (result.cloneReferrers.length > 0) {
        summary += `\nWARNING: still referenced by clone in ${result.cloneReferrers.length} field(s): ` + result.cloneReferrers.map((r) => r.key).join(", ") + ". Pass scrubClones:true to auto-remove, or update them.";
      }
      const r = commit(entries, dr, summary, { removedFieldKey: fieldKey, groupKey, cloneReferrers: result.cloneReferrers });
      return ok(r.content[0]?.text ?? summary, r.details);
    }),
  );

  // --- Tool 10: acf_reorder_field --------------------------------------------
  server.registerTool(
    "acf_reorder_field",
    {
      description:
        "Move a field to a new position within its current parent (group fields, a repeater's sub_fields, or a layout's sub_fields). toIndex is 0-based and clamped to the array bounds. Writes the updated group_*.json.",
      inputSchema: {
        groupKey: z.string(),
        fieldKey: z.string(),
        toIndex: z.number().int(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, fieldKey, toIndex, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const result = reorderField(idx, groupKey, fieldKey, toIndex);
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const gr = resolveOneGroup(idx, groupKey);
      if ("error" in gr) return fail(gr.error);
      const g = gr.group;
      writeGroupFile(g._file, result.updatedGroup as unknown as Record<string, unknown>);
      invalidateIndex();
      const summary = `Reordered field ${fieldKey} in ${groupKey}: index ${result.fromIndex} -> ${result.toIndex}.`;
      return ok(summary, { fieldKey, fromIndex: result.fromIndex, toIndex: result.toIndex, file: g._file });
    }),
  );

  // --- Tool 11: acf_repair ----------------------------------------------------
  server.registerTool(
    "acf_repair",
    {
      description:
        "Strip dangling parent_repeater/parent_layout back-refs (refs that don't resolve to a key in the same group) from one group or all groups. Returns the change log. Writes only the group_*.json files that changed.",
      inputSchema: {
        groupKey: z.string().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const result = repairGroup(idx, groupKey);
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const entries = result.updatedGroups.map((ug) => ({ file: ug._file, group: ug as unknown as Record<string, unknown> }));
      const writtenFiles = entries.map((e) => e.file);
      if (entries.length > 0) { writeGroupFilesAtomic(entries); invalidateIndex(); }
      const summary = result.changes.length > 0
        ? `Repaired ${writtenFiles.length} group(s):\n` + result.changes.map((c) => "  " + c).join("\n")
        : "No dangling back-refs found; nothing to repair.";
      return ok(summary, { changedFiles: writtenFiles, changeCount: result.changes.length });
    }),
  );

  // --- Tool 12: acf_update_field ---------------------------------------------
  server.registerTool(
    "acf_update_field",
    {
      description:
        "Edit an existing field's properties IN PLACE by key (label, instructions, required, choices, default_value, conditional_logic, wrapper, type-specific props). Preserves the field key so saved data + back-refs survive. Objects deep-merge; arrays/scalars replace. Refuses key changes. Writes the updated group_*.json.",
      inputSchema: {
        groupKey: z.string(),
        fieldKey: z.string(),
        patch: z.record(z.string(), z.unknown()),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, fieldKey, patch, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const result = updateField(idx, groupKey, fieldKey, patch);
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const gr = resolveOneGroup(idx, groupKey);
      if ("error" in gr) return fail(gr.error);
      const g = gr.group;
      writeGroupFile(g._file, result.updatedGroup as unknown as Record<string, unknown>);
      invalidateIndex();
      const summary = `Updated field ${fieldKey} in ${groupKey} (${Object.keys(patch).join(", ")}).`;
      return ok(summary, { fieldKey, groupKey, file: g._file });
    }),
  );

  // --- Tool 13: acf_add_layout ------------------------------------------------
  server.registerTool(
    "acf_add_layout",
    {
      description:
        "Add a new empty layout to a flexible-content field (mints a collision-free layout key). Writes the updated group_*.json.",
      inputSchema: {
        groupKey: z.string(),
        flexFieldKey: z.string(),
        name: z.string(),
        label: z.string(),
        display: z.enum(["block", "row", "table"]).optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, flexFieldKey, name, label, display, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const result = addLayout(idx, groupKey, flexFieldKey, name, label, display ?? "block");
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const gr = resolveOneGroup(idx, groupKey);
      if ("error" in gr) return fail(gr.error);
      const g = gr.group;
      writeGroupFile(g._file, result.updatedGroup as unknown as Record<string, unknown>);
      invalidateIndex();
      const summary = `Added layout ${result.newLayoutKey} (${name}) to ${flexFieldKey} in ${groupKey}.`;
      return ok(summary, { newLayoutKey: result.newLayoutKey, groupKey, file: g._file });
    }),
  );

  // --- Tool 14: acf_remove_layout --------------------------------------------
  server.registerTool(
    "acf_remove_layout",
    {
      description:
        "Remove a layout (by key) and all its sub_fields from its flexible-content field. Writes the updated group_*.json.",
      inputSchema: {
        groupKey: z.string(),
        layoutKey: z.string(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, layoutKey, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const result = removeLayout(idx, groupKey, layoutKey);
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const gr = resolveOneGroup(idx, groupKey);
      if ("error" in gr) return fail(gr.error);
      const g = gr.group;
      writeGroupFile(g._file, result.updatedGroup as unknown as Record<string, unknown>);
      invalidateIndex();
      const summary = `Removed layout ${layoutKey} from ${groupKey}.`;
      return ok(summary, { layoutKey, groupKey, file: g._file });
    }),
  );

  // --- Tool 15: acf_reorder_layout -------------------------------------------
  server.registerTool(
    "acf_reorder_layout",
    {
      description:
        "Move a layout to a new position within its flexible-content field's layout order. toIndex is 0-based and clamped. Writes the updated group_*.json.",
      inputSchema: {
        groupKey: z.string(),
        layoutKey: z.string(),
        toIndex: z.number().int(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, layoutKey, toIndex, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const result = reorderLayout(idx, groupKey, layoutKey, toIndex);
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const gr = resolveOneGroup(idx, groupKey);
      if ("error" in gr) return fail(gr.error);
      const g = gr.group;
      writeGroupFile(g._file, result.updatedGroup as unknown as Record<string, unknown>);
      invalidateIndex();
      const summary = `Reordered layout ${layoutKey} in ${groupKey}: index ${result.fromIndex} -> ${result.toIndex}.`;
      return ok(summary, { layoutKey, fromIndex: result.fromIndex, toIndex: result.toIndex, file: g._file });
    }),
  );

  // --- Tool 16: acf_rename_layout --------------------------------------------
  server.registerTool(
    "acf_rename_layout",
    {
      description:
        "Rename a flexible-content layout's name and/or label by key. The layout key is preserved so parent_layout back-refs and saved data survive. Writes the updated group_*.json.",
      inputSchema: {
        groupKey: z.string(),
        layoutKey: z.string(),
        newName: z.string().optional(),
        newLabel: z.string().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, layoutKey, newName, newLabel, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const result = renameLayout(idx, groupKey, layoutKey, newName ?? "", newLabel ?? "");
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const gr = resolveOneGroup(idx, groupKey);
      if ("error" in gr) return fail(gr.error);
      const g = gr.group;
      writeGroupFile(g._file, result.updatedGroup as unknown as Record<string, unknown>);
      invalidateIndex();
      const summary = `Renamed layout ${layoutKey} in ${groupKey}.`;
      return ok(summary, { layoutKey, groupKey, file: g._file });
    }),
  );

  // --- Tool 17: acf_create_group ---------------------------------------------
  server.registerTool(
    "acf_create_group",
    {
      description:
        "Create a new ACF field group (empty fields) with a minted group key, written to the project's acf-json dir. Set location rules / position / active up front. dryRun previews without writing.",
      inputSchema: {
        title: z.string(),
        location: z.array(z.unknown()).optional(),
        position: z.string().optional(),
        style: z.string().optional(),
        menuOrder: z.number().int().optional(),
        active: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ title, location, position, style, menuOrder, active, dryRun, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const dr = dryRun === true;
      const idx = getIndex(root);
      const dirs = findAcfJsonDirs(root);
      if (dirs.length === 0) return fail(`no acf-json directory found under ${root}`);
      const result = createGroup(idx, { title, location, position, style, menuOrder, active });
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const file = join(dirs[0] ?? "", `${result.key}.json`);
      const summary = `Created group ${result.key} ("${title}") at ${file}.`;
      const r = commit([{ file, group: result.group as unknown as Record<string, unknown> }], dr, summary, { groupKey: result.key });
      return ok(r.content[0]?.text ?? summary, r.details);
    }),
  );

  // --- Tool 18: acf_delete_group ---------------------------------------------
  server.registerTool(
    "acf_delete_group",
    {
      description:
        "Delete a field group's group_*.json file by key. dryRun previews. Clone/conditional references to this group's fields elsewhere are NOT auto-fixed — run acf_validate after.",
      inputSchema: {
        groupKey: z.string(),
        dryRun: z.boolean().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, dryRun, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const dr = dryRun === true;
      const idx = getIndex(root);
      const gr = resolveOneGroup(idx, groupKey);
      if ("error" in gr) return fail(gr.error);
      const g = gr.group;
      const summary = `${dr ? "Would delete" : "Deleted"} group ${groupKey} (${g._file}).`;
      if (dr) return ok("DRY RUN — no files written.\n" + summary, { dryRun: true, groupKey, file: g._file });
      unlinkSync(g._file);
      invalidateIndex();
      return ok(summary, { groupKey, file: g._file });
    }),
  );

  // --- Tool 19: acf_update_group_settings ------------------------------------
  server.registerTool(
    "acf_update_group_settings",
    {
      description:
        "Edit a group's top-level settings IN PLACE (title, location, position, style, menu_order, active, hide_on_screen, label_placement, instruction_placement, description). Refuses key/fields changes. Objects deep-merge. dryRun previews.",
      inputSchema: {
        groupKey: z.string(),
        patch: z.record(z.string(), z.unknown()),
        dryRun: z.boolean().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, patch, dryRun, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const dr = dryRun === true;
      const idx = getIndex(root);
      const result = updateGroupSettings(idx, groupKey, patch);
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const gr = resolveOneGroup(idx, groupKey);
      if ("error" in gr) return fail(gr.error);
      const g = gr.group;
      const summary = `Updated group settings on ${groupKey} (${Object.keys(patch).join(", ")}).`;
      const r = commit([{ file: g._file, group: result.updatedGroup as unknown as Record<string, unknown> }], dr, summary, { groupKey });
      return ok(r.content[0]?.text ?? summary, r.details);
    }),
  );

  // --- Tool 20: acf_rename_field ---------------------------------------------
  server.registerTool(
    "acf_rename_field",
    {
      description:
        "Rename a field's name and/or key. A key change rewrites every parent_repeater/parent_layout/clone/conditional_logic reference across ALL groups (writes each changed file). A name change is local. dryRun previews.",
      inputSchema: {
        groupKey: z.string(),
        fieldKey: z.string(),
        newName: z.string().optional(),
        newKey: z.string().optional(),
        dryRun: z.boolean().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, fieldKey, newName, newKey, dryRun, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const dr = dryRun === true;
      const idx = getIndex(root);
      const result = renameField(idx, groupKey, fieldKey, { newName, newKey });
      if (result.errors.length > 0) return fail(result.errors.join("; "));
      const entries = result.updatedGroups.map((ug) => ({ file: ug._file, group: ug as unknown as Record<string, unknown> }));
      const summary = `Renamed field ${fieldKey} in ${groupKey}${newKey ? ` -> ${newKey}` : ""}${newName ? ` (name: ${newName})` : ""}; ${entries.length} file(s) affected.`;
      const r = commit(entries, dr, summary, { fieldKey, newKey, newName });
      return ok(r.content[0]?.text ?? summary, r.details);
    }),
  );

  // --- Tool 21: acf_outline ---------------------------------------------------
  server.registerTool(
    "acf_outline",
    {
      description:
        "Compact tree (key/type/name/nesting) of one group or all groups — orient without reading the full JSON.",
      inputSchema: {
        groupKey: z.string().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ groupKey, projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const text = outline(idx, groupKey);
      return ok(text.length > 0 ? text : "No groups found.", { groupCount: idx.groups.length });
    }),
  );

  // --- Tool 22: acf_list_groups -----------------------------------------------
  server.registerTool(
    "acf_list_groups",
    {
      description:
        "List all loaded field groups: key, title, top-level field count, location rule-group count, file path.",
      inputSchema: {
        projectRoot: z.string().optional(),
      },
    },
    async ({ projectRoot }) => guard(() => {
      const root = resolveProjectRoot({ projectRoot }, ctxCwd());
      const idx = getIndex(root);
      const lines = idx.groups.map((g) => {
        const fields = Array.isArray(g.fields) ? g.fields.length : 0;
        const loc = Array.isArray(g.location) ? g.location.length : 0;
        return `${g.key}  "${g.title}"  fields=${fields}  locationGroups=${loc}  ${g._file}`;
      });
      return ok(lines.length > 0 ? lines.join("\n") : "No groups found.", { groupCount: idx.groups.length });
    }),
  );
}