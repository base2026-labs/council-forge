---
name: council
description: Convene an evidence-first council for technical SEO, code review, research or architecture using Council Forge. Validate model, effort, billing boundaries and supplied evidence before any run.
---

Use Council Forge when the user explicitly requests independent agents, a council,
reviewers, disagreement analysis or verification before a consequential decision.

1. Call `council_models` to inspect configured route IDs. Labels are not verified model
   availability. Do not invent an Astra/Sol/Luna slug, effort, API balance or entitlement.
2. Form a bounded request with a stable unique `runId`, task, evidence and distinct
   proposer, skeptic, verifier and chair. Proposer instances may be 1–10; count every
   role against the runtime limit. Preserve the user's exact model/effort pins.
3. Call `council_plan` before `council_run`. Missing evidence means bounded retrieval through
   an already-permitted host tool or `needs_input`/HOLD, never an automatic model upgrade.
4. Respect `subscription_only`, `api_only` and `hybrid`. Jev uses an external API and is
   forbidden in strict subscription-only mode. A key is not consent to spend. Never put
   credentials, provider endpoints or operator config into an MCP request.
5. Explain whether a proposed execution is simulation, subscription-funded or API-funded.
   Invoke live work only within the user's requested scope and operator-enabled budget.
6. Inspect the final receipt. A run can complete with a HOLD decision. Report unresolved
   objections and evidence gaps. Do not claim that a JSON/hash check proves semantic truth.
7. Reuse the same run ID only for the same request. Do not automatically repeat a failed
   or interrupted paid call. `council_status` reads the receipt; `council_cancel` requests
   cancellation but cannot promise zero provider charges.
8. For supplied HTML, `council_inspect_html` is source-only. It is not a crawl, rendered
   browser, GSC query, schema-eligibility test or proof of indexing causality.
9. A council result never grants production permissions. No model may alter the user's
   sites, repositories, billing settings or plugin permissions through this runtime.

The alpha's API agents do not inherit host tools. No live UI widget, automated debate
loop, registered OAuth flow or public directory installation is implied by this skill.
Use concise summaries and evidence links; never request private chain-of-thought.
