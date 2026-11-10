# Source audit — 2026-11-10

Source: https://github.com/crchinhle/MCP_API, HEAD independently resolved by `git ls-remote`: `8357c8c1ca7af68ff36bd5bc87641702d6679f27`.
The workspace was empty. Retrieved a commit-pinned ZIP, without Git history. Created independent Git metadata; no commit, push or source checkout modification. Archive extraction excluded `.env*`, dependency/build/cache trees, database extensions and credential/private-key filenames. No source database was contacted. An archive cannot expose a local nested `.git`; none was present, and no nested repository was deleted.

Read root AGENTS.md (no nested AGENTS found), EmuKey README, current context, package manifests/lockfiles, licensing service/controller/DTO, provider handoff gate, registry contract, crypto utilities, query/command/indexer and projection boundaries. Source uses pnpm 11.25.0, Node 22.21.0, NestJS 12.0.1, pg 8.23.0, Redis client 5.11.1, BullMQ 6.3.4, viem 2.56.3, jose 6.2.10; frontend React 19.2.8, Vite 8.2.2, Ant Design 6.6.2, TanStack Query 5.102.8. Locks installed frozen successfully. Contract toolchain Hardhat 3.15.0, Solidity 0.8.34; compile executed successfully.

| Source owner/file | Research treatment | Evidence/reason |
|---|---|---|
| backend/contracts/solidity/LicenseRegistry.sol | Reuse unchanged, deploy to chain 31337 | Issue/revoke/status and relayer-controlled count; SPDX MIT retained |
| backend/src/platform/crypto/license-crypto.ts | Import existing code | UUID bytes16, plan/activation commitments |
| platform/database/database-pool.ts, platform/redis/redis-client.ts | Import existing providers | Explicit SQL/pg and bounded Redis retry |
| licensing/licensing.service.ts | Preserve source; research strategy is separate adapter | Provider handoff prohibits original consumption path for new licenses |
| licensing/application/provider-handoff.service.ts | Preserve checks; not loaded by research entrypoint | `rejectProductUse` rejects PROVIDER_HANDOFF |
| blockchain/application/license-query.service.ts | Not a verification benchmark | Public verify calls repository `findPublic`, with Redis rate limit; not direct eth_call |
| chain-command.service.ts / viem-chain-relayer.ts | Preserve source; research command adapter uses same contract | Original integrates encrypted envelopes, commerce rows, nonce/outbox/reconciliation. Research supports no automatic resubmission, marks interrupted timelines |
| rpc-chain-indexer / chain-indexer / projection repository | Preserve source; independent research event consumer | Source checkpoint/range/reorg logic coupled to original schema; research uses its own checkpoint and canonical block checks |
| database/schema.sql | Preserve original | Original product schema authority; research.sql exclusively owns separate `research` schema |
| identity-access | Preserve original; local researcher session adapter | Original user schema and commercial roles not initialized in isolated lab |
| frontend | Preserve original entrypoint; add research.html | Reuse packages, font and component system; original generated commerce client does not describe new API |
| tests/emukey + tooling/emukey | Preserve; add research tests | Original fixtures do not count as new integration evidence |
| mobile, SePay, Brevo, FCM, Gemini, Cloudinary | Not loaded in lab | No related credentials or external calls required |

## Post-audit scope reduction

After the initial audit and working lab verification, the user requested removal of unused folders. The table above records the initial source assessment. Commercial source modules, original schema/UI, mobile/Android apps, their tests/tooling, deployment scaffolding and copied agent/editor/context trees have now been removed from this independent variant. They remain available at the pinned upstream commit. The lab retains the unchanged registry and three original platform providers listed above, research code/tests/docs, runtime configuration and source manifest. Package dependency versions and frozen lockfiles remain unchanged. No historical research data or Docker volume was removed.

## Actual source flows

New checkout commits payment/license/key ciphertext/chain command, worker relays issuance, canonical projection triggers provider outbox, provider ACK enables buyer key delivery. Provider server owns actual product whitelist. Legacy activation verifies key commitment and signed challenge, creates device command; token issue/refresh reads projection plus active PostgreSQL device; protected verification verifies JWT and rereads projection/version/generation. `ENTITLEMENT_TTL_SECONDS = 300`, capped by license expiry, rounded down to seconds in source. This is not a Redis entitlement-cache TTL.

Source `LicenseRegistry` has `processedCommands` and rejects duplicate IDs, but does not bind a repeated command ID to a payload hash on chain. The application supplies payload integrity. `syncActiveDeviceCount` is restricted to RELAYER_ROLE and checks maximum/version; contract does not maintain device-key membership. Admin grants relayer roles. LicenseData stores provider, not the research model's customer owner.

Four distinct stores: (1) Redis activation envelope is short-lived delivery of a secret; (2) a research permission snapshot cache is a new explicit feature; (3) entitlement JWT is a signed credential with expiry; (4) PostgreSQL projection is durable indexed state, not itself a live RPC read. Source public license information is not entitlement enforcement.

## Licensing and evidence boundaries

No root LICENSE was found. Contract SPDX and existing notices remain intact; a skills LICENSE is not a license grant for the whole product. Private local research copy is not a claim of redistribution rights; publication requires rights review.

No original commercial integration, mobile, Sepolia, payment, provider server or full original test suite was executed for this task. The new isolated adapter is a research variant, not proof that the original provider handoff system has identical measured behavior. The source schema was inspected, not initialized or migrated in a source environment.
