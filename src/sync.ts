// ACF JSON extension — Phase 3 (sync tool).
// Pure TS, node builtins only (node:child_process, node:fs, node:path, node:os).
// No OMP imports. Runs the ACF JSON -> DB sync via `wp acf json sync` (ACF PRO),
// falls back to `wp eval` calling acf_import_field_group(), or returns
// instructions for the ocsites MCP tool when `wp` / a WP install root is absent.
//
// Boundary-data rule: spawnSync results + parsed process output are `unknown`.
// Narrow with type guards (Buffer.isBuffer, typeof). No inline `as { … }` casts
// for property reads off untyped values.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SyncResult {
  ok: boolean;
  method: "wp_acf_json_sync" | "wp_eval_fallback" | "ocsites_instructions" | "no_acf_json_dir" | "wp_not_found";
  message: string;
  perGroup?: { key: string; status: "imported" | "updated" | "skipped" | "error"; error?: string }[];
  ocsitesPayload?: { site: string; args: string[] }; // only for ocsites_instructions
  rawStdout?: string;
  rawStderr?: string;
}

export interface SyncOpts {
  dryRun?: boolean;
  key?: string;
}

// ---------------------------------------------------------------------------
// buildWpCommand — returns the arg array for `wp acf json sync` (+ flags).
// Exported for testing without spawning.
// ---------------------------------------------------------------------------

export function buildWpCommand(opts: { dryRun?: boolean; key?: string }): string[] {
  const args = ["acf", "json", "sync"];
  if (opts.dryRun) args.push("--dry-run");
  if (typeof opts.key === "string" && opts.key.length > 0) args.push("--key=" + opts.key);
  return args;
}

// ---------------------------------------------------------------------------
// findWpRoot — walk UP from acfJsonDir looking for a dir containing
// wp-load.php OR wp-config.php. Max ~10 levels. Returns the dir or null.
// ---------------------------------------------------------------------------

