# 7.6D.6 — Independent PostgreSQL LOGIN roles (local test only)

## Goal and status

The existing 7.6D.1 factories check effective PostgreSQL privileges on
startup. This milestone tests **real, distinct authenticated LOGIN accounts**,
not merely `SET ROLE` from the privileged `AGENTVAULT_TEST_DATABASE_URL` runner.
The login-provisioning script is **explicitly restricted to a dedicated local
`agentvault_test*` database**, not production or Devnet deployment. Roles are
PostgreSQL-cluster-global; review their names before running the script.

Nothing in this milestone enables the Model B live executor, an RPC send, or a
production database. `demo/fall-school-stable` remains untouched. Existing
`av_model_b_reader`, `av_model_b_coordinator`, and `av_model_b_finalizer`
NOLOGIN roles must already exist with guarded SQL functions/grants.

## One-time DBA provisioning (ONLY the dedicated local test DB)

1. Ensure that `agentvault_test_76c3` is a dedicated/disposable local test
   database. Run **once**, as a local PostgreSQL DBA:

   ```bash
   cd ~/projects/agentvault
   pg_isready -h 127.0.0.1 -p 5432
   sudo -u postgres psql -d agentvault_test_76c3 -v ON_ERROR_STOP=1 \
     < sql/20261111_model_b_test_login_provisioning.sql
   ```

   The SQL fails closed unless the session is a superuser on an
   `agentvault_test*` database. It creates distinct no-password test logins
   `av76d6_reader_test`, `av76d6_coordinator_test`, and
   `av76d6_finalizer_test`, each inheriting **only its matching capability**.
   A role-name collision aborts the transaction; **do not rerun blindly**.
   It also revokes database `TEMPORARY` from `PUBLIC` in this test database,
   because the existing runtime preflight explicitly denies `TEMP` access.
   This changes privileges on the *entire test database*, so never run against
   any shared application database.

2. Assign **three independently generated strong passwords**, interactively
   through `psql`, never into the shell history, repository, or chat:

   ```bash
   sudo -u postgres psql -d agentvault_test_76c3
   ```

   Within `psql`, enter the following lines one at a time (each `\password`
   securely prompts twice and does not echo the password):

   ```text
   SET password_encryption = 'scram-sha-256';
   \password av76d6_reader_test
   \password av76d6_coordinator_test
   \password av76d6_finalizer_test
   \q
   ```

   Do not reuse the privileged `av_test_76c3_runner` password. Do not put
   credentials into command-line arguments or SQL source files.

3. In the **same WSL shell** as the existing
   `AGENTVAULT_TEST_DATABASE_URL`, enter these three *test-only* connection
   URLs. `read -s` hides terminal input. Percent-encode URL-reserved password
   characters as required. Do not print the values.

   ```bash
   read -r -s -p 'Reader URL: ' AGENTVAULT_MODEL_B_TEST_READER_URL; echo
   read -r -s -p 'Coordinator URL: ' AGENTVAULT_MODEL_B_TEST_COORDINATOR_URL; echo
   read -r -s -p 'Finalizer URL: ' AGENTVAULT_MODEL_B_TEST_FINALIZER_URL; echo
   export AGENTVAULT_MODEL_B_TEST_READER_URL \
     AGENTVAULT_MODEL_B_TEST_COORDINATOR_URL \
     AGENTVAULT_MODEL_B_TEST_FINALIZER_URL
   ```

   Use these connection URL shapes, substituting **only your real passwords**:

   ```text
   postgresql://av76d6_reader_test:<secret>@127.0.0.1:5432/agentvault_test_76c3
   postgresql://av76d6_coordinator_test:<secret>@127.0.0.1:5432/agentvault_test_76c3
   postgresql://av76d6_finalizer_test:<secret>@127.0.0.1:5432/agentvault_test_76c3
   ```

## Verify

```bash
pnpm exec tsc --noEmit
pnpm exec tsx --test demo/model-b-postgres-login-isolation.test.ts
pnpm exec tsx --test demo/*.test.ts
```

The real integration creates a disposable payment schema, applies the full
existing guarded migrations and SQL audit, then launches **three independent
`pnpm exec tsx` subprocesses**. Each receives exactly one service URL, no
sibling URL, and no all-roles test-owner URL. The child opens the existing
role-specific runtime factory and checks PostgreSQL's `session_user`,
`current_user`, actual direct-UPDATE denial and cross-service `SET ROLE`
denial. It never signs, prepares, reserves, broadcasts, or finalizes a
transaction. The disposable schema is dropped afterward; PostgreSQL test
logins are intentionally not automatically deleted.

If no isolated URLs are configured, the real integration test is **skipped**;
that is **not** evidence of successful login provisioning. Refuse to mark the
milestone complete unless all tests pass with **zero skipped**.

## Remaining security limits

* PostgreSQL role membership is cluster-global. A separate privileged
  migration owner or DBA could still change grants. Treat DBA access and
  password storage as part of the trust boundary.
* This **local test** demonstrates independently authenticated connections;
  it does not prove production host isolation, secrets management, TLS,
  network ACLs, rotation, or production-like deployments.
* SQL cannot independently authenticate Solana Ed25519 approvals or finalized
  RPC evidence. A compromised coordinator can submit forged claim/transaction
  parameters, and a compromised finalizer can assert false finality. Both
  remain **production release blockers** until adequate independent controls
  and a security review are in place.
* An ambiguous PostgreSQL reservation or RPC submission must not trigger a
  re-sign or a repeat broadcast. Only read-only chain inspection and guarded
  reconciliation are permitted after uncertainty.
