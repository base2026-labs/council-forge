# Budget semantics: no hidden wallet switch

There are three distinct measures: external API exposure in USD, subscription allowance,
and runtime limits such as calls/deadline/concurrency. They must not be merged into a
misleading “free tokens” figure.

External budgets use integer micro-USD internally. Before each API request, SQLite
atomically checks the per-run admission ceiling and the operator lifetime ceiling for
this database. Reservation estimates use dated operator price metadata, a conservative
text-size estimate, output limit and a safety margin. Jev uses a separately configured
per-call reservation. **These estimates are not a provider-enforced invoice cap.**

The current implementation is a single local runtime, not a distributed billing system.
Use a dedicated provider key with a provider-side spend limit for live pilots. Do not
promise zero overshoot from client-side cancellation or a text-based token estimate.
The operator's database ceiling is lifetime-scoped; it does not reset daily or monthly.

Known provider cost settles the reservation. A reported cost above the reservation is
recorded and immediately holds the run. Unknown cost, malformed responses, timeout or
ambiguous transport failure retain the whole reservation and do not trigger a retry.
A compatible API without a cost receipt therefore requires reconciliation before reuse.
The alpha has no automated refund, top-up or hidden reconciliation feature.

The run's initial plan is an admission preview, not an invoice quote. Downstream prompts
grow after proposals, so later stage reservations can stop a run before the chairman.
Already dispatched parallel calls may still complete or incur costs. Total API exposure
includes Jev; failed work is not silently represented as zero spend.

Subscription mode requires the managed subscription route and does not fall back to an
API key or OpenRouter. It still consumes plan allowance. API dollars may be zero while
subscription use is nonzero or unknown. A budget error never escalates to a more expensive
model. A missing fact never becomes “try Astra and hope.”

Default operator limits: live off, external API allowance zero, maximum concurrent calls
three across the entire runtime, total agents sixteen including reviewer and chairman.
A larger council queues calls; ten instances do not mean ten simultaneous processes.
No global limit is enforced across separate state directories/hosts in this alpha.
