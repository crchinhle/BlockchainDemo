# Research variant decisions

## Model v2 superseding decisions — 2026-11-10

The live NCKH Google Doc was accessible and read; it remains unchanged. New `ResearchLicenseRegistryV2` implements direct issuer/owner authorization, device membership, v/g and terminal revocation. It coexists with the original registry. The active entrypoint selects `runner-v2`; the old runner remains a historical implementation and export utility. Versioned tables preserve prior results. Centralized now commits independently of Blockchain; its reference is commit acknowledgement. Tokens use ES256. Complete rationale, requirement matrix and measured limits are in [model-v2.md](model-v2.md). Earlier numbered decisions below describe historical choices unless explicitly still applicable.

1. User explicitly requests an independent variant. New runtime remains under EmuKey, using existing packages, original contract and platform crypto/connection providers. No ORM/framework replacement. Original commerce/provider guards untouched.
2. A separate `research` module/schema and entrypoint avoid loading credential-heavy commercial integrations. The original schema and application remain reference source. NODE_ENV=test is never used to claim real integration.
3. Local host processes for Hardhat/API/worker/Vite, Docker Compose for dedicated PostgreSQL/Redis. Only loopback exposed. Same Node/pnpm versions and frozen lockfiles; no paid service or mainnet path.
4. Local generated researcher credential is stored in ignored `.research-local/login.json`, never exported. HttpOnly/SameSite cookie, role and ownership checks, login throttling. Original account/auth is preserved, not weakened.
5. On restart abandon the continuous measurement with INTERRUPTED; reconcile known hashes/processedCommands without broadcasting again. This avoids fake timer resume but does not claim complete original outbox guarantees.
6. Canonical JSON hashing is necessary because PostgreSQL jsonb changes property order. Early pre-canonical test artifacts remain historical and are not acceptance evidence; new acceptance artifacts use sorted-key canonical serialization.
7. PDF and PNG are generated deterministically from the frozen JSON dataset with ReportLab/Pillow. Python dependencies are local venv tools, pinned separately. No LLM-generated findings.
8. UI uses Ant Design/IBM Plex Sans, separate operational and report views, real data only. Selected dashboard guidance retained; generic marketing layout suggestions from design search rejected as irrelevant.
9. Official references inspected: https://docs.bullmq.io/guide/workers/stalled-jobs and https://docs.nestjs.com/openapi/introduction . viem documentation retrieval through web tool failed on text/markdown; signatures verified against installed viem types and real EVM execution. Hardhat existing config/compiler reused.

Implementation sequence: source audit → isolated infrastructure and domain tests → actual EVM/PoP/worker slice → API/UI/export → integration, failure tests, browser validation. No source reset, shared migration, commit, publish or push.

10. At the user's request, remove the unused commercial applications/schema, mobile/demo apps, old tests/tooling, CI and agent/editor scaffolding after establishing the lab import graph. This supersedes the earlier decision to preserve them as local reference source. Retain their source commit/audit, reusable providers/registry, research data and unchanged dependency locks; all package scripts now target the research runtime.
