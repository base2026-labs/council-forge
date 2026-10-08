# Typed offline SEO evidence — M3 continuation, 2026-10-08

This slice normalizes **supplied exports**, without acquiring data or running a model.
The existing generic evidence importer remains supported. It does not establish live
GSC/browser integration or complete M3 #3. Live admission remains revoked and the two
historical subscription outcomes remain UNKNOWN.

## Use the existing evidence flow

```sh
npm run build
node dist/cli.js import-evidence examples/seo-export.packet.json
```

The file contains `{scope, exports}`. The same packet is accepted by the existing
`council_import_observations` MCP tool and the Council Room's **Use exported evidence**
button. The button replaces the evidence array only after successful validation; it does
not convene a council or change role/model/effort/count/language/budget pins. Its result is
inert text. Copy the returned `evidence` array into a normal request for `council_plan`.
Import never calls `council_run`. There are still ten MCP tools and no model tool dispatcher.

Existing `{scope, observations}` packets remain valid. Supply exactly one array. Typed
records can pass through generic import and request/room/store receipts without losing
structure. Mixing separately imported observations is checked again at council preflight.

## Export packet and scope

Every export has an `id`, `sourceType`, ISO UTC `observedAt`, `provenance` and
`completeness`. Provenance requires the matching collector, `permission: "read"`, a
nonempty permission receipt and an export identity. These are **caller assertions**:
the importer does not authenticate a Google response, inspect OAuth grants, verify a
browser acquisition or prove that the caller owns a property. Never supply credentials.
A matching hash is integrity evidence, not truth or permission verification.

Scope retains the generic collector/read/resources/maxObservations/maxBytes fields and
adds optional typed bounds. Hard ceilings are 100 exports, 200000 UTF-8 bytes, JSON depth
32, 100 rows per Analytics export, 20000 DOM nodes, 100 extracted facts and a 366-day
inclusive query window. Defaults are depth 20, 100 rows, 5000 DOM nodes, 100 facts and
168 freshness hours. Each normalized excerpt is at most 20000 characters; the combined
normalized evidence must also fit maxBytes; combined typed council evidence is capped at 200000 bytes before admission. Oversized data is rejected, never silently
trimmed or paginated. The CLI reads at most 200001 bytes before rejecting a large file.
Malformed/unsupported mappings return an error/HOLD for the caller to resolve.

Resource strings retain their exact supplied spelling, path, query and Unicode. GSC
inspection requires **both** the exact property ID and inspected URL in the resource set,
and verifies the URL belongs to that Domain or URL-prefix property. Analytics requires
the exact property ID plus every supplied page row/equality-filter URL. It preserves
other filters as data; it never executes regex expressions. Related Google/user
canonicals, sitemaps and referring URLs do not grant access to those URLs. HTTP(S)
identifiers with credentials, controls or an invalid property binding are rejected.
No URL is fetched, resolved through DNS or used as a browser navigation target.

## What the adapters mean

