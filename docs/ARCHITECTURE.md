# Architecture — v0.1 foundation

Decision date: 2026-10-07. This document separates implemented behavior from planned
capabilities. Source links are recorded in PROVENANCE.md.

## Product boundary

Council Forge is a decision system, not a shared prompt in which several characters
pretend to be independent agents. Every proposer, skeptic, verifier and chair is a
separate provider invocation. Repeated instances of one model are separate samples,
not separate model families. Independence of sessions does not eliminate correlated
errors or prove correctness.

The first vertical is technical SEO. The core is domain-neutral. Code review and
architecture use the same claim/evidence contract; additional presets and tool access
will be introduced behind separate capability checks.

## Components

1. **Host surfaces:** Codex plugin/skill, stdio MCP and a local planning console.
2. **Policy kernel:** validates billing, registry identities, supported effort,
   instance counts, roles, deadlines, evidence bounds and operator ceilings.
3. **Jev advisor:** an optional, API-funded decision call over aggregate metadata.
4. **Council engine:** creates independent proposals, criticism, blind checks and synthesis.
5. **Provider ports:** mock, OpenRouter, generic compatible API and experimental local Codex.
6. **Evidence contract:** source type, source identifier, observation time, excerpt and hash.
7. **SQLite journal:** run identity, normalized usage receipts and atomic spend reservations.

Policy decisions are ordinary deterministic code, not instructions an LLM may override.
There is one process-wide concurrency semaphore per runtime. A directory lock enforces
one owning runtime per state directory. Separate state directories intentionally do
not share a limit; distributed quota coordination is not implemented.

## Three billing modes

| Mode              | Council models                                  | Jev                      | Default on unavailable subscription |
| ----------------- | ----------------------------------------------- | ------------------------ | ----------------------------------- |
| Subscription only | Managed local Codex subscription route          | Forbidden                | HOLD/error, never API fallback      |
| API only          | Explicit API providers                          | Optional with API budget | No subscription calls               |
| Hybrid            | Explicitly assigned subscription and API routes | Optional with API budget | HOLD/error, no implicit replacement |

The routing mode and provider billing class are distinct. A model name alone does not
establish which wallet pays. A hybrid council can include subscription agents and a
small Jev API allowance, but must never be labeled “subscription only.”

Live execution requires two operator-controlled gates. The public repository ships
with neither live flag enabled and with zero API allowance. Incoming MCP requests may
request less budget than the operator ceiling, never increase it.

## Agent identity and model catalogue

An agent binds `id`, `role`, `providerId`, exact `model`, optional `effort`, and
`instances`. The model registry distinguishes display labels, request IDs, explicitly
allowed response IDs, supported effort values, dated price metadata and transport.

Friendly labels such as Astra, Sol, Luna or Jev are not automatically translated into
an invented vendor slug. OpenRouter offers a public metadata discovery command.
The local Codex adapter checks `model/list` and supported effort immediately before
inference. That catalogue can be cached; a listing is not a guarantee of account
entitlement. Unavailable models and effort mismatches fail closed.

The alpha registry is operator-managed. Account-specific OAuth catalogue refresh,
capability probes and a live model picker are planned. A provider reporting a different
model is rejected unless its response ID was explicitly registered. Codex model
rerouting notifications stop the adapter.

## Jev is not an extra chatbot

The implementation targets **TypeSafe Jev Decisions**, pinned by default to
`typesafe/jev-1.13-20260917`, through `/api/alpha/decisions`. It is not the separate
OpenRouter automatic Jev Router product and not a Chat Completions text generator.

The alpha advisor receives only task-kind enum, agent count, evidence count and API
budget. It receives no raw task, URL, source excerpt, customer data or secrets. This
privacy choice limits the sophistication of its advice; it is not semantic verification.
Its allowed choices are retain the current council, request evidence or request deeper
review. Unknown candidates, a changed model version, malformed probability distributions
or low confidence produce HOLD.

