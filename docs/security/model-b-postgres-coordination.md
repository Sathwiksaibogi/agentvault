# Milestone 7.6C.2 — PostgreSQL request coordination (INACTIVE FOUNDATION)

**Scope:** Model B only, test-only until release and migration review. The current verified file journal and payment executor remain unchanged.

## Safety invariants

1. `request_id` is unique within this database. `INSERT .. ON CONFLICT DO NOTHING` grants one durable claimant across database clients/hosts.
2. Only one `CLAIMED -> PREPARED` transition stores the signed legacy transaction, its hash, immutable Solana signature, and last-valid block height.
3. Only one `PREPARED -> SUBMISSION_RESERVED` CAS succeeds. **Commit this transition before calling `sendRawTransaction` once.** A lost DB response, process crash, network timeout or unknown RPC status is **not** a reason to repeat the CAS or send.
4. An operator/worker may read the originally stored signature and exact transaction bytes for recovery inspection. That read does **not** grant another send permit.
5. `UNRESOLVED` cannot become `PREPARED` or `SUBMISSION_RESERVED`. It can be reconciled to `CONFIRMED`/`FAILED` only using authoritative, correctly scoped on-chain evidence.
6. The PostgreSQL trigger rejects updates to claim identity, signed bytes, digest and signature, skips and reversals, and deletion. Restrict app role permissions (no `DELETE`, `TRUNCATE`, schema DDL or `ALTER TABLE`).

## Remaining blockers before live activation

- PostgreSQL is now a *separate coordination foundation*; it is **not** integrated with Model A, the CLI journal, submission code, API, or the existing Devnet request IDs.
- Migration must preserve existing Model A and B claims including unresolved state; never import a legacy request as a fresh unclaimed row.
- Test real PostgreSQL under concurrent worker processes and independent database connections, process kill/fault injection, restart and backup/restore. The optional integration test only covers parallel connections, not independent machines.
- The inactive 7.6C.4 inspector and 7.6C.5 reconciliation adapter now check genesis, signature, transaction error, finalized status and recorded finalized slot before terminal status updates. They still require release review and live-path integration. A submitted-but-unobserved payment stays non-retryable without an explicit separately reviewed recovery protocol.
- Review statement timeouts, TLS, DB HA/failover semantics, privilege isolation, audit logging and backup encryption. Transaction signatures and bytes are sensitive operational artifacts even though they are not private keys.
- A DB-based state machine does **not** guarantee exactly-once chain execution without additional end-to-end proof. The strict policy here is at-most-one submission *permit* per request in a healthy, correctly configured database.

## Test safely

The standard offline test (`pnpm exec tsx --test demo/model-b-postgres-payment-store.test.ts`) validates argument/signature checks and CAS query contracts; it skips the actual PostgreSQL case unless `AGENTVAULT_TEST_DATABASE_URL` is set.

For the PostgreSQL integration case, provision a **disposable local** PostgreSQL database with a name beginning `agentvault_test`. Set `AGENTVAULT_TEST_DATABASE_URL` in your terminal environment only; do not commit it or put a credential in commands or logs. The test creates an isolated schema, applies the migration, verifies a concurrent-connection claim/submission race and trigger immutability, then drops its own schema.

Do **not** apply `sql/20261110_model_b_payment_requests.sql` to the production database until the migration and role plan are reviewed.
