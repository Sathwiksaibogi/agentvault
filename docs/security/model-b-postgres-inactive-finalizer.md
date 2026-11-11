# 7.6D.5 — Inactive Model B finality recovery

**Status: inactive, not authorized for customer funds or a production deployment.**

`demo/model-b-postgres-inactive-finalizer.ts` exposes a read-only `inspect` method and a `reconcile` method, but **no transaction-signing, transaction-building, claim, preparation, submission reservation, or RPC-send capability**. It is not imported by the executable Model B CLI or API server.

The deployment must pin the expected Devnet genesis hash, the compiled AgentVault program ID, and the vault. These values must come from trusted configuration, not from the saved record or client request. A stored payment outside those values is rejected, including on the re-read after a lost PostgreSQL compare-and-set race.

A separate process opens **only** its `AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL` via `openModelBFinalizerDatabase()`. The D.1 preflight checks the active PostgreSQL login and grants. This factory cannot obtain a coordinator submission permit. Dedicated LOGIN accounts with the appropriate limited memberships are required for any future deployment; the local all-roles test runner is not an acceptable runtime identity.

For `SUBMISSION_RESERVED` and `UNRESOLVED` records, `reconcileModelBPayment()` uses `inspectModelBFinality()`, which checks the original signed transaction and its digest, RPC ledger identity, finalized signature status, finalized transaction receipt, slot and error consistency. Its resulting SQL write uses the existing guarded `applyInspectedStatus()` compare-and-set. A CAS miss is re-read, and conflicting terminal evidence fails closed. `CLAIMED` and `PREPARED` are not eligible. Terminal states do not trigger RPC reads or a second write. Results expose only payment metadata, never the saved signed bytes.

**Trust limitation / release blocker:** PostgreSQL's `SECURITY DEFINER` finality function does **not** cryptographically authenticate Solana RPC evidence. A compromised process with finalizer SQL `EXECUTE` permission can still invoke the guarded function with dishonest slot/status arguments. Therefore isolated credentials and application checks are defense-in-depth, **not** a proof of finality against a compromised finalizer. Treat RPC-provider compromise, finalizer compromise, and forged terminal records as unresolved risks. Require independent threat modeling, credential isolation, operational monitoring, and external security review before activating a Devnet service or mainnet release.

The adapter never retries, rebuilds, re-signs, reserves, or rebroadcasts any original or replacement transaction. PostgreSQL finalization does not settle the cross-system atomicity problem between PostgreSQL and Solana RPC.
