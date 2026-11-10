# 7.6C.4 — Model B chain-finality inspection (read-only)

**Status:** Prototype helper and offline adversarial tests. Not wired into payment execution, PostgreSQL status writes, or Devnet. No new transaction is signed, sent, or retried.

## Review boundary

- Input must be an existing `SUBMISSION_RESERVED` or `UNRESOLVED` record returned by the PostgreSQL coordinator. Claims without signed payment bytes are rejected before RPC.
- Reverify saved transaction signature and SHA-256 before looking at the chain.
- Verify the RPC genesis hash before and after requesting evidence. The RPC provider remains a trusted operational dependency; two genesis checks are not independent consensus verification.
- Request full signature history and a **finalized** transaction receipt, require exact signature and slot matching, and compare the transaction error with the signature status.
- Return a terminal observation only for matching finalized evidence. Missing, processed-only, confirmed-only, inconsistent, and pruned records remain `UNRESOLVED` or error. Never infer failure from blockhash expiry or an RPC timeout.
- This helper never calls the store's `recordChainStatus` method; the separately added 7.6C.5 inactive reconciliation adapter re-checks claim identity, signature, and state transition before persisting an observation. It is not approved for live use.
- This is a **read-only observation tool**, not a relayer or retry mechanism. Even a failed original signature does not by itself authorize a replacement payment or a reused request ID.

## Next integration gates

1. Add database-backed recovery tests spanning crash at claim, preparation, reserved submission, RPC error, and restart.
2. Require a release-reviewed reconciliation adapter with one-way terminal transitions only; no admission of arbitrary caller-provided status labels.
3. Verify transaction shape against the original Model B workflow/approval and stored digests at the boundary where the signed bytes enter the database. The current generic payment store checks signature integrity, but does **not** yet independently verify the Model B instruction accounts and approval binding.
4. Test dedicated DB roles, read/write permission separation, database failover, backup restoration, and operator handling for `UNRESOLVED` items.
5. Preserve all existing file-journal requests and Devnet evidence; never import unresolved claims as new requests.

## Offline checks

```bash
pnpm exec tsc --noEmit
pnpm exec tsx --test demo/model-b-postgres-chain-inspection.test.ts
pnpm exec tsx --test demo/*.test.ts
```

No SQL migration, Devnet transaction, RPC access, or validator is required for these mocked-RPC tests.
