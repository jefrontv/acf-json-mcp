#!/usr/bin/env node
// One-line installer for acf-json-mcp.
//
//   npx acf-json-mcp-installer                 # cwd = WP project
//   npx acf-json-mcp-installer --project-root /abs/wp
//   npx acf-json-mcp-installer --scope local
//
// Or from source (no npm publish needed):
//   node scripts/install.mjs
//
// What it does:
//   1. Clones efrent_au/acf-json-mcp into ~/Documents/Sites/acf-json-mcp
//      (or --dest <path>). Skips if already present.
//   2. npm install
//   3. npm run build -> dist/index.js
//   4. registers with Claude Code via `claude mcp add` (user scope by default)
//
// Exits 0 on success. Requires: git, node >= 20, npm. Claude Code CLI optional
// (warns + skips registration if missing).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "git@bitbucket.org:efront_au/acf-json-mcp.git";
const DEFAULT_DEST = resolve(process.env.HOME ?? "", "Documents/Sites/acf-json-mcp");
// If this script is being run from inside a checkout (scripts/install.mjs
// resolves under cwd), operate on that checkout rather than the default dest.
const __dirname = dirname(fileURLToPath(import.meta.url));
const IN_REPO = existsSync(resolve(process.cwd(), "package.json")) && existsSync(resolve(process.cwd(), "scripts", "install.mjs"));

const args = process.argv.slice(2);
let dest = IN_REPO ? process.cwd() : DEFAULT_DEST;
let projectRoot = process.env.ACF_JSON_PROJECT_ROOT ?? process.cwd();
let scope = "user";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dest" && args[i + 1]) dest = resolve(args[++i]);
  else if (args[i] === "--project-root" && args[i + 1]) projectRoot = resolve(args[++i]);
  else if (args[i] === "--scope" && args[i + 1]) scope = args[++i];
  else if (args[i] === "--user") scope = "user";
  else if (args[i] === "--local") scope = "local";
}

function run(cmd, cmdArgs, opts = {}) {
  const label = `${cmd} ${cmdArgs.join(" ")}`;
  const r = spawnSync(cmd, cmdArgs, { stdio: opts.silent ? "pipe" : "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`\nFailed: ${label} (exit ${r.status})`);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }
  return r;
}

function has(bin) {
  const r = spawnSync("which", [bin], { stdio: "pipe" });
  return r.status === 0;
}

console.log("acf-json-mcp installer\n");

// 1. Clone or update: if dest is already a checkout, pull latest; else clone.
if (existsSync(resolve(dest, ".git"))) {
  console.log(`1/4  pull: ${dest}`);
  run("git", ["-C", dest, "fetch", "origin"]);
  // Fast-forward only — never merge/rebase user's local work.
  run("git", ["-C", dest, "merge", "--ff-only", "origin/HEAD"]);
} else if (existsSync(resolve(dest, "package.json"))) {
  console.log(`1/4  clone: skip (non-git dir at ${dest})`);
  console.log("          remove it first if you want a fresh clone.");
} else {
  console.log(`1/4  clone: ${REPO} -> ${dest}`);
  mkdirSync(dirname(dest), { recursive: true });
  run("git", ["clone", REPO, dest]);
}

// 2. npm install
console.log(`2/4  npm install (in ${dest})`);
run("npm", ["install", "--ignore-scripts"], { cwd: dest });

// 3. build
console.log("3/4  build");
run("npm", ["run", "build"], { cwd: dest });

// 4. register with Claude Code
console.log("4/4  register with Claude Code");
if (!has("claude")) {
  console.log("     claude CLI not found — skipping registration.");
  console.log("     Install Claude Code: https://claude.ai/download");
  console.log(`     Then run:  cd ${dest} && npm run add-claude`);
  console.log("\nDone. Build ready at:  " + resolve(dest, "dist/index.js"));
  process.exit(0);
}

const serverPath = resolve(dest, "dist/index.js");
const cmd = ["mcp", "add", "acf-json", "--scope", scope, "--env", `ACF_JSON_PROJECT_ROOT=${projectRoot}`, "--", "node", serverPath];
console.log(`     scope:         ${scope}`);
console.log(`     project root:  ${projectRoot}`);
console.log(`     $ claude ${cmd.join(" ")}`);
const r = spawnSync("claude", cmd, { stdio: "pipe", encoding: "utf8" });
const stdout = (r.stdout ?? "") + (r.stderr ?? "");
if (r.status !== 0) {
  // Idempotent: "already exists" is success, not failure.
  if (/already exists/i.test(stdout)) {
    console.log("     already registered (skipped).");
  } else {
    console.error(stdout);
    console.error(`\nclaude mcp add failed (exit ${r.status}).`);
    console.error("You can retry manually:  npm run add-claude");
    process.exit(r.status ?? 1);
  }
} else {
  process.stdout.write(stdout);
}

console.log("\nDone.");
console.log("  Verify:   claude mcp list");
console.log("  Remove:   claude mcp remove acf-json");
console.log("  Server:   " + serverPath);