# Roadmap and acceptance gates

## Current milestone: foundation alpha

Implemented: policy/evidence kernel, one-round council, Jev Decisions port, explicit API
and local subscription ports, SQLite reservations, CLI, stdio MCP, HTML inspection,
offline planning console, plugin package metadata and automated fixture tests.

Not complete: live inference validation, actual plugin installation, production-grade
GUI, registered OAuth integration, browser/GSC tool execution, adaptive orchestration,
published npm package, remote MCP hosting, public directory publication or commercial readiness.

## M1 — provider contract pilots

Run owner-approved, bounded, non-private fixtures on OpenRouter, Jev and local Codex.
Record exact request/response model identity, requested/supported effort, usage source,
latency, completion status and failure behavior. Compare provider invoices to receipts.
Verify account/model discovery, app-server schema, no API-key fallback, connector isolation,
cancellation, rate-limit failures and max-concurrency behavior. No retry of ambiguous spend.

Implement compatible-API token-only reconciliation without inventing provider-reported costs.

## M2 — native plugin experience

Test root manifest and compatibility layout on an actual supported Codex build. Verify
MCP process launch, root-variable expansion, dependencies and cached install refresh.
Create the live Council Room UI with accessible per-agent selectors, limits, event stream
and evidence/objection views. Keep consent and secrets outside model-controlled arguments.

## M3 — SEO evidence collectors

Add bounded HTTP crawl with redirects/robots scope, isolated rendered-browser sampling,
read-only GSC observations, sitemap and structured-data validators, then selected search
providers. Keep source versus rendered versus GSC provenance explicit. Every paid search
or crawl call goes through the same budget system. Never imply a parser is a full audit.

## M4 — adaptive councils and evaluation

Let Jev rank admitted plans in shadow mode, preserving user pins. Missing evidence triggers
bounded retrieval or HOLD, not automatic stronger-model inference. Add at most one bounded
revision round before expanding debate modes. Measure acceptance accuracy, error detection,
cost and latency against a single strong model and independent sampling at equal budgets.
No benchmark gain claim until a reproducible evaluation supports it.

## M5 — hosted product

Complete the official Sign in with ChatGPT registration/integration for the intended
product; no ordinary Codex-auth subscription proxy. Add authenticated remote MCP, tenant
isolation, vault-backed keys, retention controls, distributed budgets, release security
review, public submission and a clear service/privacy policy.
