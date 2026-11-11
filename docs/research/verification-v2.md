# Model v2 verification — 2026-11-10

## HTTP extension — 2026-11-11

Implemented and tested a separate Node HTTP generator and Centralized-cache ablation; details and commands are in [http-benchmark.md](http-benchmark.md). Backend build/typecheck/lint, frontend build/typecheck/lint, the five domain tests, protocol-v2 and fault-v2 regression suites passed. Schema initialization used the Compose initializer and preserved existing data.

The HTTP revocation acceptance test passed all four strategies, 15 samples each, with ALLOW before revocation and DENY after the recorded reference plus a 200 ms test margin. Both centralized variants recorded zero verifier RPC calls. Raw files contain no token fields. Evidence directory: `.research-local/evidence/http-load-1794374143370-10071ee8-1c7a-4f15-a440-798a18c34fe1`.

Pilot `http-pilot.json` executed 10 fixtures per configuration, 25 globally scheduled operations/s, 5 measured seconds, 1-second warmup, two repetitions (seeds 1001/1002), shuffled strategy order and 80/20 access. Eight runs retained 1,000 samples: 989 ALLOW, 11 DENY from token expiry, no ERROR/TIMEOUT/DROPPED. Centralized-cache had 3 expiry denials and Hybrid 8; these are availability losses during the multi-exchange request and were not discarded. All 250 requests each for Centralized and Direct allowed. The maximum per-run dispatch lag ranged from 11.4 to 27.2 ms.

Pilot evidence: `.research-local/evidence/http-load-1794374277844-2339e903-f33b-47c3-b549-31acd9359c9f`. `analyze-http.py` verified checksums and wrote eight per-run summaries plus paired bootstrap output. API and generator CPU/RSS were sampled; this is not whole-stack monitoring. Some frontend typecheck/lint work overlapped early pilot preparation/execution. These short, shared-host runs are not controlled performance results and establish no superiority or theoretical bound. The subsequent addition of preparation transaction receipts is separately verified; the pilot keeps its original source hashes.

A first generator attempt ran before API startup and failed with ECONNREFUSED. Its directory remains retained. The generator now records startup failures explicitly. The launcher also refused a second instance when its ports were occupied; no existing process/data was reset by that refusal.

After adding retained preparation transaction intents/receipts, the four-strategy HTTP revocation acceptance passed again (60 samples) in `http-load-1794374472984-34eb11a2-4b6b-4605-be00-e5110008fb3d`; checksum analysis passed. Final receipt timestamps are taken after canonical confirmation and before database event logging. UI regression also passed: `c512e458-995b-47f4-9274-70b3dbabc325` completed login/start/reopen/report/export.

The sections below retain the earlier v2 results.

These results were actually observed on the local Windows workspace, Node 22.21.0, Hardhat chain 31337, PostgreSQL and Redis. They are functional smoke/acceptance evidence, not a controlled performance campaign. Starting Git commit is `30f604aae9133733ee16c1dfeb89186b222e2ef2`; modifications are uncommitted. Each runner manifest includes the current runtime source hash, base commit and contract hashes. No push, external deployment, reset, volume deletion or paper edit was performed.

| Command (root unless indicated) | Actual result |
|---|---|
| `corepack pnpm --dir EmuKey/backend/contracts build` | New v2 Solidity compiled successfully with 0.8.34 |
| `docker compose -f EmuKey/compose.research.yml run --rm database-initialize` | Versioned tables created; repeat initialization passed, historical tables retained |
| Backend `build`, `typecheck`, `lint` | Passed; an initial lint type assertion and later untyped query were fixed |
| Frontend `build`, `typecheck`, `lint` | Passed; existing >500 kB bundle warning remains |
| `node --test tests/emukey/research/domain.test.mjs` | 5 tests passed |
| Backend cwd `node ../../tests/emukey/research/protocol-v2.mjs` | Real contract/PG/Redis policy, authorization, replay, quotas, transfer, renewal, terminal revocation and expiry passed; JSON evidence retained |
| Backend cwd `node ../../tests/emukey/research/faults-v2.mjs` | Late read rejection, dropped event plus polling invalidation, checkpoint reuse, restart token rejection, RPC outage expiry, old token after transfer, expired/wrong-key proof passed |
| Backend cwd `node ../../tests/emukey/research/reorg-v2.mjs` | A separate ephemeral EVM at port 58546 detected checkpoint reorg and persisted unsafe fence; main EVM at 58545 untouched |
| Backend cwd `node ../../tests/emukey/research/runner-v2.mjs` | Three strategies completed, 52/52/54 samples; 0 technical errors in those preliminary runs |
| Backend cwd `node ../../tests/emukey/research/runner-v2.mjs --central-offline` | Centralized completed against intentionally unreachable RPC, 52 samples, 0 errors, no chain commands; run `85bf1d51-48e0-4f4e-bbc5-c3f8d80105a7` |
| `node tests/emukey/research/http-smoke.mjs` | Five scenarios passed HTTP orchestration, real state changes, frozen checksum, CSV row counts and credential redaction checks |
| Backend cwd `node ../../tests/emukey/research/restart-v2.mjs <verified-worker-PID>` | Run `43fa9a1c-44bc-4c2a-a991-861ac2ef47a2` became INTERRUPTED with 16 samples, unchanged broadcast hashes and frozen artifact; replacement worker started |
| Frontend cwd `node scripts/research-e2e.mjs` | Login → start → close/reopen tab → completion → report and JSON/CSV/PDF/PNG downloads passed; run `557ac7c2-17a4-4187-811b-0c7e8d95bcbd` |
| `git diff --check` | Passed (line-ending notices only); untracked new files are separately built/tested |

