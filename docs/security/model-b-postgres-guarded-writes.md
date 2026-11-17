# 7.6C.8 — Model B PostgreSQL guarded writes

This **inactive** milestone removes the unrestricted direct table mutation grants
of 7.6C.7 and provides four controlled `SECURITY DEFINER` SQL functions for
the payment lifecycle. No live Model B executor integration is enabled.

## Database roles and SQL interface

| Role | Access | Explicitly denied |
| --- | --- | --- |
| Migration/table owner | Migrations, function ownership | Must never be a payment-facing service identity |
| `av_model_b_reader` | Table SELECT only | Direct writes and all guarded write functions |
| `av_model_b_coordinator` | Table SELECT, EXECUTE guarded claim/prepare/reserve | Direct writes and guarded finality |
| `av_model_b_finalizer` | Table SELECT, EXECUTE guarded finality reconciliation | Direct writes and guarded claim/prepare/reserve |

The finalizer **must** be a separately deployed trusted process with its own
login, network permissions, and secrets. It must run the read-only Solana
finality inspector before calling the database. All runtime identities must be
non-owner logins with just one of the corresponding NOLOGIN role memberships;
never share a login between coordinator and finalizer. Never give runtime
processes membership in the table owner role.

Apply the SQL migrations inside a private dedicated schema in this order:

1. `20261110_model_b_payment_requests.sql`
2. `20261110_model_b_payment_finality.sql`
3. `20261111_model_b_runtime_roles.sql`
4. `20261111_model_b_guarded_writes.sql`

The fourth migration is deliberately **one-time**. Run it as the table owner
after creating `av_model_b_finalizer` as an unprivileged `NOLOGIN` role.
It revokes both table-level and column-level DML grants and fails closed
if a runtime role retains any effective direct table or column write access.
It grants EXECUTE on each function individually and revokes PUBLIC execution.
Functions are schema-qualified and lock their `search_path` to `pg_catalog`.
The existing database trigger enforces monotonic transition order and immutable
identity/transaction columns, with `finalized_slot` and DB-recorded observation
time for terminal states.

Use `GuardedPostgresModelBPaymentStore(db, privateSchema)` when connecting separately
privileged coordinator/finalizer clients. The private schema argument is **required**,
validated at construction, and quoted into all guarded SQL including reads.
Never rely on the caller's PostgreSQL `search_path`: otherwise a session-local
`pg_temp` table could shadow unqualified table reads even when the role cannot
write to the real payment table. The integration test demonstrates this shadowing
against the unqualified name and verifies guarded reads return real data. `PostgresModelBPaymentStore` remains a legacy
**inactive test-only** adapter using direct table DML; do not deploy its writer
with table-owner credentials or bypass guarded database functions.
The deprecated `recordChainStatus()` is disabled in the guarded adapter.

## Limits and release gates

These functions **do not verify Solana Ed25519 signatures, the Model B
transaction structure, or RPC finality**. A compromised coordinator may still
submit dishonest parameters to its claim/prepare/reserve functions; a compromised
finalizer may still falsely declare a valid-looking finalized slot. The trusted
7.6C.6 TypeScript owner-approval verifier and 7.6C.5 read-only finality
inspection remain mandatory, and must be isolated in their respective services.
The SQL procedures eliminate *direct table DML* as an extra bypass path, but do
not make the database an independent cryptographic authorization engine.

No automatic resubmission on ambiguous RPC outcomes; the one-shot reservation
rule and exact saved bytes remain unchanged. Before production activation,
review the role membership graph, function owners, GRANTs/ALTER DEFAULT
PRIVILEGES, SQL procedures, service credentials, network access, trusted
execution paths, crash recovery, and threat model with an independent reviewer.

## Local test-only role provisioning

For the existing localhost `agentvault_test*` database, after the 7.6C.7
roles are provisioned, add the new NOLOGIN role and give the dedicated test
owner **SET ROLE** membership solely for integration testing:

```sql
CREATE ROLE av_model_b_finalizer NOLOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION;
GRANT av_model_b_finalizer TO av_test_76c3_runner WITH INHERIT FALSE;
```

The real PostgreSQL test creates and removes its own random private schema,
checks effective privileges, demonstrates direct SQL and wrong-function calls
are denied, and verifies that the guarded coordinator and finalizer interfaces
can complete a simulated payment lifecycle. It never broadcasts to Solana.
Do not treat a skipped integration test as proof of database isolation.
