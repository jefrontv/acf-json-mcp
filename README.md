# acf-json-mcp

An [MCP](https://modelcontextprotocol.io) server for safely editing Advanced Custom Fields (ACF) `acf-json/*.json` field groups from any coding AI agent — Claude Code, Cursor, Continue, Zed, or any MCP-compatible harness.

Generates collision-free keys, applies type-correct defaults, keeps `parent_repeater`/`parent_layout` back-refs correct, validates structure, bumps `modified`, and syncs into the WordPress database — without hand-editing JSON.

## Why

ACF's local JSON sync is the right workflow for version-controlling field groups, but hand-editing the JSON is fragile:

- **Keys** (`group_<13hex>`, `field_<13hex>`, `layout_<13hex>`) follow PHP `uniqid('', true)`. A made-up key collides with an existing one and desyncs ACF.
- Each field type has its own required keys + defaults. Missing one silently breaks the field.
- Back-refs must stay in sync: `parent_repeater` on repeater children, `parent_layout` on flexible-content layout children.
- JSON edits don't take effect in WP until **admin "Sync available"** — this server can trigger that via `acf_sync`.

The 22 `acf_*` tools do the structural work safely; `acf_sync` closes the DB-sync gap.

## Tools (22, model-callable)

| Tool | Purpose |
| --- | --- |
| `acf_generate_key` | Mint a collision-free `group_`/`field_`/`layout_` key (`uniqid('', true)` 13-hex), verified against all loaded keys. |
| `acf_find_field` | Locate fields by `name`, `key`, `type`, name-substring (`nameContains`), and/or `groupKey` (filters combine); returns file, parent chain, full object. |
| `acf_validate` | Schema-validate one group or all: key format, collisions, `parent_repeater` resolution, `clone` targets, `layouts` dict shape, `conditional_logic` refs, `acfe_autosync`. Severity-tagged findings. |
| `acf_references` | Reference graph: clone / `parent_repeater` / `conditional_logic` edges with resolution status. |
| `acf_add_field` | Build a type-correct field (templated types get type-specific defaults; any other recognised ACF/PRO/ACFE type is accepted with base defaults) and insert it top-level, into a repeater's/group's `sub_fields` (`parent_repeater`), or a flex layout's `sub_fields` (`parent_layout`). |
| `acf_move_field` | Relocate a field between groups/parents — including parents nested inside flexible-content — preserving its key, setting the correct back-ref and stripping stale ones. |
| `acf_clone_layout` | Deep-copy a flexible-content layout: new layout key, regenerated child + nested-layout keys, with back-refs + `conditional_logic` remapped to the new keys (external `clone` targets untouched). |
| `acf_sync` | Sync `acf-json/*.json` into the DB via `wp acf json sync` (ACF PRO), a `wp eval` fallback, or instructions for the `ocsites` MCP tool when `wp` is unavailable. |
| `acf_remove_field` | Remove a field by key from a group/repeater/layout; scrubs same-group `conditional_logic`; reports clone referrers (or removes them with `scrubClones`); `dryRun` previews. |
| `acf_reorder_field` | Move a field to a new index within its current parent (group fields, a repeater's or layout's `sub_fields`). |
| `acf_repair` | Strip dangling `parent_repeater`/`parent_layout` back-refs (refs that don't resolve in the same group) from one group or all. |
| `acf_update_field` | Edit an existing field's props IN PLACE by key — preserves the key so saved post-meta + back-refs survive (objects deep-merge; arrays/scalars replace; refuses key changes). |
| `acf_add_layout` | Add a new empty layout to a flexible-content field (mints a collision-free layout key). |
| `acf_remove_layout` | Remove a layout (and its `sub_fields`) from its flexible-content field. |
| `acf_reorder_layout` | Reorder a layout within its flexible-content field's layout order. |
| `acf_rename_layout` | Rename a layout's `name`/`label` by key (key preserved → `parent_layout` back-refs + data survive). |
| `acf_create_group` | Create a new field group (minted key, empty fields, location/position/active up front), written to the acf-json dir. `dryRun` previews. |
| `acf_delete_group` | Delete a field group's `group_*.json` by key. `dryRun` previews. |
| `acf_update_group_settings` | Edit a group's top-level settings in place (title, location, position, active, …); deep-merges; refuses key/fields changes; `dryRun` previews. |
| `acf_rename_field` | Rename a field's `name` and/or `key`; a key change rewrites every `parent_*`/`clone`/`conditional_logic` ref across all groups. `dryRun` previews. |
| `acf_outline` | Compact tree (key/type/name/nesting) of one group or all — orient without reading the full JSON. |
| `acf_list_groups` | List all groups: key, title, field count, location-rule-group count, file path. |

All tools take an optional `projectRoot` (default: the `ACF_JSON_PROJECT_ROOT` env var, or the server's working directory). Mutating tools bump `modified`, write **atomically** (temp + rename — a multi-file move/repair never half-applies), and accept `dryRun` to preview the would-be writes without touching disk.

## Install

### Prerequisites

- [Node.js](https://nodejs.org) ≥ 20 (runtime). No Bun required.
- A project containing an `acf-json/` directory (ACF PRO local JSON sync).

### One-line installer (clone + build + register with Claude Code)

Private Bitbucket repo → use SSH clone, not `npx <raw-url>` (raw URLs return 404 to unauthenticated fetches):

```sh
git clone git@bitbucket.org:efront_au/acf-json-mcp.git && cd acf-json-mcp && npm run install:claude
```

What it does:
1. Clones the repo (you're already in it after clone).
2. `npm install --ignore-scripts` (skips the `postinstall` hook so it doesn't pre-register with the wrong project root).
3. `npm run build` → `dist/index.js`.
4. Registers with Claude Code via `claude mcp add` (default scope: `user`, project root = cwd).

Run from inside an existing clone:
```sh
npm run install:claude
```

Flags (pass after `--`):
- `--dest <path>` — clone destination (default: detected from cwd when run inside a checkout, else `~/Documents/Sites/acf-json-mcp`).
- `--project-root <path>` — WP project root passed to the server (default: `ACF_JSON_PROJECT_ROOT` env or cwd).
- `--scope <local|user|project>` — Claude Code scope (default: `user`).

```sh
# pin to a specific WP project
npm run install:claude -- --project-root ~/Sites/my-wp-theme

# register for current project only
npm run install:claude -- --scope local
```

Idempotent: re-running skips the clone, rebuilds, and treats "already registered" as success. The `claude` CLI is optional — if missing, the installer stops after build and prints the manual registration command.

### Manual

```sh
git clone git@bitbucket.org:efront_au/acf-json-mcp.git && cd acf-json-mcp
npm install
npm run build      # -> dist/index.js (bundled, self-contained)
```

`dist/index.js` is a single ESM bundle with all deps inlined. Run it with plain `node`; users never need Bun, esbuild, or the source tree.

## Register with Claude Code

### Automatic (recommended)

```sh
npm run add-claude
```

Resolves `dist/index.js`, detects the project root (`ACF_JSON_PROJECT_ROOT` env or cwd), and runs `claude mcp add` for you. Flags:

- `--project-root /abs/path` — override the WP project root
- `--scope local` — current project only (default: `user` = all projects)
- `--scope project` — write to `.mcp.json` in cwd (committable, shared with team)

```sh
# override to current-project-only
npm run add-claude -- --scope local

# pin to a specific WP project
npm run add-claude -- --project-root /Users/me/Sites/my-wp-theme
```

Verify: `claude mcp list`. Remove: `claude mcp remove acf-json`.

### Manual

Add to `~/.config/claude-code/config.json` (or your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "acf-json": {
      "command": "node",
      "args": ["/absolute/path/to/acf-json-mcp/dist/index.js"],
      "env": {
        "ACF_JSON_PROJECT_ROOT": "/absolute/path/to/your/wp-project"
      }
    }
  }
}
```

Omit `ACF_JSON_PROJECT_ROOT` to default to the server's `process.cwd()` (useful when each project launches its own MCP instance via a project-level `.mcp.json`).

### Cursor

`Settings → MCP → Add MCP Server`:

```json
{
  "acf-json": {
    "command": "node",
    "args": ["/absolute/path/to/acf-json-mcp/dist/index.js"],
    "env": {
      "ACF_JSON_PROJECT_ROOT": "/absolute/path/to/your/wp-project"
    }
  }
}
```

### Any MCP client (stdio)

The server speaks stdio MCP. Launch it directly:

```sh
ACF_JSON_PROJECT_ROOT=/path/to/wp-project node /path/to/acf-json-mcp/dist/index.js
```

### Run from source (optional, needs Bun)

If you have [Bun](https://bun.sh) ≥ 1.3 installed, you can skip the build step and run the TS directly:

```sh
bun run src/index.ts
```

Useful for development. The bundled `dist/index.js` is the recommended production path.

## Layout

```
acf-json-mcp/
├── src/
│   ├── index.ts      # MCP server entry: stdio transport
│   ├── tools.ts      # 22 tool registrations (the MCP adapter layer)
│   ├── helpers.ts    # index cache, atomic writes, output formatting, raw-record guards
│   ├── engine.ts     # pure engine: discovery, loader, key-gen, validator, reference graph, move/clone, templates (node builtins only)
│   └── sync.ts       # sync logic: wp acf json sync / wp eval fallback / ocsites instructions (node builtins only)
└── tests/
    ├── harness.mjs        # shared stdio JSON-RPC test harness
    ├── run-all.mjs        # runs all three suites in sequence
    ├── smoke.test.mjs     # boots server, list tools, list_groups, validate, generate_key
    ├── mutation.test.mjs  # dryRun create_group + outline
    └── write.test.mjs     # real acf_add_field disk write + modified stamp
```

`engine.ts` and `sync.ts` are pure TS (node builtins only — `fs`, `path`, `crypto`, `child_process`, `os`). `tools.ts` is the thin MCP adapter. Production runtime: Node ≥ 20 (bundled `dist/index.js`). Source dev: Bun ≥ 1.3 or Node ≥ 22.6 with `--experimental-strip-types`.

## Run the tests

Tests spawn the bundled server over stdio — build first, then run:

```sh
npm run build
npm test                         # all three suites
npm run test:smoke               # one suite at a time
npm run test:mutation
npm run test:write
npm run typecheck                 # tsc --noEmit (strict)
```

## How project root resolves

Each tool call resolves the project root in this order:

1. The `projectRoot` argument passed to the tool (if provided).
2. The `ACF_JSON_PROJECT_ROOT` env var (set per-client).
3. The server's `process.cwd()`.

This lets one server serve multiple projects (pass `projectRoot` per call), or pin a single project via env.

## Provenance

The engine + sync logic are ported verbatim from the [oh-my-pi](https://github.com/ogulcancelik/oh-my-pi) `acf-json` extension (`~/.omp/agent/extensions/acf-json`). The OMP extension wraps the same logic as 22 tools + a `tool_call` guard that blocks raw `write`/`edit` to `group_*.json`. This MCP server exposes the same 22 tools over stdio MCP; the `tool_call` guard is harness-side and not part of the server (configure it in your agent if you want enforced no-hand-edit).

## ACF facts the toolset relies on

- **Key format**: `group_`/`field_`/`layout_` + 13 hex chars = `uniqid('', true)` (8-char time + 5-char entropy). Some legacy 12-char field keys exist in the wild.
- **Back-refs**: `parent_repeater` = the parent repeater's key (repeater children); `parent_layout` = the layout's key (flexible-content layout children) — confirmed in ACF PRO source (`class-acf-field-flexible-content.php`). All refs (clone / parent_* / conditional_logic) resolve by **exact key string**, not uniqid format, so readable/legacy keys are valid and resolvable.
- **`layouts`** (flexible content): a **dict** keyed by layout key, not an array.
- **`clone`**: a `clone` field's `clone` array references `group_`/`field_` keys elsewhere in the index.
- **`acfe_autosync`** (ACF Extended): should contain `"json"` for local JSON sync to fire automatically.
- **Sync**: `wp acf json sync` is the ACF PRO WP-CLI command. `wp acf json status` is the read-only probe. `--dry-run` + `--key=<key>` flags supported.
- **`modified`**: group-level Unix epoch seconds. Every mutating tool bumps it on write so ACF/admin sees the change.// test update marker
