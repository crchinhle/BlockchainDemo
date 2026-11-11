# NCKH model v2 implementation and acceptance

## Specification and provenance

Read the current [NCKH document](https://docs.google.com/document/d/1_5vTB2WZ2UWpHeFeWwnxxat2bcwux4is7z0vsh7sLY8/edit), sections 3.3–3.5 and 4.1–4.5, on 2026-11-10. Read the supplied `BaiBao_BockChain.docx` and `Danh_muc_23_bai_bao_Blockchain_Licensing (1).docx`. Neither Word source nor Google Docs was modified. The bibliography is a reference catalog, not proof that all 23 full papers were inspected.

The starting checkout is `30f604aae9133733ee16c1dfeb89186b222e2ef2`. Its relayer-count contract and PostgreSQL device membership really were still present. Original SPDX/provenance, historical runs, credentials, and Docker volumes are retained. `ResearchLicenseRegistryV2.sol` is a separate deployment. New PostgreSQL tables are prefixed `v2_`; old artifacts are not migrated or relabeled. The active entrypoint now runs `runner-v2.ts`; `runner.ts` retains the historical implementation and shared export functions.

## Requirement matrix

| Source requirement | Starting implementation and gap | Implemented v2 boundary | Acceptance evidence |
|---|---|---|---|
| 3.3 L=(id,product,issuer,owner,exp,m,revoked,transferable,v,g) | Provider/count only; no owner transfer | Registry stores all fields; immutable maximum=1000; no decreasing quota | `protocol-v2.mjs`: issue, renew, transfer, revoke, expiry |
| 3.3–3.4 I1/I2 atomic device cap | PG lock; contract trusted relayer count | Generation-indexed membership and count updated atomically inside contract; repeated member leaves count/version unchanged | 10 competing transactions for 2 free seats yield exactly 2 successes; all ten nonces reconciled from blocks, including reverted receipts |
| 3.4 issuer/owner authorization | One privileged relayer | Product issuer registration by administrator; `msg.sender` checked on every mutation; separate unlocked local owner/issuer accounts actually sign transactions | Wrong issuer/owner rejected; owner transfer and terminal revoke verified |
| 3.4 replay handling | Backend payload binding only | On-chain request key binds sender/id/g/requestId; payload hash binds operation/device; stored result version is queryable | Same payload no effect; changed payload rejected; old activation replay after deactivation does not regrant; old owner after transfer rejected |
| 3.3 generations | Fixed generation 1 | Transfer/revoke increment g, clear effective count without iterating old devices, increment v | Old membership inactive after transfer/revoke; renew cannot revive revoked ID |
| 3.3 expiry | Runtime inferred status | Contract uses block time; verifier checks wall time and observed block time; renewal increases expiry, retaining members | Real-time expiry and renewal after expiry; no scheduler changes status |
| 3.5 Direct | Chain status plus PG membership | One contract snapshot call for L and member at fixed accepted block; canonical hash checked; no PG permission read | Direct authorizes correct chain member after PG device copy is deleted |
| 4.1 Centralized | Revoke waited for chain | Independent v2 PG authority, row lock, transactional member/count/version; reference is commit acknowledgement | Exact admission under contention; revoke/observe with unusable RPC; no chain commands in centralized runner |
| 3.5 Hybrid | Chain status cache and PG membership | Same registry as Direct; cache keyed by domain/chain/contract/license/device; source observation anchored before RPC | Cache hit does not slide age; changed-version fence and late read rejection |
| 3.5 token and proof | HS256 shared secret | ES256 signature; one-use signed Redis challenge; license/product/key/domain binding; token binds owner/v/g/chain/contract | Valid, replay, modified token, wrong product, rotated signing key tests |
| 3.5 TTL | Bounded legacy policy | `min(iat+T, observationStart+min(C,freshnessMs), licenseExpiry)`; ms deadline enforced | Cache age and outage tests; inherited deadline unit tests |
| 3.5 invalidation/recovery | Revocation-only events, epoch | Version fence for every Changed event; durable number/hash checkpoint; polling catches dropped events; checkpoint reorg fails closed | Delayed fill, dropped event, polling, new verifier checkpoint recovery in `faults-v2.mjs` |
| 4.4 references/measurement | Shared chain-confirmation reference | Central commit vs chain confirmation recorded separately; submit/inclusion/confirmation events and raw command receipts | `runner-v2.mjs`, five-scenario HTTP smoke |
| 4.4 evidence retention | Frozen JSON | Schema v2 includes command intents/receipts; failed and interrupted runs retained; RPC attempts counted even on policy denial via async-local counters | Frozen export checksums, sample counts and secret-redaction checks in HTTP smoke |

## Actual architecture and trust assumptions

The browser manages experiments via the NestJS research API. BullMQ dispatches a single worker. That worker invokes the verifier in process and stores append-only sample/event rows. The browser is not the load generator. These timings include challenge/signature/token/decision service work but are **not remote HTTP end-to-end license latency**. API orchestration being HTTP does not change that boundary.

For Blockchain, the local node signs transactions using two distinct unlocked development accounts. This is direct sender authorization, not delegated relayer authorization. There is no wallet UI or production custody claim. The contract administrator only registers product issuers; it cannot bypass owner checks. PostgreSQL stores operational command evidence; no Blockchain authorization requires a matching PG member row.

For Centralized, registered product/issuer data and license JSON live in PostgreSQL. Mutation takes `FOR UPDATE` on the license and changes membership, count and v/g in the same transaction. The library receives an authenticated principal from the trusted experiment harness; it is not an unauthenticated public lifecycle endpoint. A snapshot uses one SQL statement for license plus membership. No Blockchain read/send is required for this authority.

Redis holds one-use challenges, bounded snapshots, known versions and epoch fences. Cache hit never updates observation time. `freshnessMs` is an additional maximum lifetime of the same observation, distinct from cache storage TTL; effective lifetime is the minimum. It does **not** establish how far an adversarial or indefinitely stale RPC lags the actual chain. Head selection uses `head-(confirmations-1)`; all decision fields share that block. Observation starts before the RPC sequence, so late responses lose lifetime rather than gaining it.

Tokens are ES256 asymmetric signatures, not an HS256 MAC. The verifier checks product, device key, owner, g/v, system domain, chain, contract, audience and millisecond deadline. Keys are per verifier instance: restart invalidates previous tokens and requires reissue. This is a fail-closed lab lifecycle, not durable production signing-key rotation. A copied device private key still represents the same logical device; physical-machine uniqueness is not provided.

Confirmed Changed logs and polling advance known v. In-flight cache fills compare epoch and v before saving. Cached entries older than known v cannot be reused. Old signed tokens are rejected after the enforcement point knows a newer v. A missed event permits explicitly measured stale acceptance until polling or bounded expiry. Reorg checkpoint/hash mismatch sets an unsafe fence; recovery is a fresh experiment/domain and snapshot. Automatic fork rollback and high-availability indexer recovery are not claimed.

## Submission, timeout and restart

The worker submits writes sequentially; acceptance competition tests allocate explicit per-sender nonces and inspect mined order. Policy reverts are not counted as nonce failures. Hardhat can return a revert error directly from `eth_sendTransaction` even when the transaction is mined; the test reconciles these nonces against block transactions and retains gas/status.

Each runner command records intent before send, hash after broadcast, then receipt. Startup reconciles known hashes without resubmission. A crash between broadcast and hash persistence remains `INTERRUPTED_OUTCOME_UNKNOWN`; this is an explicit unresolved receipt window, not proof of failure or permission to repeat a mutation. On-chain activation request results remain queryable by `requestKey`/`requests`. A repeated request returns the historical version, never current authorization. Interrupted measurement timelines are not resumed; partial evidence is frozen.

## Specification differences and uncompleted research work

Update 2026-11-11: a separate-process HTTP refresh workload, Centralized-cache ablation, API/generator CPU/RAM samples and run-level paired bootstrap analysis are now implemented; see [http-benchmark.md](http-benchmark.md). The paragraph below records the prior v2 boundary; its statements that those components were absent are superseded by that extension. Formal-scale execution and whole-stack resource measurements remain uncompleted.

The original Word proposal and current chapter 4 use different E1–E6 labels and planned loads. This implementation follows the current chapter's policy semantics; it does not silently treat the Word's older concurrency experiment labels as the new E2/E3 definitions.

The implementation and tests are a functional foundation, **not completion of all chapter 4–5 experiments**. The UI retains bounded smoke workloads (at most 5 licenses, 100 scheduled ticks/s); the proposed 1k/10k/100k population, 25–400 request/s campaign, separate-process HTTP load generator, CPU/RAM sampling, 10 randomized paired repetitions and bootstrap analysis are not implemented here. No superiority or confidence interval is claimed. The additional Centralized cache/token ablation is not implemented, so cache benefits cannot be attributed solely to Blockchain. Package download/distribution is not added.

Delta and epsilon are not established upper bounds. Manifests explicitly retain null bounds, and no `W_design` guarantee is asserted. Local automining is not public-chain consensus or real-network delay. Block time can advance ahead of wall time during rapid transactions; snapshots expose chain timestamp. The current reorg handling is fail-closed, not transparent recovery. The full matrix of 10/50/100/200 contenders, 5/30/180-second outages, all crash windows, and all lifecycle interleavings still requires a formal campaign. Existing v1 evidence does not prove those v2 properties.

## Reproduction

From repository root, compile contracts and backend, then initialize only through Compose:

```powershell
corepack pnpm --dir EmuKey/backend/contracts build
corepack pnpm --dir EmuKey/backend build
corepack pnpm --dir EmuKey/backend typecheck
corepack pnpm --dir EmuKey/backend lint
corepack pnpm --dir EmuKey/frontend build
corepack pnpm --dir EmuKey/frontend typecheck
corepack pnpm --dir EmuKey/frontend lint
docker compose -f EmuKey/compose.research.yml up -d postgres redis
docker compose -f EmuKey/compose.research.yml run --rm database-initialize
node EmuKey/scripts/research-local.mjs
```

The launcher requires its ports to be free; do not start a second instance over an existing run. With services already running, backend cwd `node dist/entrypoints/research/main.js --setup` deploys v2 if absent, preserving v1 settings and credentials. Restart API/worker to load the new build, leaving the chain and Docker data intact.

In another terminal:

```powershell
node --test tests/emukey/research/domain.test.mjs
Push-Location EmuKey/backend
node ../../tests/emukey/research/protocol-v2.mjs
node ../../tests/emukey/research/faults-v2.mjs
node ../../tests/emukey/research/runner-v2.mjs
node ../../tests/emukey/research/runner-v2.mjs --central-offline
node ../../tests/emukey/research/reorg-v2.mjs
Pop-Location
node tests/emukey/research/http-smoke.mjs
Push-Location EmuKey/frontend
node scripts/research-e2e.mjs
Pop-Location
```

Run integration suites sequentially on the dedicated local chain. Test fixtures use new random license IDs; no cleanup deletes history. Protocol reports, including failed attempts, are retained in ignored `EmuKey/backend/.research-local/evidence/`; runner datasets are frozen in `research.artifacts`. Credentials are never included in exports.

`reorg-v2.mjs` starts and stops a separate EVM on port 58546; it does not revert the main chain. `restart-v2.mjs <verified-worker-PID>` intentionally interrupts its own test run and replaces the worker; verify the PID belongs to this workspace and that no other run is active before invoking it.
