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

Use a **dedicated** Codex home signed in through the official user flow. Do not reuse a
profile with plugins, hooks, MCP servers or callable apps. Do not copy `auth.json`, extract
stored tokens or proxy undocumented backend endpoints. The adapter works in a temporary
empty directory and requests a restricted read-only sandbox. It rejects configured
integrations and observed tool calls. These checks are defense-in-depth, not a substitute
for an OS-level sandbox or a verified host tool-denial profile.

Live inference, account quota behavior, model receipt shapes, host integration isolation,
and Windows/macOS/Linux behavior still require an owner-approved E2E pilot. A schema
change fails closed. Native Codex usage may not expose normalized token/cost receipts;
those fields remain null. Output token limits are not claimed to be enforced on this route.

The app-server route is for permitted local/open-source usage, **not a commercial or
hosted service**. A hosted startup must implement the appropriate Sign in with ChatGPT
integration and meet its registration and eligibility requirements. See the dated sources
in PROVENANCE.md. This repository does not ship or solicit an OpenAI API key.
