#!/usr/bin/env node
// `npm run add-claude` — register this acf-json MCP server with Claude Code.
//
// Resolves the bundled dist/index.js absolute path, then shells out to
// `claude mcp add`. Auto-detects the project root: ACF_JSON_PROJECT_ROOT env
// (if set), else the current working directory. Pass --project-root to override.
//
// Usage:
//   npm run add-claude                           # cwd = WP project
//   npm run add-claude -- --project-root /abs/wp # explicit project
//   ACF_JSON_PROJECT_ROOT=/wp npm run add-claude
//
// Scope flags (Claude Code):
//   npm run add-claude -- --scope user          # all projects (default: local)
//   npm run add-claude -- --scope project       # .mcp.json in cwd

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "..", "dist", "index.js");

// Parse argv: --project-root <path>, --scope <local|user|project>
const args = process.argv.slice(2);
let projectRoot = process.env.ACF_JSON_PROJECT_ROOT ?? process.cwd();
let scope = "user";
let skipIfMissing = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project-root" && args[i + 1]) {
    projectRoot = resolve(args[++i]);
  } else if (args[i] === "--scope" && args[i + 1]) {
    scope = args[++i];
  } else if (args[i] === "--user") {
    scope = "user"; // legacy convenience flag
  } else if (args[i] === "--skip-if-missing") {
    skipIfMissing = true;
  }
}

if (!existsSync(serverPath)) {
  console.error(`Build output not found: ${serverPath}`);
  console.error("Run `npm run build` first.");
  process.exit(1);
}

// Build the claude mcp add command. Claude Code's `mcp add` takes:
//   claude mcp add <name> [--scope <s>] [--env KEY=VAL] -- <command> [args...]
const cmd = ["mcp", "add", "acf-json"];
if (scope) cmd.push("--scope", scope);
cmd.push("--env", `ACF_JSON_PROJECT_ROOT=${projectRoot}`);
cmd.push("--", "node", serverPath);

console.log(`Registering acf-json MCP server (scope=${scope})...`);
console.log(`  project root: ${projectRoot}`);
console.log(`  server:       ${serverPath}`);
console.log(`  $ claude ${cmd.join(" ")}`);

const r = spawnSync("claude", cmd, { stdio: "pipe", encoding: "utf8" });

if (r.error) {
  if (r.error.code === "ENOENT") {
    if (skipIfMissing) {
      // postinstall: user hasn't installed Claude Code yet — no-op.
      process.exit(0);
    }
    console.error("\nError: `claude` CLI not found on PATH.");
    console.error("Install Claude Code: https://claude.ai/download");
    process.exit(1);
  }
  throw r.error;
}

const out = (r.stdout ?? "") + (r.stderr ?? "");
if (r.status !== 0) {
  if (/already exists/i.test(out)) {
    console.log("\nacf-json already registered (skipped).");
    console.log("Remove first with:  claude mcp remove acf-json");
    process.exit(0);
  }
  process.stderr.write(out);
  console.error(`\nclaude mcp add failed (exit ${r.status}).`);
  process.exit(r.status ?? 1);
}
process.stdout.write(out);

console.log("\nDone. Verify with:  claude mcp list");
console.log("Remove with:        claude mcp remove acf-json");