| Source type                   | Basis                        | Normalized content                                                                                                                                                                    | Limitations                                                                                                                                                                                                                          |
| ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gsc_url_inspection_export`   | `provider_reported`          | Exact supplied request; index verdict/states, crawl timestamp, Google-selected canonical, user canonical, crawled-as, sitemap/referring URLs, inspection link                         | Indexed-version report, not live URL indexability; absent/unspecified states are UNKNOWN. AMP/mobile/rich-results mappings are held and named as unmapped fields.                                                                    |
| `gsc_search_analytics_export` | `provider_reported`          | Exact property/request, date window, dimensions, filters, type/dataState/aggregation, offset/row limit; rows, individually reported metrics, aggregation and incomplete-data metadata | Inclusive PT dates; top-row coverage is UNKNOWN even if caller says complete. Missing dates/keys/metrics remain UNKNOWN. No query-row summation, invented total or causal diagnosis.                                                 |
| `source_html`                 | `observed_supplied_document` | Locally parsed canonical declarations, robots meta, titles/H1s, image ALT counts, JSON-LD syntax/types and source hash                                                                | Facts concern the supplied source only. No rendering, headers, robots.txt, redirect or Google observation.                                                                                                                           |
| `rendered_dom`                | `observed_supplied_document` | The same parsing over an explicitly labeled DOM serialization and caller-reported renderer/capture description                                                                        | This runtime does not render a page. Acquisition is caller-reported. A source capture cannot be labeled rendered while retaining its source capture contract; rendered acquisition remains an explicit, unverified caller assertion. |

Normalized records separately carry `callerAssertions`, source type, exact resource and
request, observation time, payload/identity hashes, freshness assessment, completeness,
status/error, unmapped-field paths and limitations. Missing values use `null` as UNKNOWN;
known zero is retained. Error responses cannot supply successful report fields. Unknown
extra provider fields are bounded, named and covered by the response hash, without
inventing a mapping. The source HTML canonical is a raw attribute declaration, distinct
from both GSC canonical fields; it is not resolved into a Google-selected canonical.

An inspection's `canonicalAgreement` compares only its two reported canonical strings.
It is not an indexation diagnosis. JSON-LD parse success/type labels never establish
semantic schema validity or rich-result eligibility. No observation proves ranking or
indexation causality. Partial/unknown document completeness cannot establish absent
whole-page facts. Stale observations retain their time/facts and an explicit limitation;
future observation times and crawl times after observation are refused.

## Integrity and read-only boundaries

The observation identity binds source type, adapter, exact resource/request and observation
time, independently of an evidence ID. Duplicate identities are rejected. Different
permission/collector/export receipts for one identity produce `CONFLICTING_PROVENANCE`;
different payloads produce `CONFLICTING_OBSERVATION`. Generic imports and council
preflight check typed envelope/request/resource/freshness consistency again. They do not
upgrade generic assertions into authenticated provider observations.

JSON and DOM/JSON-LD traversal have count/depth bounds. Scripts, event handlers, URLs and
prompt-injection strings are data. Template contents are inert and still count against
DOM limits. UI uses `textContent`/textarea values; prompts keep an `untrusted_data`
envelope. Model capabilities remain empty. The adapters add no credential, retry,
network, inference, paid API or mutation route. Existing shared concurrency, accounting,
mandatory skeptic/verifier/chair and durable receipt/no-replay controls remain in force.

## Requirement-to-evidence matrix for existing M3 #3

| Requirement                                            | Implemented evidence                                                                                                                                     | Remaining acceptance                                                                                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorized typed GSC URL Inspection                    | `src/evidence-schema.ts`, `src/collectors.ts`; canonical disagreement, partial/error/future/property-boundary fixtures in `tests/seo-evidence.test.mjs`  | Live collector acquisition, authorization receipts and indexed-version service acceptance unverified; no live GSC call in this slice                                    |
| Search Analytics property aggregates and query exports | Typed request/response mapping; explicit zero/null, empty versus missing rows, PT dates/gaps, incomplete metadata, paging/filter and malformed-row tests | Live collection, pagination/exhaustiveness and independently reconciled reporting remain unverified                                                                     |
| Supplied source versus rendered DOM                    | Bounded `inspectDom`, separate source/capture contracts and Unicode/canonical/schema/template fixtures                                                   | Real browser capture and source/rendered comparison under actual navigation/render conditions unverified                                                                |
| Provenance, limits and inert display                   | Exact scope/identity/payload checks, conflicting-provenance and byte/count/depth cases; VM Room test rejects HTML interpretation                         | Caller provenance is asserted; cryptographic provider authentication is not implemented                                                                                 |
| MCP/CLI/room and role contracts                        | Existing ten-tool import path, CLI import and room replacement; guarded `tests/seo-surfaces.test.mjs`, role/receipt/Unicode integration tests            | Embedded-host/live multilingual council acceptance remains separate                                                                                                     |
| Robots-aware bounded crawler, redirects/internal links | Existing accepted `src/public-pages.ts` remains unchanged; existing source GET bounds/tests preserved                                                    | Robots-aware traversal, crawl observations, redirect/link corpus and live resource-key acceptance remain backlog                                                        |
| SERP and schema requirements                           | Explicit UNKNOWN eligibility/causality; supplied JSON-LD syntax/types only                                                                               | SERP provider adapter/pilot and current schema/eligibility evaluation remain backlog                                                                                    |
| Public evaluation corpus and measurement               | Synthetic/non-client regression exports and adversarial source/provider fixtures                                                                         | Deterministic fixtures are not a benchmark of accuracy, error detection or causal inference; broader crawler/SERP/schema corpus and equal-budget evaluation remain open |

## Primary response contracts

Reviewed 2026-10-08; mappings are deliberately bounded to substantiated fields:

- [Google URL Inspection request/response](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect).
- [Google UrlInspectionResult / IndexStatusInspectionResult](https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult).
- [Google Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).

These public documentation reads are not live GSC API calls. Fixtures are independently
constructed synthetic exports on example.com, not Google account or customer data.
