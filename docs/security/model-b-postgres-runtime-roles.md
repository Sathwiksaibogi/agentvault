# 7.6C.7 — Model B PostgreSQL runtime privilege isolation

This **inactive** milestone separates database roles for read-only API activity
and the privileged payment coordinator. It does **not** enable the live
Model B executor and does not alter existing Solana payment instructions.

## Privilege model

Apply `20261110_model_b_payment_requests.sql`, then
`20261110_model_b_payment_finality.sql`, then
`20261111_model_b_runtime_roles.sql` **in that order**, inside a dedicated
private schema. The privilege migration refuses the public schema and
preexisting privileged/login roles. It expects DBA-provisioned `NOLOGIN`
roles `av_model_b_reader` and `av_model_b_coordinator`.

| Role | Effective intended access | Not permitted |
| --- | --- | --- |
| Migration/table owner | Schema maintenance and migrations only | Never run in a payment-facing service |
| `av_model_b_reader` | `USAGE` on private schema; `SELECT` on payment table | `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `TRIGGER`, schema `CREATE` |
| `av_model_b_coordinator` | Table `SELECT`; claim-only `INSERT` columns; scoped lifecycle `UPDATE` columns | `DELETE`, `TRUNCATE`, `TRIGGER`, modifications to identity/timestamps, schema `CREATE` |

Assign each **distinct, low-privilege service login** membership in only the
appropriate NOLOGIN role. Never give the read-only API process the coordinator
credential or the migration/table-owner credential. Do not grant privileged
roles to `PUBLIC`. Maintain separate secrets and connection pools, with
restricted network reachability and rotation controls. Runtime readiness
must audit permissions before the service is enabled.

This migration is additive and idempotent in the intended private schema.
It revokes table privileges from `PUBLIC` and both runtime roles before
applying the narrow grants. It refuses to finish if the roles have inherited
unauthorized effective privileges, own the payment table, or have elevated
cluster permissions. It does not alter database-wide role/password state.

## Security limits

The coordinator role can **still** call permitted `INSERT` and `UPDATE`
statements directly; PostgreSQL cannot independently verify a signed Solana
Model B approval from these grants. The 7.6C.6
`validateAuthorizedModelBPayment()` guard is mandatory before every
preparation and the 7.6C.5 finality inspector is mandatory before recording
terminal status. The existing PostgreSQL guard trigger and finality constraints
limit transitions, but they do **not** prove an RPC observation is authentic.

This is role separation and blast-radius reduction, **not** protection
against a fully compromised coordinator credential. A later trusted SQL
procedure/service boundary must eliminate broad direct coordinator UPDATE
rights before making stronger claims about database-enforced authorization.

## Test setup — dedicated localhost database only

Precondition: `AGENTVAULT_TEST_DATABASE_URL` points to the already established
`agentvault_test_76c3` database and `av_test_76c3_runner` is its owner.
As PostgreSQL administrator, create two NOLOGIN roles and allow the test
owner to `SET ROLE` into them. These TEST-ONLY memberships must never be
copied into production:

```sql
CREATE ROLE av_model_b_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE av_model_b_coordinator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT av_model_b_reader, av_model_b_coordinator
  TO av_test_76c3_runner WITH INHERIT FALSE;
```

Run the integration tests using the dedicated local database URL. The test
creates a random private schema, applies all three migrations, uses `SET LOCAL
ROLE` inside rollback-only transactions, verifies forbidden SQL is denied,
validates that the existing store still functions under the restricted
coordinator role, then drops the temporary schema. No real Solana transactions
are sent and no existing request is mutated.

The new test is skipped when the test URL is missing, and fails explicitly if
the roles/test membership are not provisioned. Do not treat a skipped test
as proof of PostgreSQL isolation.
