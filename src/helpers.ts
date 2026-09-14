// Shared helpers for the acf-json MCP tools: per-project index cache (with a
// disk fingerprint so external edits are never served stale), atomic batch
// writes (temp + rename — a multi-file move/repair never half-applies), output
// formatting, and raw-record navigation guards.
//
// Ported from the oh-my-pi acf-json extension's index.ts; the OMP tool_call
// guard is intentionally absent (an MCP server has no write/edit interception
// surface — that guard is harness-side, not server-side).

import { writeFileSync, renameSync, unlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, sep, basename } from "node:path";

import {
  loadIndex,
  stripSynthetic,
  ACF_FILE_RE,
  type LoadedIndex,
  type AcfGroup,
  type AcfUiObject,
  type Finding,
  type ReferenceEdge,
} from "./engine.ts";
import { type SyncResult } from "./sync.ts";

// ---------------------------------------------------------------------------
// Session index cache (module-scoped so tools don't re-scan the whole project
// tree on every call). Validated against disk on every read via a cheap
// fingerprint so an external change (hand-edit, git checkout, another process)
// is never served stale — nor written back over, which silently destroyed
// externally-added fields before this guard existed.
// ---------------------------------------------------------------------------

let cachedIndex: LoadedIndex | null = null;
let cachedRoot: string | null = null;
let cachedSig: string | null = null;

// Fingerprint the already-discovered acf-json dirs: each ACF JSON file's
// path + mtime + size. Re-reading these few dirs is far cheaper than the full
// project-tree walk loadIndex does, yet detects any edit/add/delete of a group
// or UI-object file. (A brand-new acf-json dir appearing mid-session is the one
// case this misses; it surfaces on the next full reload.)
export function indexSignature(idx: LoadedIndex): string {
  const parts: string[] = [];
  const dirs = new Set<string>([...idx.dirToGroups.keys(), ...idx.dirToUiObjects.keys()]);
  for (const dir of [...dirs].sort()) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((e) => ACF_FILE_RE.test(e)).sort();
    } catch {
      parts.push(`${dir}\u0000ERR`);
      continue;
    }
    for (const e of names) {
      const f = join(dir, e);
      try {
        const st = statSync(f);
        parts.push(`${f}\u0000${st.mtimeMs}\u0000${st.size}`);
      } catch {
        parts.push(`${f}\u0000GONE`);
      }
    }
  }
  return parts.join("\u0001");
}
export function getIndex(projectRoot: string): LoadedIndex {
  if (cachedIndex && cachedRoot === projectRoot && indexSignature(cachedIndex) === cachedSig) return cachedIndex;
  const fresh = loadIndex(projectRoot);
  cachedIndex = fresh;
  cachedRoot = projectRoot;
  cachedSig = indexSignature(fresh);
  return fresh;
}

export function invalidateIndex(): void {
  cachedIndex = null;
  cachedRoot = null;
  cachedSig = null;
}

