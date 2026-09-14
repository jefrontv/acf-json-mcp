// Shared test harness: spawn the server over stdio, send JSON-RPC, collect
// responses by id. Used by every test file.
//
// Defaults to the bundled dist/index.js. Set ACF_MCP_SERVER to a path to run
// against something else — point it at src/index.ts (run through bun) to test
// uncompiled sources when dist is stale.

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SERVER = process.env.ACF_MCP_SERVER
  ? resolve(process.env.ACF_MCP_SERVER)
  : resolve(import.meta.dirname, "../dist/index.js");
const RUNTIME = SERVER.endsWith(".ts") ? "bun" : "node";

// The efront boilerplate theme, used as a real-world corpus by the smoke and
// write tests. Override with ACF_MCP_CORPUS when it lives elsewhere.
export const CORPUS = process.env.ACF_MCP_CORPUS
  ? resolve(process.env.ACF_MCP_CORPUS)
  : resolve(process.env.HOME ?? "", "Sites/efront-boilerplate-wordpress-theme");

export function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

export function startHarness(projectRoot, opts = {}) {
  const env = { ...process.env };
  delete env.ACF_JSON_PROJECT_ROOT;
  delete env.CLAUDE_PROJECT_DIR;
  if (projectRoot != null) env.ACF_JSON_PROJECT_ROOT = projectRoot;
  if (opts.env) Object.assign(env, opts.env);
  const child = spawn(RUNTIME, [SERVER], { stdio: ["pipe", "pipe", "pipe"], env });

  let buf = "";
  const want = new Set();
  const got = new Map();
  // One waiter list per pending `wait()`. The old single-promise harness
  // resolved once and then never blocked again, so a test that interleaved
  // call/wait rounds (create something, then act on the key it returned) ran
  // ahead of the server.
  let waiters = [];
  let failure = null;

  function settle() {
    if (want.size > 0) return;
    const pending = waiters;
    waiters = [];
    for (const w of pending) w.resolve();
  }
  function failAll(err) {
    failure = err;
    const pending = waiters;
    waiters = [];
    for (const w of pending) w.reject(err);
  }

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
        settle();
      }
    }
  });
  child.stderr.on("data", (d) => console.error("[server stderr]", d.toString()));
  child.on("error", (e) => failAll(e));
  child.on("exit", (code) => { if (want.size > 0) failAll(new Error(`server exited code=${code} with ${want.size} pending`)); });

  return {
    child,
    call: (id, method, params) => { want.add(id); child.stdin.write(rpc(id, method, params)); },
    wait: () => {
      if (failure) return Promise.reject(failure);
      if (want.size === 0) return Promise.resolve();
      const { promise, resolve: res, reject: rej } = Promise.withResolvers();
      waiters.push({ resolve: res, reject: rej });
      return promise;
    },
    get: (id) => got.get(id),
    kill: () => child.kill(),
  };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}