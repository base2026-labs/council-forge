# Bounded public source traversal

This explicit operator mode extends existing M3 #3. It acquires public HTTPS source
responses through the existing transport and global coordinator. It does not render,
run a council, query GSC/SERP, install a plugin or add a model tool. This implementation
has deterministic fake-transport acceptance only; no live crawl is claimed.

`collect-public` retains its existing explicitly selected page behavior. It does not
discover links or silently become a crawler. `crawl-public <scope.json>` opts into the
bounded traversal below. Running that command with a complete scope performs real GETs;
only run it under actual operator authority. The repository's
`examples/crawl-hold.scope.json` intentionally omits robots authority: it returns HOLD
without a network request. It is a refusal example, not live crawl acceptance.

## Operator scope and bounds

Supply `mode: "bounded_crawl"`, a unique `crawlId`, `collector`, `permission: "read"`,
a nonempty `permissionReceipt`, `resources`, and `seeds`. These are operator assertions,
not evidence of property ownership. Every seed must be in the exact resource set.
Use fully serialized HTTPS URLs: lowercase hostname, encoded Unicode, no default port
spelling or dot-segment aliases. Path/query case, query order, percent-encoded reserved
characters and exact spelling are preserved. Scope is a finite list, never an origin,
prefix, glob, discovered link, canonical, sitemap or inferred permission.

All limits are required; none is unbounded:

| Field                                           | Hard ceiling / meaning                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `resources`, `seeds`                            | 100 exact resources; 25 unique seeds                                      |
| `maxRequests`                                   | 100 attempts, including robots, redirects, failed DNS/transport           |
| `maxPages`                                      | 25 distinct attempted page URLs, including redirect hops and failed pages |
| `maxDepth`                                      | 0–10 hyperlink edges from seeds; redirects retain depth                   |
| `maxRedirects`                                  | 0–10 hops per page or robots chain; cycles stop earlier                   |
| `maxResponseBytes`, `maxBytes`                  | Each 1–200000 body bytes; shared total includes robots/redirect bodies    |
| `timeoutMs`, `totalTimeoutMs`                   | 1000–30000 ms per request; 1–600000 ms total, including lease waits       |
| `maxObservations`, `maxEvidenceBytes`           | 1–100 receipts; 1–200000 serialized evidence bytes                        |
| `maxDomNodes`, `maxDomDepth`, `maxLinksPerPage` | 20000 nodes, depth 256, 100 hyperlinks per source page                    |
| `robotsMaxAgeMs`                                | 1–86400000 ms invocation-local snapshot ceiling                           |

The crawler reserves enough evidence space for a worst-case request receipt before
dispatch. Small evidence budgets can HOLD before their literal limit. DOM/fact/field
overflow returns partial/HOLD without accepting truncated page facts. The separate
completion receipt names stopped/truncated coverage and pending pages even when there
is no observation slot left. Network byte limits bound retained body data; one arriving
stream chunk may exceed the remaining allowance before connection destruction.
Observed excess bytes are counted, further dispatch stops, and partial/unknown byte
accounting is explicit. Headers/TLS/DNS overhead are not included in body-byte totals.

## Robots policy and specification boundary

Primary specifications read on 2026-10-08:
[RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html), sections 2.2–2.5 and 3;
[RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html), response cache directives.
This is a **bounded, conservative dialect**, not full RFC conformance. Its response and
parse ceiling is below RFC 9309's 500 KiB minimum. Explicit authority, smaller hop limits
and unsupported semantics can HOLD earlier than the specification's general behavior.

The fixed HTTP identification contains product token `CouncilForge`. Exact product-token
groups match case-insensitively and combine; otherwise wildcard groups combine. Paths
match case-sensitively from the first character, including the query. Supported rules
start with `/`; comments, empty paths, `*` and terminal `$` are supported. Comparison
normalizes percent hex case and encoded unreserved ASCII; Unicode uses UTF-8 percent
octets. Encoded reserved `/` remains distinct; literal `*`/`$` in target paths match
their percent-encoded rule forms. The longest comparison-octet pattern wins; equivalent
allow/disallow ties prefer allow. Different equal-specificity conflicting patterns
remain HOLD rather than guessing.

The parser bounds 200000 UTF-8 bytes, 1000 lines, 2048 bytes per line, 200 rules, 512 bytes
per pattern and 20 sitemap references/diagnostics. Orphan rules, malformed records,
unsupported agent/path syntax, crawl-delay/host/noindex/other records, invalid characters
and any overflow produce explicit HOLD. Parseable rules remain inspectable, but an
unsupported policy cannot supply an allowance. Sitemap records do not end groups and
are observed as inert references, never fetched or used as seeds. These narrower
semantics and limits deliberately differ from a fully conformant permissive parser.

