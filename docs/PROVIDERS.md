# Providers and authentication

## Offline

No setup or credentials. `npm run demo` always uses fresh in-memory state and fixture
providers, regardless of the environment's live flags. The local planning console has
no live inference endpoint. This is deliberate until its authentication/consent UX is ready.

## OpenRouter API

Set the server-side environment variable named by `keyEnv` in an ignored operator
configuration. Use exact IDs from the provider catalogue, explicitly supported efforts,
allowed response IDs, and fresh price snapshots. No token values belong in the configuration.
The adapter sends a single explicit model, no `models` fallback list, and disables provider
fallback. It never retries a failed or ambiguous request automatically.

`usage.cost` is recorded as a provider-reported cost, not independently audited billing.
Compare pilot receipts to the provider account before raising budgets.

## Jev Decisions

A separate adapter uses the same OpenRouter credential mechanism and the dedicated
Decisions endpoint. The pinned default is `typesafe/jev-1.13-20260917`; account access has
not been live-tested in this bootstrap. Pinning may require an explicit operator update
if the provider retires that version. The runtime will not silently upgrade the model.

Jev is disabled by default. To enable it, the operator must configure an API/hybrid mode,
positive API ceilings and `jev.enabled:true`; the request must separately choose `useJev:true`.
One advisory call is counted within the run's call/concurrency/budget limits. A confidence
threshold is a routing heuristic, not a measured probability that the factual answer is correct.

## Other OpenAI-compatible APIs

Configure a trusted HTTPS base URL and a distinct server-side key environment reference.
The adapter uses Chat Completions syntax, not arbitrary vendor SDKs. Compatibility is
not assumed simply because an endpoint is labeled OpenAI-compatible.

Important alpha limitation: compatible endpoints that omit `usage.cost` cause HOLD after
the first response, retaining the reservation. Normalized token-only billing reconciliation
is backlog work. No direct Anthropic Messages, Google Gemini GenerateContent or Azure
versioned endpoint adapter is claimed yet. OpenRouter can be used for supported vendors.

## Managed local Codex subscription — experimental

The alpha adapter launches the official local app-server via stdio, without a shell and
without passing API-key environment variables. It accepts managed `chatgpt` account
state, refuses API-key/external-token sessions, checks the requested model and effort,
and refuses missing model attestation or rerouting.

Use an existing authenticated Codex home; a separate home must be authenticated by the
user through the official flow. Do not copy `auth.json`, extract stored tokens or proxy
undocumented backend endpoints. The adapter never edits the profile. Supported process
overrides disable apps, plugins, hooks, shell/unified execution, web/browser/computer
tools, artifact/image tools and multi-agent delegation. It discovers configured MCP
names, restarts with per-server disable overrides and verifies the effective config.
An empty top-level MCP table does not clear inherited settings and is not accepted as proof.

The adapter runs in an empty temporary directory. It attests model, effort, ordinary
service tier, `never` approval policy, read-only sandbox and disabled network before a
turn, then checks for zero callable apps/MCP tools/resources. No model tool dispatcher
is exposed. Observed tool calls, changed auth or model rerouting stop the run. Native
read-only filesystem enforcement is also required; Linux write denial was observed
with `EROFS`. This is not a claim of hostile-process isolation or universal platform validation.

Codex 0.160.0 rejects the obsolete `readOnly.access` turn field. The current adapter
uses `sandboxPolicy: {type: "readOnly", networkAccess: false}`. Failure receipts include
the RPC method and dispatch state without copying raw provider diagnostics. A failure
after `turn/start` is sent remains uncertain and is never automatically replayed.

See VALIDATION.md for the current Linux subscription pilot. Paid provider pilots,
quota exhaustion and native Windows/macOS behavior remain unverified. A schema
change fails closed. Correlated native usage fields are retained when reported; missing
fields and subscription cost remain null. Durable lifecycle/identity handling is described
in [NATIVE-RECEIPTS.md](NATIVE-RECEIPTS.md). Output token limits are not claimed to be enforced on this route.

The app-server route is for permitted local/open-source usage, **not a commercial or
hosted service**. A hosted startup must implement the appropriate Sign in with ChatGPT
integration and meet its registration and eligibility requirements. See the dated sources
in PROVENANCE.md. This repository does not ship or solicit an OpenAI API key.
