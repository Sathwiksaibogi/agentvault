# AgentVault 7.6C.5 — Durable Model B chain reconciliation (INACTIVE)

**Status:** Code and offline adversarial tests included; PostgreSQL integration test is opt-in. **Not activated in the payment executor, API, Model A journal, or Devnet. No broadcast, re-signing, or retry logic.**

## Design

1. Read an existing request using `getForReconciliation(requestId)` after applying the **additive finality migration** to a dedicated test schema.
2. Return without RPC or SQL mutation if already terminal. Reject missing, `CLAIMED`, and `PREPARED` requests.
3. Inspect the original serialized transaction via `inspectModelBFinality`: verify SHA-256, full signature, claimed genesis hash before and after the read, finalized signature status and matching finalized transaction receipt, slot, transaction signature, and on-chain error result.
4. If finality is absent/contradictory, at most set `SUBMISSION_RESERVED -> UNRESOLVED` once. Do **not** infer a terminal failure from a timeout or blockhash expiration. `UNRESOLVED` never grants another submission permit.
5. For verified terminal observations, use a single SQL compare-and-swap to record `CONFIRMED` or `FAILED`, with `finalized_slot` and database-generated `finality_observed_at`. Match the original request ID, genesis, program, vault, workflow/payment digests, exact serialized bytes, SHA, signature, and last valid block height. Only `SUBMISSION_RESERVED` or `UNRESOLVED` can become terminal.
6. If CAS loses a race, re-read. An identical terminal result+slot is idempotent. A contradictory finalized result, changed immutable identity, or unexpected phase is a hard conflict; never overwrite or retry broadcasting.
7. The SQL trigger protects identity, signed bytes, allowed phases and terminal evidence against mutation. The finality CHECK constraint rejects terminal status without slot and timestamp. Existing row IDs and signed bytes are preserved.

**Observation trust:** RPC access is an operational trust boundary, not independent chain consensus verification. A trusted internal store method still takes status values; it is not itself proof of finality. Call `reconcileModelBPayment()` only from trusted server-side code with a vetted RPC connection, and never expose low-level store mutations to untrusted endpoints. Do not interpret this milestone as exactly-once on-chain execution. The old `recordChainStatus()` method remains for existing isolated test compatibility, is deprecated, and cannot write terminal outcomes on schemas with the new finality constraint unless required evidence is present (which it never sets).

## Migration gating

- Apply `sql/20261110_model_b_payment_requests.sql` first, then `sql/20261110_model_b_payment_finality.sql`, **only inside the integration test's disposable local schema**.
- The additive migration explicitly refuses existing `CONFIRMED`/`FAILED` rows rather than inventing historical finalized slots. Review and manually design preservation for existing terminal rows before any production migration.
- A production rollout needs audited role separation, schema/migration ownership rules, least-privilege grants, race/fault-injection across independent processes, real RPC finality behavior, failover/backup restoration, and a plan for legacy Model A/B claims.
- A service with unrestricted table UPDATE access can fabricate database fields; the trigger enforces structural consistency, not cryptographic finality. Operational trust, least privilege, logging and independent review are mandatory.
- The generic payment store validates legacy Solana signature integrity but does not yet independently verify the Model B instruction/account layout and owner approval binding when bytes are inserted. This is a **release blocker**.

## Commands to run on WSL

```bash
pnpm exec prettier --write \
  demo/model-b-postgres-payment-store.ts \
  demo/model-b-postgres-reconciliation.ts \
  demo/model-b-postgres-reconciliation.test.ts
pnpm exec tsc --noEmit
pnpm exec tsx --test \
  demo/model-b-postgres-payment-store.test.ts \
  demo/model-b-postgres-chain-inspection.test.ts \
  demo/model-b-postgres-reconciliation.test.ts
pnpm exec tsx --test demo/*.test.ts
```

The offline suite will skip one real PostgreSQL test per integration file if `AGENTVAULT_TEST_DATABASE_URL` is not set. To run it, reuse the already provisioned **dedicated local disposable** `agentvault_test*` connection URL in a temporary environment, then rerun the focused test files. The tests create and drop their own random isolated schemas and refuse non-local/non-test database URLs. Never paste database passwords into a chat or Git commit.

**Do not apply the migration to the main AgentVault database. Do not connect this adapter to the live Model B executor for this milestone.**
