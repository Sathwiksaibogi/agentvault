# 7.6D.10 — Independent Model B finality witness processes (inactive prototype)

**This is not production-ready and does not enable broadcasting.** Its aim is to move finality observation out of the finalizer process. Each proposed witness:

1. Receives only a request identifier; it loads the original immutable payment from PostgreSQL using **reader-only credentials**, not a finalizer/coordinator login. The witness should run under a separately administered service identity.
2. Uses its own deployment-pinned **genesis hash, program ID, vault**, HTTPS Solana RPC URL, and private witness key. These values must be configured by the witness operator, **not submitted by the finalizer**, and two witnesses need independently operated RPC paths and key custody.
3. Calls `inspectModelBFinality()` using its own RPC. It verifies the original signed payment digest/signature and requires matching finalized signature status and finalized transaction receipt, matching slot/error, and a matching genesis before and after inspection. A missing or contradictory observation returns **UNRESOLVED without a MAC**. An RPC error or deployment mismatch denies the request.
4. Only for a verified terminal observation, signs the **7.6D.9 length-prefixed identity/outcome/slot payload** with its own HMAC key. It never accepts a precomputed finality outcome or slot from a finalizer. The inactive worker sends only metadata and a one-time MAC over a **private IPC channel**. No raw transaction bytes, passwords, RPC credentials, or witness keys belong in stdout/stderr.

## Test-only integration and threat model

`demo/model-b-finality-independent-witness.test.ts` verifies success and failure, confirmed-only/unresolved outcomes, contradictions, substituted receipts and genesis, corrupt signed transaction bytes, mismatched deployment, missing RPC, invalid credentials, and two isolated Node.js subprocesses. The **synthetic RPC worker** `model-b-finality-witness-fixture-worker.ts` exists **only** for tests: it receives fabricated evidence and must never be imported or used by the real witness process. The real witness worker has no fabricated-RPC option and is not connected to the live payment CLI.

Even two witnesses agreeing on RPC responses is **not a Solana consensus proof**: correlated RPC infrastructure, equivocation, both compromised witnesses, or an unsafe common supervisor can still yield forged attestations. The current PostgreSQL HMAC test gate stores both symmetric keys under DBA control: the DBA/table owner could forge both witnesses. The finalizer must never receive the keys or control witness configuration. Environment-variable key custody is also not sufficient for production. Use independent operators/secret managers, separate operating-system users, asymmetric signing with public-key-only verification and rotation/revocation, strict workload identity, a reviewed database ACL audit, and an independent security assessment before any production release.

## Running

`pnpm exec tsc --noEmit`

`pnpm exec tsx --test demo/model-b-finality-independent-witness.test.ts`

`pnpm exec tsx --test demo/*.test.ts`

Do not use the worker against a real database until an independent operator has reviewed and provisioned its deployment environment and private IPC channel. The real worker requires `AGENTVAULT_MODEL_B_READER_DATABASE_URL`, `AGENTVAULT_MODEL_B_PRIVATE_SCHEMA`, `AGENTVAULT_MODEL_B_WITNESS_ID` (`observer_a` or `observer_b`), `AGENTVAULT_MODEL_B_WITNESS_KEY_HEX`, `AGENTVAULT_MODEL_B_WITNESS_RPC_URL`, and witness-pinned genesis, program, and vault. Each witness gets one key and only reader credentials. Do not send witness keys, database URLs, or MACs to chat, Git, or general logs. The old finality API remains quarantined in the test schema; **no live broadcast** is enabled.
