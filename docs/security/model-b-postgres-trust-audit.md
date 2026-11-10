# 7.6C.9 — Model B PostgreSQL trust-boundary audit (inactive)

## Confirmed hardening: schema-qualified store calls

The 7.6C.8 SQL functions already use schema-qualified table names with a fixed
`pg_catalog` function search path. The guarded TypeScript store did not: its
queries resolved table and function names using the caller's search path.
PostgreSQL can resolve **unqualified relation names to session-local temporary
tables** ahead of the intended private schema. A runtime login may have `TEMP`
rights even when denied `INSERT`/`UPDATE` on the real payment table.

7.6C.9 requires an explicit, validated private schema for the guarded store and
schema-qualifies every guarded function call and payment table read. It adds
mock-query and real-PostgreSQL temporary-table-shadowing regression tests.
Legacy inactive direct-DML tests remain unchanged.

## Residual trust boundary — NOT independently attested by SQL

A caller possessing the coordinator's `EXECUTE` grants can invoke
`agentvault_model_b_claim_guarded`, `...prepare_guarded` and
`...reserve_guarded` with unverified inputs directly. SQL state constraints
cannot authenticate Solana owner signatures, on-chain policy or the transaction
message. Likewise, a caller with finalizer `EXECUTE` access can supply a
plausible `finalized_slot`, `CONFIRMED` or `FAILED` to
`agentvault_model_b_reconcile_guarded` without the database independently
checking Solana RPC evidence. SQL `finality_observed_at` is the *database time*
of the write, **not a proof of Solana finality**.

Consequently, compromise of either write identity remains a material threat.
The guarded SQL functions are permission boundaries, **not a secure substitute
for separately trusted verification services**. Do not claim complete resistance
to privilege abuse or cryptographic authorization bypass based on DB tests.

## Production prerequisites / independent review

- Provision separate non-owner login credentials for API reader, payment
  coordinator, and finality inspector; never combine roles in a runtime login
  (the local integration-test login is intentionally an exception).
- Audit the complete role membership graph, inherited privileges, database
  `TEMP`/`CREATE`, schema ownership, default grants, other executable
  `SECURITY DEFINER` functions, triggers, and extension availability.
- Restrict SQL function `EXECUTE` to the single intended service role and use
  a fixed private schema in application configuration and connection strings.
- Isolate the finalizer's process, RPC access, credentials and deployment so
  the coordinator cannot impersonate it. Verify signer authorization and
  finality evidence upstream; design independent attestation/monitoring if
  the threat model requires DB-level protection against a compromised service.
- Run tests with real distinct database logins and a hostile session
  `search_path` before enabling the inactive PostgreSQL coordinator.
- The live Model B executor, Model A flows and `demo/fall-school-stable`
  branch are not modified by this audit milestone.
