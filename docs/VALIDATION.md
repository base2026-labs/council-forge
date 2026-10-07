# Validation report — 2026-10-07

## Historical foundation validation on macOS arm64

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

## Not executed by the historical bootstrap

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

## Native candidate validation on Linux

Candidate version: `0.1.0-alpha.2`; branch `offlinerpsy/agr45-live-council`, based on audited
main `bb12eda78b667f27d6f4e13fac803a78cc687157`. Node.js 22.19.0, Codex CLI 0.160.0.
The current implementation suite has **83 passed, 0 failed, 0 skipped** locally. Lint,
typecheck, compilation, formatting and offline demo commands are captured by the execution
worker against its final candidate head; these are separate from hosted CI.

Coverage adds exact live effort requirements; three-mode negative controls; thirteen
role contracts and mandatory preset reviews; scoped observations; raw evidence hashes;
BCP 47 and Russian/Japanese/Arabic fixtures; shared local lease/budget coordination;
UNKNOWN retention; cancellation before a queued call dispatches; actual native room
controller execution against a synthetic MCP Apps bridge; and attempted mutation denial.
All simulated/provider-fixture tests are explicitly synthetic and prove no live entitlement.

### Installed native plugin and capability boundary

The official plugin CLI installed the local portable package in a task-local host. Hash
readback checked cached manifest, compiled server/engine/adapter and UI against the source.
The official app-server discovered ten MCP tools and fourteen skills, expanded the cached
root, invoked council_room and denied five attempted mutation tool names: repository
write, website publish, GSC mutation, Linear update and shell execution. MCP Apps HTML
resource and UI metadata were verified. No mutation tools are registered.

For subscription isolation, effective process overrides disabled inherited integrations
without changing the authenticated profile or copying auth. Readback showed zero callable
MCP tools/resources/apps. A native Linux read-only sandbox write attempt failed EROFS and
created no sentinel. The council model surface exposes no tool dispatcher, forbids grants,
and stops on observed tools/rerouting. This does not establish adversarial OS isolation
or platform-wide security certification.

### Live attempt remains held

The tested live source head was `41c5db14f5faad074fd7c7338aab8ffef0f86c3a`. Exact choices:
GPT-6.1 Sol MAX for SEO/skeptic/chair and GPT-6 Sol MAX for evidence hunter/blind verifier,
instance count one each, subscription_only, Russian output, five planned calls,
concurrency one, read_only, Jev disabled and API budget zero. The input was a non-private
supplied canonical/robots HTML example, not a real GSC/Google observation.

The first host call failed UNKNOWN_PROVIDER before a run existed because parent variables
were not forwarded. The native PLUGIN_DATA admission path corrected this. The next
request was refused by an obsolete readOnly.access field; passive invalid-thread protocol
validation independently reproduced an invalid-request rejection before turn processing.
The corrected request sent two independent proposal attempts. Both ended CODEX_INCOMPLETE
with dispatched=true, resultKnown=false and null usage. No completed provider response or
skeptic/verifier/chair phase is claimed. There was **no retry of that uncertain operation**.

An acceptance-script reporting bug used only successful response IDs for its top-level
dispatch boolean; per-role diagnostics are authoritative. The original raw receipt is
preserved. Future script receipts count attempted dispatch separately from accepted turns
and completed outcomes. Later code adds safe error enums, thread attestation, strict native
JSON schemas with required nullable objection IDs, evidence on held results and UI replay
locking. These later changes have fixture tests; they were not another live inference test.

### Collection and visual checks

One authorized public HTTPS GET to https://example.com/ returned HTTP 200, 577 bytes,
text/html, source title Example Domain and response SHA-256
`25ddf2c883e0d1958ea971d279a7e4f0fd446724ee3db7db19dadabd4a62e484`.
The scoped collector returned dated provenance and source-only limitations, with no
inference, key, cookie, authorization header or paid API call. This is not a website crawl,
rendered/GSC audit, indexation observation or causality experiment.

Supported Chrome CUA rendered the local room component at desktop and 390x844 mobile
sizes. Horizontal overflow was zero; Japanese input was readable. The preview explicitly
has no native bridge/run. Embedded Codex/ChatGPT desktop rendering remains unverified.

### Hosted CI and remaining release gates

Audited-main CI run 37608118807 failed before steps, with job runner ID 0 and an empty
step list. The earlier 58-test history is not fresh CI evidence. The candidate adds lint
and a Linux/macOS/Windows matrix, but configured coverage is not executed coverage.
No account billing, security controls, protection or permissions were changed. The final
PR CI readback must be reported accurately by the execution handoff, without repeated jobs.

Remaining: completed subscription council; paid OpenRouter/Jev pilots and invoice checks;
embedded/native platform acceptance; GSC/rendered/SERP connectors; adaptive/equal-budget
evaluation; hosted authentication/retention/security. Separate independent review remains
controller-owned. No merge, release, deployment or directory submission is authorized.
