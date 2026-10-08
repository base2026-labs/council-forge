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

## Native continuation: version 0.1.0-alpha.3

The current package adds receipt reopening and a bounded native admission. In an installed
host call `council_room` with `{}` to compose, or with `{"runId":"<exact saved ID>"}`
to reopen a receipt. The Room's **Read saved receipt** control calls only `council_status`.
It never calls `council_run` to recover. Completed decisions retain their language,
proposals, review phases and native receipts. Interrupted/held/running records stay HOLD
and cannot be silently replaced by a different saved result. Keep the run ID shown before
dispatch; no private evidence or credentials are stored in browser storage.

An operator may use `PLUGIN_DATA/runtime.local.json` with
`{"stateNamespace":"<lowercase slug>"}` to select `PLUGIN_DATA/runs-<slug>`. This
explicit choice creates a separate result directory; it does not migrate, settle, delete
or reset older state. The default remains `PLUGIN_DATA/runs`. A new namespace is useful
when historical databases must remain byte-identical. It is not a way to disregard old
UNKNOWN exposure. The shared global coordinator still applies.

Discovery, planning and receipt reads do not open or migrate the shared paid ledger.
It is opened lazily when accounting is required, at the same global database path.
This preserves a legacy database during passive host inspection; it does not create
another pool or erase reservations. Actual provider work still uses shared leases.

For a namespaced native runtime, admission additionally requires `runtimeSha256`,
`runId` and `requestSha256`: hashes of the exact runtime file and the **normalized**
request returned by `council_plan`. A changed namespace/config/request or different run
ID is refused before any provider dispatch. The gate is a trusted operator file; UI
arguments cannot create it. Legacy non-namespaced admission remains compatible. Remove
admission and restart to disable live calls. An operator must separately reconcile or
explicitly retain historical uncertain exposure before authorizing a distinct acceptance.

The existing official app-server smoke has an explicit non-inference preflight:

```sh
node scripts/plugin-smoke.mjs <installed-codex-home> <marketplace-path> <request-json> --plan-only
```

This inspects discovery, an ephemeral host session, room invocation, mutation denials
and the exact plan. It never calls `turn/start` or `council_run`. Neither this CLI
operation nor `/native-preview` proves embedded rendering. ChatGPT needs an existing
reachable registered MCP service; a local stdio package cannot be mounted by a web
directory search. See [official UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui).
The current execution records the exact available host/session and remaining gates in
its coordinator preflight package. No live admission is shipped by the repository.
