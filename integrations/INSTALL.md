# Agentic Browser Harness integration

Requires Node.js 24+ and a running version-matched Agentic Browser. The integration archive does not include a browser installer. Source repository access is private. Do not claim an unavailable installer has been installed.

## Choose a space / 选择空间

Open the browser, create a task space, then identify the correct browser window’s private discovery file. Normal launches write `agentic-poc-<window-id>.json` inside that Profile directory; developer `npm run spaces` writes `agentic-poc.json` in its isolated test Profile. Do not choose another Profile automatically.

```sh
node scripts/bind-space.mjs --discovery /absolute/profile/agentic-poc-WINDOW.json --list
node scripts/bind-space.mjs --discovery /absolute/profile/agentic-poc-WINDOW.json --number 1 --output /absolute/private/connection.json
```

The new file is mode 0600 and contains only one space capability. Existing files are never overwritten. UI numbers may be recycled; the capability remains bound to the original space ID. Rebind explicitly after browser restart or space deletion. Main Space cannot be selected.

## Codex plugin

Unpack the kit to a stable private directory. Install its dependencies before the plugin manager copies it:

```sh
npm ci --ignore-scripts --prefix plugins/agentic-browser
codex plugin marketplace add /absolute/path/to/kit
codex plugin add agentic-browser@agentic-browser
```

The plugin includes the canonical Skill and stdio MCP. By default its MCP reads `~/.config/agentic-browser/connection.json`. Bind to that exact path above for the first installation, or set the Harness process environment `AGENTIC_BROWSER_CONNECTION` to another private connection file. Never store the token itself in configuration or chat. For two Harnesses, use separate environment paths and separate authorized spaces.

For a source checkout instead of a kit, run `npm ci --ignore-scripts` in the project and **build the kit first** with `npm run integration:pack`; do not install source symlinks into a plugin cache.

## Claude Code plugin

```sh
npm ci --ignore-scripts --prefix plugins/agentic-browser
claude plugin marketplace add /absolute/path/to/kit
claude plugin install agentic-browser@agentic-browser
```

Uses the same private binding and canonical Skill. Check the current Harness CLI’s help before changing user configuration; preserve existing plugins and MCP entries. Restart the Harness if needed for discovery. Do not install an additional standalone Skill when using a plugin.

## Other Harnesses / 通用 MCP

Copy `plugins/agentic-browser/skills/agentic-browser/` into the Harness’s supported Skill location. Configure one stdio server (absolute paths):

```json
{"mcpServers":{"agentic-browser-space":{"command":"node","args":["/absolute/kit/plugins/agentic-browser/src/mcp.ts","--connection","/absolute/private/connection.json"]}}}
```

Different Harnesses have different configuration formats; merge only this entry, never replace the whole configuration. This JSON is a template, not a universal configuration file. Global is the default installation scope unless the user requests project-only.

## Minimal acceptance / 最小验收

Read MCP resource `agentic-browser://guide`; discover 18 tools. Observe → claim → snapshot a harmless local page → click/fill a permitted field → observe the result → release. Main and another space must remain inaccessible. On human takeover, stop and wait for explicit return; resume with the old ownership proof and use the new generation.

Locally verified: real stdio MCP initialization, semantic snapshot/click/fill, stale-reference rejection, screenshot, space-local tabs and main-space rejection. Plugin manifests and packaged runtime are checked separately; successful packaging alone does not prove installation in every Harness. Unsupported: raw CDP, arbitrary JavaScript, cross-origin frame traversal, dialogs, downloads and uploads. The model is not connected.
