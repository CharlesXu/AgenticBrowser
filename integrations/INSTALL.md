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

The plugin includes the canonical Skill and stdio MCP. The Codex plugin reads `~/.config/agentic-browser/codex.json`; Claude Code reads `~/.config/agentic-browser/claude.json`. Bind each to a different authorized task space using the commands above, or set the Harness process environment `AGENTIC_BROWSER_CONNECTION` to another private connection file. Never store the token itself in configuration or chat. For two Harnesses, keep the separate defaults or use separate environment paths and authorized spaces.

For a source checkout instead of a kit, run `npm ci --ignore-scripts` in the project and **build the kit first** with `npm run integration:pack`; do not install source symlinks into a plugin cache.

## Claude Code plugin

```sh
npm ci --ignore-scripts --prefix plugins/agentic-browser
claude plugin marketplace add /absolute/path/to/kit
claude plugin install agentic-browser@agentic-browser
```

Uses its own private `claude.json` binding and the same canonical Skill. Check the current Harness CLI’s help before changing user configuration; preserve existing plugins and MCP entries. Restart the Harness if needed for discovery. Do not install an additional standalone Skill when using a plugin.

## Other Harnesses / 通用 MCP

Copy `plugins/agentic-browser/skills/agentic-browser/` into the Harness’s supported Skill location. Configure one stdio server (absolute paths):

```json
{"mcpServers":{"agentic-browser-space":{"command":"node","args":["/absolute/kit/plugins/agentic-browser/src/mcp.ts","--connection","/absolute/private/connection.json"]}}}
```

Different Harnesses have different configuration formats; merge only this entry, never replace the whole configuration. This JSON is a template, not a universal configuration file. Global is the default installation scope unless the user requests project-only.

## Minimal acceptance / 最小验收

Read MCP resource `agentic-browser://guide`; discover 33 tools. Observe → claim → page_snapshot a harmless local page → click/fill a permitted field → observe the result → release. Main and another space must remain inaccessible. On human takeover, stop and wait for explicit return; resume with the old ownership proof and use the new generation.

Implemented: semantic selectors/references, same-origin and cross-origin frames, form controls and contenteditable, bounded waits and page JavaScript, dialogs, file chooser/upload, owned downloads, screenshots and page-local protocol. See the packaged Skill for exact APIs and remaining limits. Global CDP, main-space access and Profile-wide mutation are denied. Successful packaging does not prove installation in every Harness. The model is not connected.

Verified on 2026-10-23: user-level plugin 0.2.1 in Codex 0.163.0 and Claude Code 2.1.251. Both native Harness runtimes discovered the Skill and 33 MCP tools, then performed Chinese fill/click, handoff, rejection while human-controlled, native UI return, resume and release in separate authorized spaces. This was a runtime integration check with zero model turns; other Harness versions and autonomous model behavior are not covered.

For Node scripts, use `plugins/agentic-browser/src/page.mjs`, or run `node plugins/agentic-browser/src/agentic-browser.mjs run --connection /absolute/private/connection.json /absolute/script.mjs`. The script exports `default async function(task)`; the CLI claims and releases the authorized space. `skill` prints the version-matched guide.
