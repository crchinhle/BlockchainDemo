# Verification — 2026-11-10

This is a runnable research-local vertical slice, with remaining scope explicitly listed in model-alignment.md. No mainnet, Sepolia, commercial API, source database or paid service used. Tests below actually executed on Windows, Node 22.21.0, Docker Desktop Linux containers, PostgreSQL 15, Redis 8.2 and real Hardhat EVM 31337.

## Executed checks

| Command / experiment | Observed result |
|---|---|
| Frozen pnpm backend/frontend installs | Passed; source lock versions retained |
| `corepack pnpm --dir EmuKey/backend/contracts build` | Original Solidity registry compiled |
| Backend `build`, `typecheck` | Passed |
| Backend scoped ESLint `src/modules/research src/entrypoints/research` | Passed after fixing typed OpenAPI declarations |
| Frontend typecheck, scoped ESLint `src/research`, Vite research build | Passed |
| `node --test tests/emukey/research/domain.test.mjs` | 5 tests passed: TTL, validation, in-flight ambiguity, last-stale/censoring, CSV formula safety |
| `node tests/emukey/research/http-smoke.mjs` | 5 real-EVM runs passed; checks actual issue/activation/warm/revoke/confirmation, post-confirmation probes, auth/validation, frozen JSON hash, CSV counts and redaction |
| Backend cwd: `node ../../tests/emukey/research/protocol.mjs` | Passed: same-payload idempotency, changed-payload rejection, PoP replay, repeated activation, max_devices, generation binding, late cache refill epoch fencing, sentinel unaffected, 403/cross-owner access |
| Frontend cwd: `node scripts/research-e2e.mjs` | Passed login → Smoke Start → close tab → reopen/resume → COMPLETED → report → JSON/CSV/PDF/PNG downloads |
| Worker killed while OBSERVING, restarted | `ac3a07a9-c3c7-4df9-8cb4-952850dee28f` became INTERRUPTED; broadcast hashes unchanged; no duplicate revoke |
| Cancellation while OBSERVING | CANCELLED, 22 partial samples retained, confirmed receipt retained |
| `python tests/emukey/research/reorg.py` | `dd8c5bf8-5aab-438e-bcbd-7887ab749b9f`: reverted dedicated local chain after confirmation; FAILED / INVALID_FOR_ANALYSIS detected, partial evidence retained |
| UI smoke after reorg | `aefe3756-a967-4804-aadf-c44d2e456be9` completed with report exports |
| 10 repetitions | `b22bead6-e5f7-4709-b090-0adaa405a83b`: 10 COMPLETED, 1,340 samples; independent Python re-analysis passed all repetitions |
| Docker SQL initializer | `psql` in one-shot container exited 0; pre-existing 7 runs preserved at migration check |
| Compose config, `git diff --check`, workspace hygiene | Passed. Independent repository is uncommitted/untracked, so diff check alone is not a source-provenance check |
| PDF/PNG QA | Actual downloads rendered with ReportLab/Pillow; PDF pages rendered using PyMuPDF because Poppler was unavailable; layout and UTF-8 reviewed visually |

## Latest five-scenario integration set

These are smoke integration measurements, **not controlled performance comparisons**. Build/lint activity shared the host; no CPU/memory isolation or statistical superiority claim. The nonzero error in event-drop and the injected RPC failures are retained rather than hidden.

| Run | Samples | Definite stale accepts | W observed (ms) | Technical errors |
|---|---:|---:|---:|---:|
| `44efb9d8-80e2-475b-b8a4-c80c3cc8602a` Hybrid | 138 | 0 | Not observed | 0 |
| `6feb4bde-669e-418e-9a6b-b3b01e679a97` Direct | 150 | 0 | Not observed | 0 |
| `fea666d1-812b-43b4-bf32-ce60b34b54d2` Centralized | 134 | 0 | Not observed | 0 |
| `5c78259b-901f-45ab-982a-4c7beee966e7` Dropped events, long polling | 150 | 39 | 3498 | 1 |
| `69c49374-961c-4d08-a0b4-ee8945957a31` RPC outage | 150 | 0 | Not observed | 24 |

An earlier event-drop run observed 60 stale acceptances / 4022 ms; it is a separate retained run, not overwritten by the latest. A healthy event path can still admit stale authorization before invalidation reaches the verifier; earlier smoke observed one such acceptance. No observed stale samples does not establish a zero real-world stale window.

## Evidence and reproduction

Raw frozen JSON is stored durably in PostgreSQL `research.artifacts`; HTTP smoke writes local exports to ignored `EmuKey/backend/.research-local/evidence/`. Each export contains source commit, runtime code hash, ABI/bytecode hashes, immutable config, raw events/samples, formula version and canonical dataset checksum. PostgreSQL/Redis are persistent Docker volumes. Chain history is ephemeral across node restarts; exported receipts remain historical evidence but are not a live explorer substitute.

`tooling/emukey/research/verify-export.py` recomputes per-repetition sample/stale counts and percentile values without importing application code. The JS HTTP test independently canonicalizes JSON before hash comparison. Browser samples are observed through application-service calls in the worker, not remote HTTP license-server latency.

## Not claimed

The full original commercial test suite, all security permutations, distributed workers/multi-host clocks, all crash windows, full source-freshness/Byzantine RPC model, complete response DTO generation, high-volume stress and every TTL sweep combination have not been validated. Ten smoke repetitions demonstrate repeatable execution, not a finished research dataset proving security or performance. See model-alignment.md for precise feature limits.

## Verification after source-folder reduction

At the user's request, unused commercial/mobile source, tests/tooling, CI and copied agent/editor/context directories were removed from the project. Automatic approval review blocked the initial bulk deletion command. A safer reversible move placed those files outside the workspace in a temporary recovery directory; no permanent deletion occurred.

- Backend and frontend default package `build` and `lint` scripts passed against the reduced tree. TypeScript compilation is part of both builds.
- Original Hardhat contract build passed; artifacts remained available.
- All retained backend relative imports resolve; 10 backend source files remain.
- All 5 domain tests passed.
- Playwright completed `d5bbcf4f-324f-465b-afc7-2e721e468cb2`: login, start, close/reopen tab, completion, report and export.
- PostgreSQL remained healthy; previous runs remained, with one additional completed E2E run (20 completed runs total at this check).
- `git diff --check` passed. The frontend retains its existing large-bundle warning; no bundle-size optimization was undertaken.

Dependencies and lockfiles were retained. Local credentials, evidence, Docker volumes, the independent `.git` directory and required runtime artifacts were excluded from removal.
