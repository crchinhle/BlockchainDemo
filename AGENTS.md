# EmuKey Research Lab instructions

This is an independent research variant of crchinhle/MCP_API. Source provenance and the original audit are recorded in source-manifest.json and docs/research/source-audit.md. Commercial apps and unused source modules were removed at the user's request; the audit describes the original snapshot, not the current directory inventory.

- Keep runtime code in EmuKey/, research tests in tests/emukey/research/, and independent analysis in tooling/emukey/research/.
- Use the existing NestJS/TypeScript, pg, Redis/BullMQ, viem/jose and React/Vite/Ant Design stack. Keep explicit SQL, no ORM.
- The only lab schema authority is EmuKey/backend/database/research.sql. Run initialization through compose.research.yml's database-initialize container; never reset volumes or run commercial migrations.
- The runtime entrypoint is backend/src/entrypoints/research/main.ts. Three original providers remain in platform/{crypto,database,redis}; retain provenance and contract SPDX notices.
- Preserve .research-local, Docker data, credentials, historical evidence and all user changes. Never print tokens, private keys or passwords.
- Search existing code and inspect git status before edits. Do not introduce duplicate utilities, unrelated dependencies, or repository-wide formatting.
- Pin decisions to the actual chain snapshot. Retain errors, partial runs and censoring; never generate data for scientific reports.
- Use only local chain 31337 unless a future task explicitly authorizes another network. No source repo changes, publication, push, paid services or mainnet.
- Verify scoped changes with backend/frontend build, typecheck, lint and relevant research tests. The UI E2E requires the running local services.
- Report measured boundaries and remaining limitations accurately; see docs/research/model-alignment.md.