// Remove stale *.acftmp left by a crashed atomic write.
export function sweepStaleTmps(dir: string): void {
  try {
    for (const e of readdirSync(dir)) {
      if (e.endsWith(".acftmp")) { try { unlinkSync(join(dir, e)); } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "No findings. All clean.";
  const bySev = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = bySev.get(f.severity) ?? [];
    list.push(f);
    bySev.set(f.severity, list);
  }
  const order = ["error", "warning", "info"];
  const lines: string[] = [];
  for (const sev of order) {
    const list = bySev.get(sev);
    if (!list || list.length === 0) continue;
    lines.push(`[${sev}] ${list.length}`);
    for (const f of list) {
      lines.push(`  ${f.file} ${f.path}: ${f.message}`);
    }
  }
  return lines.join("\n");
}

export function formatEdges(edges: ReferenceEdge[]): string {
  if (edges.length === 0) return "No reference edges.";
  const lines: string[] = [];
  for (const e of edges) {
    const toFile = e.to.file ? ` @ ${e.to.file}` : "";
    lines.push(`${e.from.key} --${e.kind}--> ${e.to.key} resolved=${e.to.resolved}${toFile}`);
  }
  return lines.join("\n");
}

export function formatSyncResult(res: SyncResult): string {
  const lines: string[] = [];
  lines.push(`ACF Sync — method=${res.method} ok=${res.ok}`);
  lines.push(res.message);
  if (res.perGroup && res.perGroup.length > 0) {
    lines.push("Per-group:");
    for (const g of res.perGroup) {
      const tail = g.error ? ` — ${g.error}` : "";
      lines.push(`  ${g.key}: ${g.status}${tail}`);
    }
  }
  if (res.method === "ocsites_instructions" && res.ocsitesPayload) {
    lines.push("ocsites payload:");
    lines.push(`  site: ${res.ocsitesPayload.site}`);
    lines.push(`  args:  ${JSON.stringify(res.ocsitesPayload.args)}`);
    lines.push("Call mcp__ocsites_run_wp_cli with the above to perform the sync.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Write helpers — strip the synthetic _file/_kind keys, 4-space indent,
// trailing nl. Used for field groups and UI objects alike; both are plain ACF
// JSON records that carry a `modified` stamp.
// ---------------------------------------------------------------------------

export function writeAcfFile(file: string, record: Record<string, unknown>): void {
  writeAcfFilesAtomic([{ file, group: record }]);
}

// Atomic batch write: stamp `modified`, write every record to a temp file, then
// rename them all into place. If any temp write fails, no original is touched —
// prevents the half-applied multi-file move/repair data-loss case.
export function writeAcfFilesAtomic(entries: Array<{ file: string; group: Record<string, unknown> }>): void {
  const tmps: Array<{ tmp: string; file: string }> = [];
  try {
    for (const e of entries) {
      const out = stripSynthetic(e.group);
      out["modified"] = Math.floor(Date.now() / 1000);
      const tmp = e.file + ".acftmp";
      writeFileSync(tmp, JSON.stringify(out, null, 4) + "\n");
      tmps.push({ tmp, file: e.file });
    }
    for (const t of tmps) renameSync(t.tmp, t.file);
  } catch (err) {
    for (const t of tmps) { try { if (existsSync(t.tmp)) unlinkSync(t.tmp); } catch { /* ignore cleanup error */ } }
    throw err;
  }
}

export type CommitResult = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };

// commit — write the entries atomically (or, when dryRun, return a preview of
// the would-be files without touching disk). Shared by mutating tools.
export function commit(
  entries: Array<{ file: string; group: Record<string, unknown> }>,
  dryRun: boolean,
  summary: string,
  details: Record<string, unknown>,
): CommitResult {
  if (dryRun) {
    const preview = entries.map((e) => ({ file: e.file, group: stripSynthetic(e.group) }));
    return { content: [{ type: "text", text: "DRY RUN — no files written.\n" + summary }], details: { ...details, dryRun: true, files: entries.map((e) => e.file), preview } };
  }
  writeAcfFilesAtomic(entries);
  invalidateIndex();
  return { content: [{ type: "text", text: summary }], details: { ...details, writtenFiles: entries.map((e) => e.file) } };
}

// ---------------------------------------------------------------------------
// Helpers for navigating the raw group record (boundary data — guards only)
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function findFieldByKey(group: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const fields = group["fields"];
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    if (isRecord(f) && f["key"] === key) return f;
    if (isRecord(f)) {
      const nested = findFieldByKeyNested(f, key);
      if (nested) return nested;
    }
  }
  return null;
}

export function findFieldByKeyNested(node: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(node)) return null;
  const subs = node["sub_fields"];
  if (Array.isArray(subs)) {
    for (const f of subs) {
      if (isRecord(f) && f["key"] === key) return f;
      if (isRecord(f)) {
        const nested = findFieldByKeyNested(f, key);
        if (nested) return nested;
      }
    }
  }
  return null;
}

// Find the flexible_content field whose `layouts` dict contains layoutKey.
export function findLayoutOwner(group: Record<string, unknown>, layoutKey: string): Record<string, unknown> | null {
  const fields = group["fields"];
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    if (isRecord(f)) {
      const nested = findLayoutOwnerNested(f, layoutKey);
      if (nested) return nested;
    }
  }
  return null;
}

export function findLayoutOwnerNested(node: unknown, layoutKey: string): Record<string, unknown> | null {
  if (!isRecord(node)) return null;
  const lays = node["layouts"];
  if (isRecord(lays) && layoutKey in lays) return node;
  const subs = node["sub_fields"];
  if (Array.isArray(subs)) {
    for (const f of subs) {
      if (isRecord(f)) {
        const nested = findLayoutOwnerNested(f, layoutKey);
        if (nested) return nested;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// resolveOneGroup — resolve EXACTLY one group by key for a mutation. The index
// merges every acf-json dir found under the project root, so the same group_
// key can legitimately appear in more than one file (a theme + its backup copy,
// a child theme, a plugin bundle). Silently writing to the first match leaves
// the other copies stale — a data-loss trap. A mutation targeting an ambiguous
// key is refused; the caller narrows projectRoot (or removes the duplicate).
// ---------------------------------------------------------------------------

export function resolveOneGroup(idx: LoadedIndex, groupKey: string): { group: AcfGroup } | { error: string } {
  const matches = idx.groups.filter((g) => g.key === groupKey);
  if (matches.length === 0) return { error: `group ${groupKey} not found` };
  if (matches.length > 1) {
    return {
      error:
        `group ${groupKey} is ambiguous — the same key exists in ${matches.length} files:\n  ` +
        matches.map((m) => m._file).join("\n  ") +
        `\nPass an explicit projectRoot that points at a single acf-json dir, or remove the duplicate copy before mutating.`,
    };
  }
  return { group: matches[0]! };
}

// resolveOneUiObject — same ambiguity guard as resolveOneGroup, for post types,
// taxonomies and options pages.
export function resolveOneUiObject(idx: LoadedIndex, key: string): { object: AcfUiObject } | { error: string } {
  const matches = idx.uiObjects.filter((o) => o.key === key);
  if (matches.length === 0) return { error: `UI object ${key} not found (post types, taxonomies and options pages are keyed post_type_/taxonomy_/ui_options_page_)` };
  if (matches.length > 1) {
    return {
      error:
        `${key} is ambiguous — the same key exists in ${matches.length} files:\n  ` +
        matches.map((m) => m._file).join("\n  ") +
        `\nPass an explicit projectRoot that points at a single acf-json dir, or remove the duplicate copy before mutating.`,
    };
  }
  return { object: matches[0]! };
}

// ---------------------------------------------------------------------------
// resolveProjectRoot — prefer explicit param, fall back to CWD env (set by the
// MCP client) or process.cwd().
// ---------------------------------------------------------------------------

export function resolveProjectRoot(params: { projectRoot?: string }, ctx: { cwd?: string }): string {
  if (typeof params.projectRoot === "string" && params.projectRoot.length > 0) return resolve(params.projectRoot);
  if (ctx?.cwd) return resolve(ctx.cwd);
  return resolve(process.cwd());
}