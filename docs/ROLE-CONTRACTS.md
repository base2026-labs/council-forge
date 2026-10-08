# Roles, presets, evidence and languages

`src/roles.ts` is the executable role-to-skill contract. Every role currently has only
`supplied_evidence`; no model inherits connected user plugins or external mutation tools.
The proposer prompt filters evidence by the role's declared kinds. Skeptic, verifier and
chair have the full packet. All source text remains untrusted data.

| Role            | Skill          | Responsibility                                                         |
| --------------- | -------------- | ---------------------------------------------------------------------- |
| architect       | architecture   | Architecture, testability and tradeoffs                                |
| technical_seo   | technical-seo  | Canonical, robots, redirects and source/rendered facts                 |
| researcher      | research       | Independent dated source analysis; multiple explicit instances         |
| geo_aeo         | geo-aeo        | Answer surfaces, entities and recorded citations                       |
| indexation      | indexation     | Dated GSC/crawl facts, Google-selected versus declared canonical       |
| serp            | serp           | Query, market, device and dated SERP samples                           |
| schema          | schema         | JSON-LD syntax versus externally supported eligibility                 |
| content         | content        | Intent, corpus gaps and editorial recommendations                      |
| evidence_hunter | evidence       | Claim coverage, provenance and missing observations                    |
| implementation  | implementation | Proposed repairs and tests for the one implementation owner            |
| skeptic         | skeptic        | Counterexamples, risks and major unresolved objections                 |
| verifier        | verifier       | Blind atomic-claim checks without proposer identity or narrative       |
| chair           | chair          | Explain the verified packet without overriding HOLD or granting writes |

Presets are `research`, `seo_geo_aeo` and `code_review`. Each requires explicit selections
for every role and preserves model, effort, provider and instance count. Proposers support
1–10 instances; reviewers each have one independent invocation. Every preset includes
skeptic, verifier and chair. Expanded agents/calls are revalidated against operator limits.
The broad SEO preset needs an operator ceiling sufficient for its eleven roles.

## Evidence collectors

Evidence kinds distinguish source HTML, rendered HTML, crawl, dated GSC observations,
SERP samples, provider-reported metrics, documents, tests, diffs and hypotheses.
Hypotheses alone cannot support factual claims. Observation imports require exact source
scope, read permission, collector identity, time, limitations, unique IDs and byte/count
bounds. Imported assertions remain caller-reported; a matching hash is not proof of truth.

The operator CLI `collect-public` adds a real bounded public HTTPS source collector:

```sh
node dist/cli.js collect-public examples/public-page.scope.json
```

It performs only GETs to exact scoped URLs, pins DNS to public IPv4 addresses, refuses
private/special networks, credentials, non-HTTPS/custom ports and out-of-scope redirects,
counts redirects against the request cap and enforces byte/deadline bounds. It sends no
cookies, keys or authorization headers and shares the same global provider-call slots.
It records source URL, time, status, content type, full response hash, source facts and
excerpt limitations. UTF-8 uncompressed HTML/plain text only; IPv6-only hosts are held.
It discovers no links and does not implement a robots-policy crawler. No automatic retry.

Network collection is an explicit host/operator action, separate from model inference.
No collection tool is granted to the live milestone agents. Rendered-browser, GSC,
authenticated crawl and paid SERP connectors remain unimplemented/unapproved pilots.
Source HTML is not evidence of Google-selected canonical, rich-result eligibility or
indexation causality. No receipt claims those observations were obtained.

## Output language

`outputLanguage` accepts a valid BCP 47 tag. Operator settings default to `en`; explicit
request language wins. CLI `--language` is a visible explicit override. MCP schemas,
native UI requests, all phase prompts, decision artifacts and receipts preserve it.
JSON keys, claim IDs and decision enums remain English/stable. Source excerpts retain
their original Unicode. Russian, Japanese and Arabic fixtures exercise propagation and
readability; semantic language compliance by live models remains fallible.

## Bounded planning

`src/planning.ts` validates at most eight candidate plans against the same preflight and
immutable user selections. Changed pins, permissions, spending, evidence or language are
rejected. Its evidence advice is a local shadow observation, not a Jev call or automatic
model switch. Jev's existing aggregate triage remains separately budgeted and advisory.
Adaptive debate, retrieval and equal-budget accuracy experiments are still backlog work.

## Typed offline exports

The existing supplied-evidence capability now includes [typed SEO export adapters](SEO-EVIDENCE.md).
URL Inspection is `gsc`; Search Analytics metrics are `provider_metric`; supplied source
and explicitly labeled rendered DOM retain their separate kinds. Role filtering remains
unchanged. Every phase must distinguish provider reports, locally parsed supplied-document
facts and caller assertions. Null/omitted metrics and dates are UNKNOWN. Stale/partial
observations do not prove current completeness, indexation/ranking causality or rich-result
eligibility. Native/request receipts preserve the structured observation and Unicode.
This capability adds no model tool, live GSC/browser/SEO access or write authorization.