Each page requires **two independent gates**: exact operator authorization and robots
allowance. The initial `/robots.txt` URL and every redirected robots URL must themselves
be explicitly authorized. Missing initial authority yields `ROBOTS_SCOPE_MISSING` with
zero dispatch. A redirected policy applies to the initial origin; authorization is
checked on every hop. Page redirects require the destination origin's robots allowance
before destination page dispatch. No credential, proxy or grant fallback exists.

| Robots result                                                                | Decision                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Complete 200, `text/plain`, valid UTF-8, supported policy                    | Apply supported rules                                                  |
| 404 or 410                                                                   | Use RFC's optional unavailable allowance, still subject to exact scope |
| Other 4xx, unsupported 2xx/3xx, invalid media/charset/UTF-8, malformed rules | HOLD                                                                   |
| 5xx/network/stream/timeout failure                                           | HOLD; no page allowance or implicit retry                              |
| Unsafe/unscoped redirect, cycle or exhausted hops                            | HOLD; target is not fetched                                            |
| Expired/noncacheable snapshot or unsupported cache policy                    | HOLD; no refresh/stale fallback                                        |

Snapshots are invocation-local only; a new invocation acquires its own robots evidence.
Their lifetime is bounded by `robotsMaxAgeMs`, supported `max-age`, conservative Age/Date
assessment and Expires where max-age is absent. Supported cache directives are unqualified
no-store/no-cache/private/public/must-revalidate/no-transform and one numeric max-age.
Date/Expires support exact IMF-fixdate only; other timestamp forms HOLD. A response Date
more than five minutes ahead of observation HOLDs. No-store/no-cache may inform the current fetched decision but cannot supply a reused
allowance. Malformed/unknown directives and age/date/expiry values HOLD. Conditional GET,
304 reuse, shared HTTP caching, persistent cache and long-outage exceptions are absent.
The collector stores audit hashes/decisions, not a reusable cross-run response cache.

## Transport, discovery and receipts

The existing HTTPS transport rejects credentials (including empty userinfo), controls,
backslashes, IP literals, local hosts, custom ports and unsafe redirects. DNS resolves
public IPv4 once per request; every answer must be public. The socket lookup is pinned
to one accepted address, preserving hostname TLS verification. IPv6-only hosts remain
unsupported. No proxy environment route, credentials, compression or implicit retry is
used. Streams, headers, cancellation, deadline and response bytes are bounded. Every
attempt uses the existing user-wide `GlobalCoordinator.use(1, …)`, serially within a crawl.
Unknown interrupted byte accounting stops subsequent acquisition.

Traversal is serial breadth-first over scoped `a`/`area` source hyperlinks. The first
source `base[href]` may change inert URL resolution; it never authorizes or fetches the
base. Scripts and template links are not executed/traversed. Fragment references retain
their raw spelling and resolve to the same source resource. `javascript:`, `data:`,
`mailto:`, userinfo and control payloads are rejected before normalization can hide them.
Cycles, duplicate references, depth limits and unscoped links have explicit receipts.
Only 301/302/303/307/308 are redirects. Unsupported status/content/encoding produces HOLD.
HTML canonical/robots/JSON-LD declarations remain source facts, not traversal authority.

Each `crawl` evidence record carries `observation.adapter: "public_crawl"`, exact resource,
observation time, crawl/sequence/depth/parent/scope capture, operator provenance, decision,
reason and completeness. Request receipts include requested-at, HTTP status, content type,
cache headers, body-byte count and full/partial body hash. Derived page/link/redirect/
sitemap/robots receipts bind the exact request identity and body hash, retaining source
status and raw references. Page facts concern the response source only. The normalized
payload and capture have separate SHA256 identities.

Save the returned receipt for durable audit; this collector does not resume a crawl after
restart or authenticate external observations. Generic `import-evidence` and existing
`council_import_observations`/Room import accept `{scope, observations: result.evidence}`
under a generic read scope, without fetching or inference. Exact acquired resources and
queued/follow targets must remain scoped. Reimport/preflight validate envelopes, hashes,
capture/permission binding, duplicate/conflicting identities and supplied parent receipts.
Missing parents remain unverified acquisition, not manufactured evidence. Recomputed public
hashes establish consistency only. Current robots permission cannot be inferred from old
imported decisions; their timestamps/expiry remain inspectable.

The same mandatory skeptic, blind verifier and chair receive evidence through existing
contracts. Models, effort, instance counts, billing mode, language, access and budgets
are untouched; no provider inherits acquisition or mutation tools. Source links, meta
robots, HTTP redirects and JSON-LD syntax establish neither Google-selected canonical,
indexation/ranking causality nor rich-result eligibility. Live crawler/browser/GSC/SERP,
schema evaluation, broader/equal-budget evaluation and original M1–M5 gates remain open.
