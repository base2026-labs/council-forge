# Implementation handoff — 2026-10-07

Repository: `offflinerpsy/council-forge`. New, public, independently implemented MIT project.
Version: `0.1.0-alpha.1`. Do not describe this as a completed commercial product or an
already-installed ChatGPT/Codex plugin.

## Safe continuation

Do not search for, copy or export credentials. Do not activate paid inference just because
GitHub write permissions are enabled. The default external budget remains zero. Do not
change the owner's existing Jev/Codex profile or production projects while developing this
independent package. Use a dedicated local profile and approved non-private fixtures.

`npm ci --ignore-scripts`, `npm run check`, `npm run demo` and `npm run ui` are the
bootstrap validation paths. Test outcomes and executed environments belong in
`docs/VALIDATION.md`; do not infer successful live E2E from mocked HTTP/RPC tests.

Source files under `src/` are canonical. `dist/`, local databases and secret configuration
are ignored. Compile before using the local MCP server or planning console.

## Known alpha limits

- One protocol round, no adaptive model/agent replanning yet.
- Jev is aggregate-only advisory triage, not semantic verification or automatic model selection.
- API adapters have no external tools; evidence must already be supplied.
- Generic compatible endpoints without cost receipts are held for reconciliation.
- Codex-local transport is experimental and not yet live-validated; host schema/permission
  mismatches fail closed. No app-server auth is permitted as a commercial/hosted proxy.
- Portable plugin metadata is supplied, but host installation/dependency/root expansion
  must still be tested.
- The UI is an offline local planning console, not a registered MCP UI widget.
- Budget estimates cannot enforce provider invoices. The database limit is lifetime-scoped.
- One runtime per data directory; no distributed semaphore or hosted auth exists.
- Local SQLite results can contain private text and are not encrypted.

After a crash, first confirm the old process has exited. Only then remove its stale
`runtime.lock`. Restart recovery records interrupted/unknown state and never replays API
calls. Do not delete the database to conceal uncertain spend.
