# Native plugin installation and Council Room

The root `plugin.json` and `mcp.json` use the portable Agent Plugins format.
`.codex-plugin/plugin.json` and `.mcp.json` provide Codex compatibility. The repository
marketplace is `.agents/plugins/marketplace.json`. Fourteen skills include the generic
workflow and thirteen role contracts. No auto-install hooks or npm release are implied.

## Local installation

Requires Node 22.16+ and a Codex build supporting plugin commands and MCP Apps resources.
Compile before installation:

```sh
npm ci --ignore-scripts
npm run build
codex plugin marketplace add /absolute/path/to/council-forge
codex plugin add council-forge@council-forge-local --json
codex plugin list --json
```

Use an already authorized host or a separate task-local `CODEX_HOME` for install testing.
Do not copy authentication. Reinstall after candidate changes and compare installed
manifest, compiled MCP/engine/adapter and UI hashes with the source build. A marketplace
listing alone is not proof the cached server is current. `scripts/plugin-smoke.mjs`
checks the installed server version through the actual official app-server.

Linux acceptance used Codex CLI 0.160.0 and a task-local host. Native discovery loaded
ten tools and all role skills, expanded the installed plugin root and invoked
`council_room` through `mcpServer/tool/call`. That proves installation and native tool
invocation, not embedded rendering in every desktop build. See VALIDATION.md.

## Operator admission

Direct CLI/MCP requires a trusted `COUNCIL_CONFIG`, configuration `liveEnabled:true`
and `COUNCIL_LIVE_ENABLED=true`. Models cannot supply or change these settings.

Portable plugin hosts forward native `PLUGIN_DATA`, not arbitrary parent environment
variables. Without operator files the plugin runs in offline mode. The operator places
`council.local.json` in that exact native directory, then separately creates
`admission.local.json` containing:

```json
{
  "liveEnabled": true,
  "configSha256": "<sha256 of the exact council.local.json bytes>",
  "permissionScope": "read_only"
}
```

Use restrictive local file permissions. A missing admission, hash mismatch or disabled
configuration leaves live execution off. An invalid admission fails closed. Restart the
MCP process after operator changes. Remove admission and restart to disable live work.
The plugin exposes no configuration writer, credential input, OAuth grant or top-up tool.
Provider authentication stays in the already authenticated Codex home referenced by the
operator. The install-test host itself need not be signed in to launch its MCP server.

## Native UI contract

`council_room` declares `ui://council-forge/room-v1.html` in its UI metadata. The resource
is self-contained HTML/CSS/JS with `text/html;profile=mcp-app` and no external resource
or connection domains. It uses the MCP Apps JSON-RPC bridge for initialization, tool
calls, status polling and cancellation. Configuration uses a separate non-rendering
tool so selection changes do not open another widget.

The room includes preset, exact per-role model/effort/count, language, mode, API ceiling,
supplied evidence, plan validation, run/cancel, progress, decision, objections, evidence
and receipts. Review roles remain mandatory. Switching a preset retains matching role pins; new roles require explicit
selections. It does not invent model defaults. Implementation roles provide advice only.
An uncertain run response disables replay and directs the user to inspect its status.

`npm run ui` remains the separate offline console. `/native-preview` renders the same
room component with no host bridge, no live call and no fixture run. Desktop/mobile
component screenshots are visual QA only. They are not native embedded-host E2E proof.

## Distribution limits

Local installation, GitHub distribution, npm publication and public plugin-directory
submission are different channels. ChatGPT web requires a reachable authenticated HTTPS
MCP service and the appropriate registration/review. No remote service, OAuth deployment,
security permission change or public-directory publication is included in this candidate.
