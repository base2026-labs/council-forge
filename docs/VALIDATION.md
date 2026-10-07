# Validation report — 2026-10-07

## Executed on macOS arm64

Environment: Node.js 26.3.1, npm 11.16.0, TypeScript 5.9.3.

- Dependency installation: `npm install --ignore-scripts --no-fund --no-audit`, completed; lockfile generated.
- Static type check and build: PASS.
- Automated suite: **58 passed, 0 failed, 0 skipped**.
- Prettier check: PASS before the final documentation update; CI repeats it.
- Offline CLI demonstration: completed with `simulation: true`, `decision: hold`, `productionAuthorized: false`, API exposure USD 0.
- Production dependency advisory check: `npm audit --omit=dev --audit-level=high` returned **0 vulnerabilities** at check time. This is not a full application security audit.

The suite includes policy/budget/idempotency/recovery tests; mocked OpenRouter and Jev HTTP contracts; an executable **fake** Codex app-server testing completion, auth rejection, model mismatch, enabled tools, rerouting and interruption; a real stdio MCP client/server interaction; and local HTTP console checks for Host, Origin, CSRF and the absence of a live inference endpoint.

The Host-header test uses Node's HTTP client, not Fetch, because this runtime's Fetch implementation did not send the overridden Host header.

Raw successful command output: [macOS check](validation/macos-check.txt).

## Not executed / not established

No live model inference, paid Jev call, real website audit, live subscription smoke test,
native ChatGPT/Codex plugin installation, widget registration, directory submission,
or hosted OAuth deployment was performed. UI HTTP checks are not visual/browser E2E.

Mocked/executable-fixture tests do not prove compatibility with a current installed Codex
build or an account's model entitlements. Provider pilots remain a release gate.

## Independent Linux validation

The public repository was cloned at commit `528f67fcc40ed10ae740c116a988cc1315d483ad`
and checked on Linux with Node.js **22.19.0** using `npm ci --ignore-scripts`.
Type check, compilation, **58/58 tests**, Prettier check and the offline CLI demo all
completed successfully. The working tree remained clean. The expected experimental
SQLite warning appeared on stderr.

## GitHub-hosted CI limitation

Workflow run `37607845789`, job `112747609835`, did **not start** any steps because of
an account-level restriction. It is not a passing CI run and not evidence of a code-test
failure. No account settings or billing changes were made. Re-running unchanged jobs
was avoided. The workflow is retained for execution when the account restriction is resolved.

These receipt/documentation additions do not change the tested runtime source.
