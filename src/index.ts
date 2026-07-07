#!/usr/bin/env bun
// acf-json MCP server — exposes the acf-json engine (key gen, validation,
// field/layout/group mutations, reference graph, WP DB sync) as MCP tools.
//
// Transport: stdio (the Claude Code / Cursor / OMP MCP default).
//
// The engine (engine.ts) and sync logic (sync.ts) are pure TS with node-builtin
// deps only — copied verbatim from the oh-my-pi acf-json extension and reused
// unchanged. This file is the thin MCP adapter: it owns the per-project index
// cache, atomic writes, and the 22 tool handlers.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.ts";

const server = new McpServer({
  name: "acf-json",
  version: "0.1.0",
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);