// Shared test harness: spawn the bundled server over stdio, send JSON-RPC,
// collect responses by id. Used by smoke/mutation/write tests.

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SERVER = resolve(import.meta.dirname, "../dist/index.js");

export function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

export function startHarness(projectRoot, opts = {}) {
  const env = { ...process.env };
  delete env.ACF_JSON_PROJECT_ROOT;
  delete env.CLAUDE_PROJECT_DIR;
  if (projectRoot != null) env.ACF_JSON_PROJECT_ROOT = projectRoot;
  if (opts.env) Object.assign(env, opts.env);
  const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"], env });

  const { promise, resolve: finish, reject } = Promise.withResolvers();
  let buf = "";
  const want = new Set();
  const got = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id === "number" && want.has(msg.id)) {
        got.set(msg.id, msg);
        want.delete(msg.id);
        if (want.size === 0) finish();
      }
    }
  });
  child.stderr.on("data", (d) => console.error("[server stderr]", d.toString()));
  child.on("error", reject);
  child.on("exit", (code) => { if (want.size > 0) reject(new Error(`server exited code=${code} with ${want.size} pending`)); });

  return {
    child,
    call: (id, method, params) => { want.add(id); child.stdin.write(rpc(id, method, params)); },
    wait: () => promise,
    get: (id) => got.get(id),
    kill: () => child.kill(),
  };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}