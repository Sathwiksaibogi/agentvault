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

## 7.6C.10 — SECURITY DEFINER and effective-privilege audit

Run the **read-only** `sql/20261111_model_b_privilege_audit.sql` under the
trusted migration/table-owner identity after applying all four payment schema
migrations, with `current_schema()` resolving to the intended private payment
schema. It raises `REFUSE` on a missing/disabled mutation trigger, changed
trigger owner, non-owner or non-`SECURITY DEFINER` guarded function, non-SQL
language, altered `search_path`, unexpected privileged routine, `PUBLIC` or
third-party function execution, effective DML grants, cross-role membership,
or the ability of a runtime role to create payment-schema/database objects.
This file performs no migrations and changes no role permissions.

The regression test `demo/model-b-postgres-privilege-audit.test.ts` deliberately
introduces each unsafe condition in a disposable, localhost-only PostgreSQL
schema inside savepoints and verifies the audit rejects it, then rolls back.
It also demonstrates **a known, intentionally unresolved vulnerability**:
under the coordinator role, direct invocation of the SQL claim/prepare/reserve
functions can create an apparently prepared transaction from invalid signed
bytes; with a *separately compromised finalizer role*, the SQL reconciliation
function can write an invented `CONFIRMED` slot. Those test rows are rolled
back and are never broadcast to Solana. A passing test means the threat was
reproduced and documented, **not** that the database independently prevents it.

### Release blockers not solved by this audit

- Provision and audit **distinct real LOGIN** accounts: API reader, payment
  coordinator, finality inspector; no owner membership, shared credentials,
  transitive `SET ROLE` privileges or cross-service credential access. The
  local test login intentionally has `SET ROLE` membership in all three roles;
  that test arrangement cannot prove deployed process isolation.
- Require validated owner signatures, on-chain policy, and canonical signed
  transaction checks at the trusted coordinator boundary. Treat coordinator
  credential compromise as a forged-claim and request-locking incident.
- Require verified on-chain RPC finality from an independently protected
  inspector, with separately controlled credentials. A slot number written by
  SQL is evidence of a **claimed observation**, not independently verified
  Solana finality. Treat finalizer compromise as a forged-status incident.
- Consider independent verifiable attestations or evidence storage before
  production if the threat model must remain safe when an entire coordinator
  or finalizer process is compromised. Review SQL function bodies, migration
  supply chain, active roles and real database audit logs externally.

The audit is a prerequisite for controlled integration, not production approval.
The PostgreSQL path remains inactive; no customer funds or live executor are
involved in this milestone.
