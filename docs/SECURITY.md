# Threat model and release constraints

## Trust boundaries

The operator owns the server configuration, environment, local database and selected
Codex executable/profile. MCP callers may supply a bounded task and evidence, not new
provider endpoints, credential variables, write permissions or operator ceilings.
All evidence, page markup and model output is untrusted. The API adapters have no tool
execution surface. Instructions embedded in a page cannot directly mutate policy.

Secrets are resolved server-side at dispatch and are never placed in prompts, model
messages, UI fields or run receipts. Arbitrary HTTP error bodies and raw app-server stderr
are omitted. This is a reduction in leakage risk, not a guarantee against secrets a user
manually includes in their own evidence. Keep private material out of public fixtures.

API requests use HTTPS and reject redirects. Generic provider URLs are trusted operator
configuration, not safe public user input. This local alpha must not be exposed as a
multi-tenant server. The planning UI binds to loopback, checks Host/Origin, requires a
per-process CSRF token for POST, and serves a restrictive CSP. It has no live API endpoint.

Local app-server isolation remains a release gate. Read-only filesystem sandboxing alone
does not constrain an enabled MCP or connector. The adapter refuses integrations in its
dedicated configuration and checks callable tools, but a live OS-sandbox/security pilot
is still necessary. No production-write tool is offered by Council Forge.

## Persistence and crash recovery

The runtime directory and SQLite file use owner-only permissions where the host honors
POSIX mode bits. Windows ACL hardening requires separate validation. The database may
contain confidential model answers and evidence identifiers; it is not encrypted. Treat
it as private. It is ignored by Git. No telemetry is sent by Council Forge itself.

A single process owns each state directory using an exclusive lock. A crash leaves the
lock and reservations in place. Confirm that no runtime is alive before removing a
stale lock. Do not auto-delete it based solely on file age. Recovery marks the previous
run interrupted and does not replay paid inference.

## Before production/public hosting

Required: independent code/security review; account-specific OAuth and consent;
credential vault; tenant/user isolation; authenticated HTTPS MCP; provider-side quota
controls; scoped tool grants; durable job cancellation; retention/deletion controls;
release secret scan; dependency review; independent evaluation of evidence accuracy.

Future execution must use a single owner per mutating resource, exact resource locks
and explicit permissions. Review consensus never grants access. Domain-level SEO claims,
legal/health-sensitive text and irreversible actions need appropriate human review.