## HTTP smoke with RPC-attempt instrumentation

These runs use the same host as build/lint work. Their counts are integration observations, not estimates of throughput advantage. The runtime was subsequently hardened for reorg monitoring and cached-read ordering; these frozen records retain their own code hashes and are not relabeled as evidence for later edits.

| Strategy/scenario | Run | Samples | Technical errors | Verifier RPC attempts | Requests with cache hit | Stale allows |
|---|---|---:|---:|---:|---:|---:|
| Hybrid | `5d21ad56-6531-4125-9e73-d1abbc1562fe` | 134 | 0 | 8 | 65 | 0 |
| Direct | `9af10f18-682e-4672-b8b5-3169cd45ba34` | 136 | 0 | 404 | 0 | 0 |
| Centralized | `67bf6617-9c10-4efa-9a86-871c9156c716` | 132 | 0 | 0 | 0 | 0 |
| Dropped events, long polling | `368900c1-d802-41c6-baf9-c684b0057790` | 132 | 0 | 4 | 65 | 61 |
| Injected verifier RPC outage | `3db8026d-b575-4d59-b2b5-14af1f19236d` | 132 | 20 | 312 | 0 | 0 |

RPC counts cover verifier state-read attempts, including decisions ending in rejection. They exclude background reference/synchronization traffic, which must not be interpreted as total node traffic. `cacheHits` counts requests with a cache hit, not all cache lookups. Latencies remain in-process protected decisions, not HTTP network latency. No observed stale acceptance does not establish zero stale window.

## Retained failures and limits

Initial protocol attempts failed when the harness treated Hardhat's RPC-level `DEVICE_LIMIT` revert as a transport failure. The corrected test uses explicit nonces and reconciles every mined transaction, including gas/status of reverts. Another attempt incorrectly compared block expiry against wall time; it exposed advancing local block timestamps. That test now checks the appropriate clock, and verifier snapshots record/check both. Failed protocol JSON files remain in `.research-local/evidence/`.

One HTTP run (`9c6c001d-c26f-4417-afef-11eebe9cc7c4`) recorded `CACHE_EPOCH_CHANGED` at revocation; it is retained as a fail-closed availability error rather than removed from samples. Two test invocations raced API startup and received ECONNREFUSED before creating a run; they are startup failures, not completed experiments. The restart test now waits for API availability.

See [model-v2.md](model-v2.md) for the acceptance matrix, architecture, reproduction commands and open chapter 4–5 work. In particular, no proven Δ/ε bound, separate-process HTTP load campaign, large dataset campaign, CPU/RAM monitoring, centralized-cache ablation or exhaustive crash/interleaving coverage is claimed.

## Final hardening rerun

After adding monotonic cache-fill ordering, conservative reference failure handling and canonical receipt reconciliation, protocol tests passed again, including Centralized lifecycle parity and activation interleaved with revocation. Fault and isolated reorg tests also passed again. The runner completed `8a790e63-8c6f-4922-abf0-26ca76f21f99` (Centralized), `63815804-fb9c-49a1-8642-396cd8088af9` (Direct), and `515186c1-7c9a-4250-aba8-af68a1e6ae5b` (Hybrid), each with 52 samples and 0 technical errors. Backend build/typecheck/lint and all five domain tests passed.

Before this rerun, the lab containers and EVM had stopped between work sessions; the test attempts failed at PostgreSQL connection initialization (`ECONNREFUSED`, no experiment created). Dedicated lab containers were restarted with their existing volumes. A new local EVM instance was started; old run manifests and artifacts remain tied to their historical chain evidence, not treated as live state on the new node.

Final UI E2E passed again on the reloaded API/worker: `3ecf9c09-4577-4aa9-8614-8b8f9c190e42`, including report exports. The additional two-concurrent-read test passed: an older RPC completion cannot replace a newer cache entry even without an intervening event. The lab API/UI, local EVM and persistent PostgreSQL/Redis were left running at their documented ports.