export function findWpRoot(acfJsonDir: string): string | null {
  let dir = resolve(acfJsonDir);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "wp-load.php")) || existsSync(join(dir, "wp-config.php"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// findWpBinary — try `wp` bare (via PATH), then the two known absolute paths.
// Returns the path that exists + is executable, or null.
// ---------------------------------------------------------------------------

const WP_CANDIDATES = ["wp", "/opt/homebrew/bin/wp", "/usr/local/bin/wp", join(homedir(), ".local/bin/wp")];

function isExecutableBin(p: string): boolean {
  try {
    const st = existsSync(p);
    if (!st) return false;
    // For the bare `wp` we can't stat a real file; rely on spawnSync instead.
    return true;
  } catch {
    return false;
  }
}

export function findWpBinary(): string | null {
  // 1. Try `wp` bare via `which`-equivalent: spawn `wp --version` and check exit.
  const bare = spawnSync("wp", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (bare.status === 0) return "wp";
  // 2. Absolute-path candidates.
  for (const cand of WP_CANDIDATES) {
    if (cand === "wp") continue;
    if (!isExecutableBin(cand)) continue;
    const probe = spawnSync(cand, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    if (probe.status === 0) return cand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers: convert spawnSync Buffer-ish stdout/stderr to string via guards.
// ---------------------------------------------------------------------------

function bufToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return "";
}

// Narrow an unknown parsed value to a record (object, non-null, non-array).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// runAcfJsonStatus — read-only probe. Returns { ok, stdout, stderr }.
// ---------------------------------------------------------------------------

function runWp(wpBin: string, args: string[], wpCwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(wpBin, args, { cwd: wpCwd, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, stdout: bufToString(r.stdout), stderr: bufToString(r.stderr) };
}

// ---------------------------------------------------------------------------
// parsePerGroup — best-effort parse of `wp acf json sync` output for per-group
// status lines. ACF prints lines like "Synced group_abc123 (Label)". We don't
// over-fit; we just surface rawStdout + an aggregate message if unparseable.
// ---------------------------------------------------------------------------

function parsePerGroup(stdout: string): { key: string; status: "imported" | "updated" | "skipped" | "error"; error?: string }[] {
  // Best-effort: look for lines containing a group_<hex> token.
  const out: { key: string; status: "imported" | "updated" | "skipped" | "error"; error?: string }[] = [];
  const lines = stdout.split(/\r?\n/);
  const KEY_RE = /\b(group_[0-9a-fA-F]{12,13})\b/;
  for (const line of lines) {
    const m = line.match(KEY_RE);
    if (!m) continue;
    const key = m[1] ?? "";
    const lower = line.toLowerCase();
    let status: "imported" | "updated" | "skipped" | "error";
    if (lower.includes("error") || lower.includes("fail")) status = "error";
    else if (lower.includes("skip")) status = "skipped";
    else if (lower.includes("updat")) status = "updated";
    else status = "imported";
    out.push({ key, status, error: status === "error" ? line.trim() : undefined });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The wp eval fallback PHP snippet. Globs the acf-json dir per artifact kind
// and calls ACF's matching importer: acf_import_field_group() for field groups,
// acf_import_post_type() / acf_import_taxonomy() / acf_import_ui_options_page()
// for the ACF 6.1+ internal post types. Echoes one JSON status line per file.
// ---------------------------------------------------------------------------

// glob pattern -> ACF import function. Field groups first: a post type a group
// targets should exist before the group referencing it lands.
const IMPORTERS: Array<{ pattern: string; fn: string; ui: boolean }> = [
  { pattern: "group_*.json", fn: "acf_import_field_group", ui: false },
  { pattern: "post_type_*.json", fn: "acf_import_post_type", ui: true },
  { pattern: "taxonomy_*.json", fn: "acf_import_taxonomy", ui: true },
  { pattern: "ui_options_page_*.json", fn: "acf_import_ui_options_page", ui: true },
];

export type EvalScope = "all" | "ui";

export function buildEvalPhp(acfJsonAbsDir: string, scope: EvalScope): string {
  const targets = IMPORTERS.filter((t) => scope === "all" || t.ui);
  const phpTargets = targets.map((t) => `[${JSON.stringify(t.pattern)}, ${JSON.stringify(t.fn)}]`).join(", ");
  // PHP glob uses an absolute path so the eval doesn't depend on cwd.
  return `
<?php
\$dir = ${JSON.stringify(acfJsonAbsDir)};
\$targets = [${phpTargets}];
foreach (\$targets as \$target) {
  \$files = glob(\$dir . '/' . \$target[0]);
  \$fn = \$target[1];
  if (!is_array(\$files)) { continue; }
  foreach (\$files as \$f) {
    try {
      \$raw = file_get_contents(\$f);
      if (\$raw === false) { echo json_encode(['file' => basename(\$f), 'status' => 'error', 'error' => 'read failed']) . "\n"; continue; }
      \$data = json_decode(\$raw, true);
      if (!is_array(\$data)) { echo json_encode(['file' => basename(\$f), 'status' => 'error', 'error' => 'json decode failed']) . "\n"; continue; }
      if (!function_exists(\$fn)) { echo json_encode(['file' => basename(\$f), 'status' => 'error', 'error' => \$fn . ' missing — ACF version too old or ACF PRO inactive']) . "\n"; continue; }
      \$fn(\$data);
      echo json_encode(['file' => basename(\$f), 'status' => 'imported']) . "\n";
    } catch (\Throwable \$e) {
      echo json_encode(['file' => basename(\$f), 'status' => 'error', 'error' => \$e->getMessage()]) . "\n";
    }
  }
}
`.trim();
}

// Parse the one-JSON-line-per-file output the eval snippet echoes.
function parseEvalLines(stdout: string): { key: string; status: "imported" | "updated" | "skipped" | "error"; error?: string }[] {
  const out: { key: string; status: "imported" | "updated" | "skipped" | "error"; error?: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // not a JSON line; skip
    }
    if (!isRecord(obj)) continue;
    if (typeof obj["file"] !== "string") continue;
    const file = obj["file"];
    const statusStr = typeof obj["status"] === "string" ? obj["status"] : "error";
    const mapped: "imported" | "updated" | "skipped" | "error" =
      statusStr === "imported" || statusStr === "updated" || statusStr === "skipped" ? statusStr : "error";
    const err = typeof obj["error"] === "string" ? obj["error"] : undefined;
    out.push({ key: file, status: mapped, error: err });
  }
  return out;
}

// Does this acf-json dir hold any ACF 6.1+ UI objects? `wp acf json sync` only
// syncs field groups, so their presence means an extra import pass is needed.
function hasUiObjectFiles(acfJsonDir: string): boolean {
  try {
    return readdirSync(acfJsonDir).some((e) => /^(post_type|taxonomy|ui_options_page)_.*\.json$/.test(e));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// findAcfJsonDir — reuse engine's discovery via a dynamic import would create
// an OMP boundary; instead we replicate a minimal walk here (node builtins
// only, no engine import) to keep sync.ts decoupled + standalone-runnable.
// Walks at most a couple levels deep under projectRoot for an `acf-json` dir.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", ".cache", ".next", ".svelte-kit", "build"]);

function findAcfJsonDir(root: string): string | null {
  // Direct child first (most common: <root>/acf-json or <root>/wp-content/themes/<theme>/acf-json).
  try {
    const direct = join(root, "acf-json");
    if (existsSync(direct)) return direct;
  } catch { /* ignore */ }
  // BFS up to 4 levels deep.
  let frontier: string[] = [];
  try {
    frontier = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .map((e) => join(root, e.name));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const d of frontier) {
      const acf = join(d, "acf-json");
      if (existsSync(acf)) return acf;
      try {
        const subs = readdirSync(d, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
          .map((e) => join(d, e.name));
        next.push(...subs);
      } catch { /* ignore unreadable */ }
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// runSync — the main entry point.
// ---------------------------------------------------------------------------

export async function runSync(projectRoot: string, opts?: SyncOpts): Promise<SyncResult> {
  const dryRun = typeof opts?.dryRun === "boolean" ? opts.dryRun : false;
  const key = typeof opts?.key === "string" ? opts.key : undefined;

  // 1. Find acf-json/ dir.
  const acfDir = findAcfJsonDir(projectRoot);
  if (!acfDir) {
    return {
      ok: false,
      method: "no_acf_json_dir",
      message: `No acf-json/ directory found under ${projectRoot}.`,
    };
  }

  // 2. Resolve the WP install root (wpCwd). If none → ocsites_instructions.
  const wpRoot = findWpRoot(acfDir);
  if (!wpRoot) {
    return {
      ok: false,
      method: "ocsites_instructions",
      message:
        "No WordPress install root (wp-load.php) resolved by walking up from the acf-json dir. " +
        "Call mcp__ocsites_run_wp_cli with the site for this project and args: ['acf','json','sync']. " +
        "The agent should resolve the site via LocalWP sites.json matching projectRoot, then call ocsites.",
      ocsitesPayload: { site: "<agent resolves>", args: ["acf", "json", "sync"] },
    };
  }

  // 3. Probe wp availability.
  const wpBin = findWpBinary();
  if (!wpBin) {
    return {
      ok: false,
      method: "wp_not_found",
      message:
        "wp (WP-CLI) binary not found on PATH or at the known fallback paths " +
        "(/opt/homebrew/bin/wp, ~/.local/bin/wp). " +
        "Install WP-CLI or call mcp__ocsites_run_wp_cli with the site for this project and args: ['acf','json','sync'].",
      ocsitesPayload: { site: "<agent resolves>", args: ["acf", "json", "sync"] },
    };
  }

  // 4. Probe ACF PRO command: `wp acf json status` (read-only).
  const status = runWp(wpBin, ["acf", "json", "status"], wpRoot);
  const acfCmdKnown = status.status === 0;

  const hasUi = hasUiObjectFiles(acfDir);

  if (acfCmdKnown) {
    // 5. wp_acf_json_sync path. That command only knows about field groups, so
    // post types / taxonomies / options pages get a second import pass through
    // wp eval — otherwise they silently never reach the database.
    const syncArgs = buildWpCommand({ dryRun, key });
    const r = runWp(wpBin, syncArgs, wpRoot);
    const perGroup = parsePerGroup(r.stdout);
    let ok = r.status === 0;
    let uiNote = "";
    let uiStdout = "";
    let uiStderr = "";
    if (hasUi && !dryRun) {
      const rui = runWp(wpBin, ["eval", buildEvalPhp(acfDir, "ui")], wpRoot);
      const uiResults = parseEvalLines(rui.stdout);
      perGroup.push(...uiResults);
      uiStdout = rui.stdout;
      uiStderr = rui.stderr;
      if (rui.status !== 0) ok = false;
      uiNote = ` Imported ${uiResults.length} post type/taxonomy/options page file(s) via wp eval (wp acf json sync covers field groups only).`;
    } else if (hasUi && dryRun) {
      uiNote = " Post type/taxonomy/options page files were NOT touched — the eval importer they need has no dry-run.";
    }
    return {
      ok,
      method: "wp_acf_json_sync",
      message: ok
        ? `Synced acf-json/*.json into the database via wp acf json sync${dryRun ? " (dry-run)" : ""}.${uiNote}`
        : `wp acf json sync exited non-zero (status=${r.status}).${uiNote}`,
      perGroup: perGroup.length > 0 ? perGroup : undefined,
      rawStdout: uiStdout ? r.stdout + "\n" + uiStdout : r.stdout,
      rawStderr: uiStderr ? r.stderr + "\n" + uiStderr : r.stderr,
    };
  }

  // 6. wp_eval_fallback path. `wp acf json` unknown → use wp eval for every
  // artifact kind: field groups, post types, taxonomies and options pages.
  const php = buildEvalPhp(acfDir, "all");
  const r = runWp(wpBin, ["eval", php], wpRoot);
  const perGroup = parseEvalLines(r.stdout);
  const ok = r.status === 0;
  return {
    ok,
    method: "wp_eval_fallback",
    message: ok
      ? `Imported acf-json/*.json via wp eval (acf_import_field_group / acf_import_post_type / acf_import_taxonomy / acf_import_ui_options_page)${dryRun ? " — note: dry-run is ignored by the eval fallback" : ""}.`
      : `wp eval fallback exited non-zero (status=${r.status}). ACF PRO wp-cli command was not available.`,
    perGroup: perGroup.length > 0 ? perGroup : undefined,
    rawStdout: r.stdout,
    rawStderr: r.stderr,
  };
}