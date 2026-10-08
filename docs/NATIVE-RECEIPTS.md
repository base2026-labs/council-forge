# Durable native invocation receipts

This offline reliability work extends existing provider-contract backlog [M1 #1](https://github.com/offflinerpsy/council-forge/issues/1).
It does not validate a new live model turn or reconcile missing historical receipts.
The contract is checked against the preserved Codex CLI 0.160.0 generated schemas and
[official app-server documentation](https://learn.chatgpt.com/docs/app-server).

## Boundaries and durability

The engine passes a receipt sink to the native adapter. The store synchronously commits
an allowlisted snapshot and its `native_receipt` event in one SQLite transaction with
`synchronous=FULL`. Events remain inspectable through the existing `council_status` tool.

| Boundary                           | Persisted evidence                                                       | Meaning                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Invocation requested               | Local call identity, requested model/effort                              | No provider dispatch established                                         |
| Thread requested/acknowledged      | JSON-RPC request ID, returned thread ID and thread-reported model/effort | Thread configuration, not completed inference                            |
| Turn requested                     | JSON-RPC request ID committed before the transport write                 | Durable dispatch intent; sending may still fail                          |
| Turn dispatched                    | Write handed to the local pipe                                           | Possibly in flight; not remote acceptance                                |
| Turn acknowledged                  | Matching RPC response and returned turn ID                               | Acknowledgement only; outcome stays UNKNOWN                              |
| Awaiting completion / turn started | Exact acknowledged thread/turn pair                                      | In flight                                                                |
| Usage reported                     | Correlated, individually valid native usage fields                       | Host-reported usage, not an invoice                                      |
| Turn completed                     | First matching terminal status                                           | Native outcome only; output/council validation is separate               |
| Connection lost / rejection        | Sanitized error code and last known identities/usage                     | UNKNOWN after dispatch unless a correlated terminal was already recorded |

The terminal notification is journaled before the completion promise resolves or throws.
The acknowledgement is journaled inside the RPC response handler, before subsequent
notifications in the same stdout chunk. If saving dispatch intent fails, no turn write
is made. A crash between the pipe write and its receipt may leave only the earlier intent;
recovery therefore treats unfinished native records conservatively as UNKNOWN.

## Identity and privacy

`callId` is the engine's local run/phase/agent tuple. `threadStartRequestId` and
`turnStartRequestId` are exact client-assigned JSON-RPC IDs, scoped to that invocation's
connection and echoed by the response. `threadId` and `turnId` are returned native IDs.
They are distinct from upstream inference/billing request IDs. Native completions set
`requestId:null` because this protocol supplies no authoritative upstream request ID;
the old thread-ID alias is removed. Missing native IDs remain null.

`requestedModel`/`requestedEffort` are immutable user pins; `actualModel`/`actualEffort`
are thread-reported values. They are not proof of completed-model usage. Existing exact
model/effort, account, service-tier and read-only capability checks still precede the turn.

Receipts omit prompts, output text, raw errors, credentials, account details and arbitrary
host fields. Correlated `thread/tokenUsage/updated.last` fields are individually validated;
`inputTokens`, `outputTokens`, cached/reasoning/total fields retain their reported values.
Changed snapshots are journaled without summing duplicates or substituting thread totals.
The latest observed snapshot is not an independently verified turn invoice. Missing or
invalid fields are null, and subscription dollar cost stays null. Known earlier snapshots
remain available in the journal if a later snapshot is incomplete.

## Correlation and recovery

Item, usage, rerouting, tool and terminal notifications must match both the acknowledged
thread and turn. Missing or mismatched identities cannot supply an answer, charge or
completion. Account changes and transport closure apply to the connection. A bounded
pre-acknowledgement buffer (128 events / 2 MiB) is matched only after the turn ID arrives;
overflow fails closed. The first terminal or uncertain-stream outcome is latched. Duplicate
or later contradictory events cannot replace it. Text deltas alone never establish a final
answer. A terminal event arriving before a final item produces HOLD for missing output;
late items are not retroactively accepted.

Startup adds the receipt table without backfilling old identities. Recovery atomically
marks running runs interrupted, pending API exposure UNKNOWN and unfinished native
receipts UNKNOWN. Already terminal native evidence remains intact, but an interrupted
run is not promoted to an accepted council result. Same-ID execution returns the persisted
state/result and performs no provider call. UNKNOWN remains an evidence requirement for
the operator; deleting state or acknowledgement alone cannot authorize a retry.

CF-R1/CF-R2 remain unchanged: valid reported API charges settle even for rejected responses,
terminal accounting failure stops queued dispatch, in-flight calls settle in both ledgers,
and all calls retain the existing shared concurrency controls. Native receipt persistence
adds no provider retry, billing estimate, model substitution, access grant or scheduler.

## Offline regressions and remaining limits

Executable fake app-server tests cover exact RPC/thread/turn identity, early notifications,
foreign/missing identities, duplicate and out-of-order terminals, acknowledgement without
completion, invalid terminal status, partial/truncated streams, interruption with usage,
and refusal before transport when durable dispatch recording fails. Separate Node engine
processes are suspended at committed boundaries and killed: before dispatch, between
dispatch and acknowledgement, between acknowledgement and completion, and after terminal
recording before engine acceptance. Restart preserves uncertainty/evidence and never
replays. Legacy UNKNOWN records acquire no fabricated native identifiers.

These processes are fixtures, not Codex model sessions. Linux execution does not prove
Windows/macOS native process behavior. Live/embedded-host/multilingual acceptance, original
UNKNOWN reconciliation, hosted CI availability and the existing #1–#5 criteria stay open.
The existing controller owns independent review. Live admission remains revoked.

## Terminal knowledge and saved decisions

A correlated `completed`, `failed` or `interrupted` terminal establishes the native
outcome, even when the output is empty or unusable. Diagnostic `resultKnown` now reflects
that distinction; it does not mean the council accepted the output or that subscription
cost is known. Acknowledgement/partial output/transport loss alone remain UNKNOWN.
Historical receipts are not reclassified or backfilled.

`council_status` now returns the sanitized native-invocation snapshots beside the saved
run and event journal. `council_room({runId})` returns this same packet for UI reopening.
Executable offline fixtures complete two proposals, skeptic, blind verifier and chair
with exact heterogeneous pins. Killing the result consumer after durable completion but
before host delivery, reopening and same-ID invocation preserve the full decision and
five terminal/usage receipts without another dispatch. English, Russian, Japanese and
Arabic outputs cover this delivery-loss case. Existing pre-dispatch/acknowledgement/
terminal-before-acceptance crash fixtures remain mandatory. These are offline protocol
fixtures, not live provider acceptance.
