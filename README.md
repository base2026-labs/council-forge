# Council Forge

**Independent minds. Inspectable decisions. Explicit spending boundaries.**

Council Forge is an open-source, local-first agent council runtime for technical SEO,
web development and evidence-grounded decisions. Configure the roles, model, reasoning
effort and instance count. Keep control of the budget and the final decision.

**Status: `0.1.0-alpha.2` — native local plugin candidate.**
The plugin is installed and discovered by Codex CLI 0.160.0 on Linux. It exposes a native
MCP Apps Council Room, explicit role contracts, multilingual output and shared local
concurrency/budget coordination. See [validation](docs/VALIDATION.md) for the exact
live acceptance result and remaining gates. OpenRouter/Jev paid inference, desktop
embedded rendering and hosted ChatGPT distribution are separate, uncompleted pilots.
No API key or subscription token is included. No release or public directory submission
has been made.

## Why another council?

More agents do not establish truth. Council Forge separates proposing, challenging,
independent claim verification and synthesis. A chairman cannot override a missing
fact, a failed policy check or an unresolved major objection. Accepted output is
**accepted for human/host review**, never authorization to change production.

## What is implemented

| Component              | Alpha behavior                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Council protocol       | Independent proposals → skeptic → blind claim check → chairman; one bounded round                                                             |
| Agent configuration    | Exact provider/model/effort; 1–10 instances for a proposer; separate mandatory skeptic, verifier and chair                                    |
| Billing policy         | `subscription_only`, `api_only`, `hybrid`; API calls and Jev forbidden in strict subscription-only mode                                       |
| Jev                    | Opt-in TypeSafe Decisions API advisor; aggregate-only metadata; cannot change pinned routes or permissions                                    |
| OpenRouter             | Exact-model Chat Completions, explicit effort, no retries, no provider fallback, usage receipt                                                |
| Generic compatible API | Configurable HTTPS endpoint; strict response checks; missing `usage.cost` produces HOLD, not a fictitious free call                           |
| Local Codex            | Official stdio app-server; existing managed ChatGPT auth, invocation-only integration isolation, exact model/effort and read-only attestation |
| State and budget       | SQLite receipts, atomic local/global reservations, one user-wide three-slot coordinator, idempotent runs and unknown-spend retention          |
| Technical SEO          | Source-HTML facts and bounded typed observation imports; no invented GSC, rendering, SERP or causality claims                                 |
| Interfaces             | CLI, ten MCP tools, native MCP Apps Council Room and separate local offline planning console                                                  |
| Plugin package         | Portable and Codex manifests, thirteen role skills plus generic workflow, local marketplace and installed-host receipts                       |

## Run the zero-cost demo

Requires Node.js **22.16 or newer** and npm. SQLite is provided by Node; an experimental
SQLite warning on stderr is expected on some Node 22 versions.

```sh
npm ci --ignore-scripts
npm run check
npm run demo
npm run ui
```

Open the URL printed by `npm run ui` on the same machine. The UI binds only to
`127.0.0.1:4317`. It is an offline planning console, **not a live ChatGPT widget**.

The fixture demonstrates an intentional HOLD: a source canonical tag does not establish
why Google has not indexed a page. No website or model is contacted. The receipt labels
all responses as simulation and reports zero external API exposure.

## Configure a real council

Read [Provider setup](docs/PROVIDERS.md) and [Budget semantics](docs/BUDGETS.md) first.
Server configuration is trusted operator input; model-supplied MCP arguments cannot
introduce provider endpoints, credential names, spending ceilings or higher permissions.

Copy `examples/operator.config.json` to an ignored `*.local.json`, replace only the
providers you intend to use, and refer to it through `COUNCIL_CONFIG`. Keep API secrets
in the runtime environment. **Never paste a key into a council request or commit it.**
Live inference needs both operator `liveEnabled: true` and the environment switch
`COUNCIL_LIVE_ENABLED=true` for direct CLI/MCP. Portable plugin hosts use an exact-config
admission file in their native plugin data directory; see [Plugin setup](docs/PLUGIN.md).
API routing additionally requires positive, explicit
operator and per-run budgets. Both are zero by default. Enabling GitHub permissions
does not enable provider spending.

```sh
node dist/cli.js models
node dist/cli.js contracts
node dist/cli.js plan examples/demo.request.json
node dist/cli.js demo --language ja
node dist/cli.js catalogue-openrouter
node dist/cli.js inspect-html examples/page.html https://example.test/services/
```

The OpenRouter catalogue command reads public model metadata. It does not call a model,
select a route automatically or establish account eligibility. Do not treat example
model IDs or configured effort values as evidence of access.

## Plugin and MCP

[Plugin setup](docs/PLUGIN.md) explains local packaging and the remaining integration
work. Prepare the repository with `npm ci --ignore-scripts && npm run build` before
using its local MCP entry point. There is no automatic dependency installation hook.
The stdio MCP transport is local. ChatGPT web/public distribution needs an authenticated
remote HTTPS service and review; those are not deployed in this alpha.

MCP tools: `council_models`, `council_plan`, `council_run`, `council_status`,
`council_cancel`, `council_inspect_html`, `council_room`, `council_configuration`,
`council_preset`, `council_import_observations`. Roles and capability limits are documented
in [role contracts](docs/ROLE-CONTRACTS.md). All research presets retain the three review roles.

Public documentation and UI labels are English. `outputLanguage` is a validated BCP 47
tag inherited from operator settings or supplied per request; CLI `--language` overrides
it explicitly. Prompts, native UI requests, decisions, evidence artifacts and receipts
carry the selection. JSON field names and decision enums remain stable across languages.

## Architecture and boundaries

Start with [Architecture](docs/ARCHITECTURE.md), [Threat model](docs/SECURITY.md),
[Roadmap](docs/ROADMAP.md) and the [implementation handoff](docs/HANDOFF.md).
API adapters currently consume supplied evidence only: they do not inherit the host's
browser, GSC, Search Console, GitHub or other connected tools. No crawling or production
mutation tool is exposed. No hidden chain-of-thought is requested or displayed.

The repository is an **independent implementation**, not a GitHub fork. No upstream
source code has been imported. Prior council projects are credited in
[design provenance](docs/PROVENANCE.md). This avoids coupling the security and billing
architecture to an upstream chat-demo implementation.

## Contributing

Use issues and pull requests. Add tests for any changed policy or provider contract.
Keep real customer material, credentials, local auth files and inference transcripts
out of public fixtures. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

MIT License. Maintained by Alex Yarosh.

### Explicit bounded public source crawl

The operator CLI `crawl-public` supports scoped robots-aware source traversal with
finite budgets and source-bound receipts. [Read the contract](docs/BOUNDED-CRAWL.md)
before supplying authority. `collect-public` remains a selected-page collector. Import
crawl evidence through existing CLI/MCP/Room observations without granting model tools.
No live crawler acceptance is claimed; the refusal example omits robots authority.
