# Budget semantics: no hidden wallet switch

There are three distinct measures: external API exposure in USD, subscription allowance,
and runtime limits such as calls/deadline/concurrency. They must not be merged into a
misleading “free tokens” figure.

External budgets use integer micro-USD internally. Before each API request, SQLite
atomically checks the per-run admission ceiling and the operator lifetime ceiling for
the result database and the shared user-wide ledger. Reservation estimates use dated operator price metadata, a conservative
text-size estimate, output limit and a safety margin. Jev uses a separately configured
per-call reservation. **These estimates are not a provider-enforced invoice cap.**

The current implementation coordinates local processes under one user, not distributed hosts or tenants.
Use a dedicated provider key with a provider-side spend limit for live pilots. Do not
promise zero overshoot from client-side cancellation or a text-based token estimate.
The operator's database ceiling is lifetime-scoped; it does not reset daily or monthly.

Known provider cost settles the reservation even when completion, tool, model, JSON or
output-schema validation rejects the response. OpenRouter and Jev retain only sanitized
request/model identities and individually valid usage fields, including charged HTTP
rejections with a readable JSON receipt. A valid zero charge is known; omitted, invalid
or uncertain cost remains UNKNOWN. Response validity never determines whether a charge
is recorded. These are provider reports, not independent invoice verification.

A reported cost above the reservation is recorded in both ledgers and immediately
holds the run. Terminal accounting failure stops admission before queued calls acquire
their local/global slot or reserve funds. Already dispatched calls retain their original
cancellation signal, settle their own known/UNKNOWN exposure and keep call receipts before
the held result is saved. Accounting failure takes precedence over earlier output errors.
Cancellation and process interruption preserve uncertainty and do not authorize replay.
Unknown cost, unreadable responses, timeout or ambiguous transport failure retain the
whole reservation and do not trigger a retry.
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
three across the user's live runtimes, total agents sixteen including reviewer and chairman.
A larger council queues calls; ten instances do not mean ten simultaneous processes.
Separate result directories share the same global coordinator. Separate hosts/users do not.
Subscription usage remains null when the native host supplies no normalized receipt;
a dispatched incomplete turn is uncertain even when external API exposure is zero.
