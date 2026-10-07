# Plugin packaging and remaining work

The root `plugin.json` uses the portable Agent Plugins format. `skills/council/SKILL.md`
contains the workflow. `mcp.json` declares the local stdio server. A compatibility
`.codex-plugin/plugin.json` and `.mcp.json` are also included. `.agents/plugins/marketplace.json`
exposes the repository root as a local plugin source.

First install dependencies and compile with `npm ci --ignore-scripts && npm run build`.
The package does not use auto-install hooks or publish a fictitious npm release.
The stdio command expects the host to expand `${PLUGIN_ROOT}`; verify that expansion and
the installed dependency paths on the target Codex build. A strict/manual test can call
`node /absolute/path/to/council-forge/dist/mcp.js` through the host's normal MCP setup.

No existing personal marketplace or Codex configuration has been modified by this
bootstrap. The package is **not yet installed or host-E2E-tested**. Portable schema checks
alone do not prove that a particular desktop build loaded the skill/server correctly.

For a repository marketplace, the official CLI supports adding `owner/repo` as a source;
use `offflinerpsy/council-forge` only after preparing the local runtime. Dependency copying
in host caches remains an integration test, not an assumed capability.

Local packaging, GitHub distribution, workspace publishing and the public plugin
directory are different release channels. A public GitHub repo does not publish the
plugin to the directory. ChatGPT web needs a reachable authenticated HTTPS MCP endpoint
and appropriate registration/review. This repository currently implements stdio only.

The `public/` interface is a local offline planning console. The planned live Council
Room will use MCP UI extensions, account-aware model discovery, per-agent status,
explanatory receipts, evidence coverage and unresolved objections. It must never display
an invented consensus percentage or present fixtures as live work. UI Extensions and
OAuth flows require their own implementation and integration tests.