Jev cannot modify model, effort, instance count, permissions or spend. Later adaptive
routing may let it rank **already-admitted candidate plans**, followed by deterministic
revalidation. Explicit user pins remain hard constraints. The alpha does not implement
that automatic plan switcher and makes no claim of cost savings.

## Deliberation protocol

**Preflight:** validate the complete request and require evidence. Missing evidence
returns `needs_input` without inference. There is no escalation to a stronger model
merely because an external fact is missing.

**Independent proposals:** proposers receive the task and supplied evidence, but no
other proposal. Each returns atomic factual claims and concise summaries.

**Skeptic:** receives proposals, claims and evidence. Major and critical objections
remain blockers. The current version does not silently dismiss or auto-resolve them.

**Blind verifier:** receives the task, atomic claims and evidence, not the solver's
narrative, model identity, preferred answer or the chairman's conclusions. Every claim
needs exactly one check. Unknown/contradicted checks, duplicated IDs and nonexistent
evidence references block acceptance.

**Chair:** receives the verified packet and produces an explanatory synthesis. Its
output cannot change the decision gate. “Accepted for review” is not production
approval. Semantic conclusions remain fallible even after every schema and hash passes.

The alpha implements **one round**. Bounded revision loops, anonymous ranking and
adaptive debate are roadmap work, not hidden functionality. Claim counts, expanded
prompts, total planned calls and deadlines are bounded. No whole private reasoning
traces are solicited.

## Evidence and SEO correctness

The source inspection utility parses HTML with parse5. It reports what the supplied
source contains: canonical declarations, robots meta, titles, H1s, image ALT attribute
presence and JSON-LD JSON syntax/type labels.

It does not fetch the URL, inspect headers, fetch robots.txt, execute JavaScript,
retrieve GSC, determine Google's chosen canonical, assess rich-result eligibility,
measure CWV or establish indexing causality. Empty ALT may be intentional. A JSON
parse success is not semantic schema validity. These boundaries are returned with the
result, not hidden in documentation only.

Future collection adapters must produce typed evidence: HTTP response versus source
HTML versus rendered DOM versus dated GSC observation. Each adapter needs an explicit
read capability, scope, budget, audit provenance and independent acceptance criteria.
Public web text and tool results are untrusted inputs, never authority to change policy.

## Failure, budget and recovery

See BUDGETS.md. Reserve API funds before dispatch, including Jev. A costless-looking
network timeout is not evidence of zero charge. Unknown costs retain the reservation;
there is no automatic paid retry. The ledger accounts globally across runs sharing the
same state database and atomically checks the per-run and operator lifetime limits.

Run IDs bind a canonical request hash. Same ID/same payload returns existing state or
result; same ID/different payload is a conflict. Restart recovery marks unfinished runs
interrupted and pending API costs unknown. It does not resume inference. A stale process
lock must be investigated before removal; see HANDOFF.md.

The alpha records subscription token usage as unknown when app-server does not supply a
normalized receipt. It does not represent subscription use as unlimited or free.
Timeouts can interrupt locally without proving that the vendor stopped billing.

## Hosted startup architecture — planned, not deployed

The local OSS runtime is the initial distribution. A commercial/hosted version needs
its own authenticated service, tenant isolation, secret vault, externally enforced
quota controls, durable job scheduler, protected UI event stream and per-user policy.
It must not turn an ordinary Codex login into a hosted subscription proxy.

Sign in with ChatGPT registration/eligibility, supported OAuth flows and account-specific
models must be implemented against the official integration. That flow is distinct from
ordinary identity login. The documented Responses preview requires `store:false` and
`stream:true`, excludes several parameters/tools, and requires terminal completion
handling. The alpha does **not** claim that this flow is registered or implemented.

Only one Main implementation agent may own a mutating resource in a future executor.
Resource locks must be narrow: repository/worktree, site-global configuration, exact
object or a shared browser profile. Two different sites do not inherently conflict.
Neither a model selection nor Jev's confidence can remove an authorization gate.
