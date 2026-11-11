# HTTP measurement and centralized cache ablation

This extension (2026-11-11) adds a separate-process HTTP load path. Existing UI/BullMQ runs remain in-process experiments and retain their original measurement boundary. No old dataset is converted to an HTTP result.

## Runtime and measurement

`http-benchmark.ts` is served by the existing NestJS research entrypoint, under authenticated `/api/research/benchmarks` endpoints. A session selects Centralized, Centralized-cache, Direct On-chain or Hybrid. Preparation creates fresh license fixtures in the existing v2 authorities. It is excluded from measured request latency. Preparation intents/completion events and the session manifest are stored in versioned PostgreSQL tables; a restart marks unfinished sessions INTERRUPTED and does not resume or resubmit them.

`tooling/emukey/research/http-load.mjs` is a separate Node process. One timed operation includes challenge HTTP, client device signature, token issuance HTTP, another one-use challenge/signature and protected verification HTTP. All four strategies use this same boundary. Tokens and device private keys remain in memory, never in sample files. This is an online refresh workload, not a token-reuse benchmark. A token may expire between issue and verification; such denials remain in the samples as availability outcomes, not successful valid decisions.

Centralized-cache reuses `VerifierV2` with a PG snapshot source, Redis age/version fences and ES256 tokens. It uses exactly the same `min(iat+T, observationStart+C, licenseExpiry)` rule as Hybrid. The HTTP harness's controlled revoke action commits/receives the receipt, records its reference, then directly invalidates the session's verifier. It does not simulate event delivery delay or poll recovery: those faults remain covered by the v2 protocol/runner tests. No claim of instantaneous global revocation or a new Δ/ε bound follows from this path.

The sender uses an open-loop global request schedule (rate is total operations/second, not per fixture). It records planned time, actual dispatch lag, completed latency, concurrency drops, transport errors and timeouts. Timeout is per HTTP exchange; a full logical operation can contain four exchanges. A timeout does not establish that the server did not complete. Pending operations are drained before the session closes. SIGINT/SIGTERM stops scheduling and retains partial evidence. Abrupt process termination may leave an incomplete NDJSON file without a checksum manifest; preserve it and do not treat it as a completed run.

Uniform and 80/20 hot-set distributions use a seeded schedule. In hot80 mode, 80% of selections target the first ceil(20% of licenses); the remainder target the other licenses. The same logical schedule is reused across strategies for each repetition. Strategy execution order is shuffled per seed. Random private keys are intentionally not reproducible secrets.

## Resource and statistical boundaries

Once per second the generator reads cumulative CPU time and RSS/heap from the API process and records its own CPU/memory. Analysis converts CPU deltas to percent where one logical core is 100%. These are **API and generator process measurements only**, not EVM/PostgreSQL/Redis or whole-machine resource totals. The authenticated metrics request adds measurable overhead and is outside individual protected-request latency.

`analyze-http.py` first verifies every SHA-256 checksum. It preserves failed/incomplete runs, counts every result class, reports dispatch lag, completed-response quantiles and timeout durations separately, and summarizes process resource samples. Paired differences and 10,000 bootstrap resamples use the repetition/seed as the independent unit; requests within a run are not treated as independent repetitions. Fewer than two matched runs produces no confidence interval. Two runs are only a smoke test of the analysis machinery, not an adequate basis for an inferential performance claim. P99 below 10,000 observations is explicitly descriptive.

## Commands

Build backend and initialize the additive schema with the existing Compose initializer, then run the local API and EVM as documented in `model-v2.md`. From repository root:

```powershell
node tooling/emukey/research/http-load.mjs
node tests/emukey/research/http-load.mjs
node tooling/emukey/research/http-load.mjs tooling/emukey/research/http-pilot.json
python tooling/emukey/research/analyze-http.py <evidence-directory>
```

The first command is a short four-strategy smoke. The test uses a controlled revoke to assert pre/post decisions and zero verifier RPC for both centralized configurations. The pilot is 10 licenses, 25 operations/s, 5 measured seconds, 1 second warmup, two seeds and a hot80 workload. It is deliberately labeled pilot.

Evidence is stored in a uniquely named ignored `.research-local/evidence/http-load-*` directory. `config.json` freezes settings, `schedule.json` records order/host/generator hash, each NDJSON file records the server manifest, preparation, raw requests, resources and final state, and `checksums.json` binds the raw files. Analysis writes a new `analysis.json` exclusively and refuses to overwrite it. Database session metadata is operational evidence; client-side raw files are the latency authority.

Limits allow up to 100,000 fixtures, 400 operations/s and ten repetitions, but this is an input capacity, not evidence that those workloads have been executed or supported without overload. Large on-chain preparation uses real sequential transactions and may take substantial time. The formal chapter 4 campaign (long warmups, long observation, full dataset sizes and resource isolation) must be executed and reported separately. Whole-stack resource monitoring, token-reuse HTTP load, formal Δ/ε experiments and full statistical adequacy remain open.
