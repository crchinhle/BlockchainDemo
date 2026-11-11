# Model alignment

**Version notice (2026-11-10):** the table below is the retained v1 boundary at commit `30f604a`. The active research entrypoint now uses model v2. See [the v2 requirement matrix, architecture, tests and explicit remaining gaps](model-v2.md). Do not apply v1 measurements or the following historical implementation descriptions to v2.

The supplied prompt is the research specification. No external paper/Google Doc was available or modified.

| Requirement | Implemented boundary / limitation |
|---|---|
| Actual EVM transactions | Original registry compiled/deployed on Hardhat 31337, tx hash/receipt/block/gas/fee recorded |
| Device membership | PostgreSQL row locks, maximum count, repeated same device/key idempotent; key conflict rejected. Contract count synchronization is trusted relayer input |
| DIRECT_ONCHAIN | Fixed block getLicense plus canonical hash check for each protected decision and refresh; PostgreSQL binds devices. Never labelled fully on-chain |
| CENTRALIZED | PostgreSQL authority for decisions; benchmark still sends revoke transaction and commits revoked state after reference confirmation. This is a specific shared-revocation experimental policy, not a pure standalone centralized deployment |
| HYBRID | Redis snapshots and signed credentials, fixed observation deadline; JWT ms deadline strictly enforced, NumericDate rounded up only for outer JWT expiry |
| Bounded TTL | min(iat+T, snapshot+C, snapshot+freshness threshold, license expiry). C/T=0 rejected |
| Proof of possession | Signed unique Redis challenge consumed atomically for activation, issuance and protected execution; device/license/product/generation/version binding |
| Old credential | Old token retained in worker memory, reused after revocation; refresh clients separately issue then execute |
| Invalidation | Separate event-log consumer with PostgreSQL checkpoint; Redis epoch rejects late cache refill; polling fallback. Delay/drop applies to event path only |
| Reference observer | Independent RPC reads/receipt canonical check unaffected by verifier RPC fault injection |
| Jobs | BullMQ + PostgreSQL state; browser is not load generator. Restart interrupts active measurements rather than joining timelines. Commands retained/reconciled, never automatically duplicated |
| Config/records | DRAFT config becomes immutable at Start; API events append-only, frozen dataset checksummed using canonical JSON. Admin DB edits remain possible |
| Model owner/v/g | Provider address in source contract; generation in PG (initial 1), token checks binding; no owner transfer/generation rotation protocol implemented |
| Metrics | Per repetition/client/license, monotonic latency, UTC span, definite stale requires start/evaluation after reference; censored when final observed client allows; no unproven theoretical bound |

## Explicit remaining acceptance gaps

This is a working local vertical slice, not completion of every item in the prompt. Full Sepolia profile, original provider-server path benchmark, customer transfer/royalty/mobile, multi-host clock bounds, process CPU/RAM, comprehensive source-freshness fault suite (local post-confirmation reorg detection passed), original indexer reuse with full product schema, multi-user provisioning, per-request cancellation deadline, exhaustive interrupted-transaction crash-window tests (one observing-worker restart and cancellation have passed), fully typed response schemas in OpenAPI (configuration types are generated), advanced sweep distribution analysis, production deployment hardening remain outside the verified slice. The local researcher account is single-user; ownership checks exist but multi-user provisioning is not exposed.

The open-loop cadence uses `rate`; `probeMs` must match 1000/rate and is reported as resolution. Seed labels a deterministic timing/workload schedule, not cryptographic fixture keys (keys must remain fresh random secrets). Sequential execution avoids transaction nonce contention; benchmark throughput includes in-process application boundary/PoP overhead, not a separate HTTP license server/network transport latency. UI/API traffic is HTTP, measured protected probes are application-service calls. Do not present those latencies as remote HTTP response latency.

For a paper, synchronize: exact hybrid policy, polling fallback, centralized revocation policy, trusted relayer and off-chain membership, source/code hashes, measured boundary, client grouping, repetition sample counts, censored/failed results and confirmed observation horizon. Do not rewrite the paper to hide these differences.
