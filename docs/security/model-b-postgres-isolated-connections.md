# 7.6D.1 — Isolated Model B PostgreSQL runtime connections (inactive)

## Purpose and status

This is an **inactive** connection/bootstrap module. It is not wired into
`execute-ai-workflow-model-b.ts`, any HTTP server, live Solana RPC, or a
payment-broadcast path. No mainnet or customer-fund readiness is implied.

`demo/model-b-postgres-runtime-databases.ts` defines three **separate**
factory entry points, each intended for its own isolated process/deployment:

| Factory | Accessible methods | PostgreSQL role |
| --- | --- | --- |
| `openModelBReaderDatabase` | `get`, `getForReconciliation` | `av_model_b_reader` |
| `openModelBCoordinatorDatabase` | Read + `claim`, `persistSignedPayment`, `reserveOneSubmission` | `av_model_b_coordinator` |
| `openModelBFinalizerDatabase` | Read + `applyInspectedStatus` | `av_model_b_finalizer` |

Only the corresponding role's database URL may be present in a service's
environment. The parser fails closed if **any other Model B role URL is set**.
No service ever opens the coordinator and finalizer credentials together.
Each opt-in factory waits for a successful role privilege check before exposing
its limited operations. It holds one checked `PoolClient` for its lifetime, so
`Pool.query()` cannot silently open new unverified connections after startup.
If a pinned session dies, operations fail closed; reopen the factory and
re-check the new session. On failure, it closes the client and pool. `close()`
releases both. Neither service facade exposes raw SQL, a pool, or `SET ROLE`.

## Required configuration (only set the matching URL in each process)

* `AGENTVAULT_MODEL_B_PRIVATE_SCHEMA` — private, lowercase payment schema,
  not `public`, `pg_catalog`, or temporary schemas
* Reader process: `AGENTVAULT_MODEL_B_READER_DATABASE_URL`
* Coordinator process: `AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL`
* Finalizer process: `AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL`

Provision distinct real LOGIN accounts with independently managed secrets.
Never reuse `AGENTVAULT_DATABASE_URL` (API authentication) or
`AGENTVAULT_TEST_DATABASE_URL` (all-roles test owner). Do not share credentials
between processes. Never log URLs. URL session override options, `SET ROLE`
sessions, and inherited membership in another Model B runtime role are rejected.

## Startup checks (fail closed)

Every login must match both `session_user` and `current_user`, be a
non-superuser/non-owner, and effectively inherit **only** its assigned
NOLOGIN role (`pg_has_role(..., 'USAGE')`). The private schema and payment table
must belong to a separate migration owner. Require no object-creation
privileges in schema or database, including `TEMP`; table `SELECT` only (no
table/column DML); and precisely matched `EXECUTE` rights on all four guarded
functions. Only effective role grants are accepted: a membership declared
`WITH INHERIT FALSE` cannot serve runtime reads without an unsafe role switch.

**Database preparation requirement:** PostgreSQL databases often grant `TEMP`
to `PUBLIC` by default. Provision a *dedicated payment database* and review
its grants (including `PUBLIC` and role inheritance) so runtime logins do not
have `TEMP` before attempting startup. The 7.6C.10 SQL privilege audit must
also pass as the trusted migration owner; this runtime preflight is additive,
not a replacement.

## Testing and remaining release blockers

`demo/model-b-postgres-runtime-databases.test.ts` checks single-role
environments, SQL privilege assertions, failure cases, and rejection of the
local test-owner identity on a disposable real payment schema. This **does not**
prove distinct real LOGIN accounts are correctly provisioned in production:
tests using those genuine separate credentials, security monitoring, and
hostile-network testing remain required before controlled Devnet runtime use.

Neither database roles nor SQL functions validate Model B Ed25519 approvals or
independently attest Solana finality. A compromised coordinator can still
manufacture bogus SQL parameters and lock requests; a compromised finalizer
can still claim false finality. These are explicit release blockers until
isolated service verification, attestation or monitoring, and independent
security review establish suitable protection.

No automatic resubmission after an ambiguous RPC outcome. Preserve
`demo/fall-school-stable` and the current live executor unchanged.
