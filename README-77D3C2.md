# AgentVault 77D3C2 — Restricted PostgreSQL inbox roles (inactive)

**Status:** add-on to the committed 77D3C1 foundation. Not connected to any
HTTP route, API runtime, payment execution, or live Devnet DB.

## Boundary

`av_model_a_intake` (NOLOGIN) can **only** call guarded
`model_a_inbox_submit(jsonb)` and principal-scoped `model_a_inbox_get(...)`.
`av_model_a_reader` (NOLOGIN) can **only** call bounded
`model_a_inbox_discover(...)`. Neither role has direct table privileges,
CREATE rights on the inbox schema, or the other role's functions. Functions
run as the schema/table migration owner and use fixed schema-qualified table
names and a pinned `pg_catalog, pg_temp` search path.

The inactive TS adapters use these SQL functions, not direct table access:
`RestrictedModelAInboxIntake` has `receive`/`read`, while
`RestrictedModelAInboxReader` has `discover`. They preserve validation,
client-side row binding checks, duplicate idempotence across timestamps,
and fail-closed discovery page limits.

**Important security boundary:** database roles reduce the blast radius of
compromised service credentials; SQL function arguments are **not** proofs of
agent identity. The reader can request a different vault/agent scope if a
privileged backend supplies it. Before live use, the actual API must continue
to authenticate the signed agent, verify the authority against active on-chain
vault/agent accounts, use a trusted server clock and keep separate restricted
LOGIN credentials/processes. There is no durable acknowledgment or dispatch.
No runtime service may use the migration owner's credentials.

## Prerequisites (dedicated localhost test DB only)

1. Commit `693bf50` (77D3C1) must be present.
2. `AGENTVAULT_TEST_DATABASE_URL` must point to the local
   `agentvault_test_76c3` database under the existing test owner. Never echo
   the URL, store it in a script, or run this against a production database.
3. Provision the following two NOLOGIN test-only roles **once**, as DBA.
   These cluster roles have no passwords. This setup is limited to the local
   test cluster, **not** a pattern for production role provisioning.

```bash
sudo -u postgres psql -d agentvault_test_76c3 -v ON_ERROR_STOP=1 <<'SQL'
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='av_model_a_intake') THEN
    CREATE ROLE av_model_a_intake NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='av_model_a_reader') THEN
    CREATE ROLE av_model_a_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;
GRANT av_model_a_intake, av_model_a_reader TO av_test_76c3_runner
  WITH INHERIT FALSE;
SQL
```

The test owner can temporarily `SET LOCAL ROLE` for testing only. A production
process must use its own dedicated LOGIN role with no cross-role membership.

## Install / test

From `~/projects/agentvault`, unzip the package with `unzip -n` (additive files
only), then run:

```bash
pnpm exec prettier --write \
  demo/model-a-postgres-agent-inbox-roles.ts \
  demo/model-a-postgres-agent-inbox-roles.test.ts
pnpm exec tsc --noEmit
pnpm exec tsx --test \
  demo/model-a-agent-inbox.test.ts \
  demo/model-a-postgres-agent-inbox.test.ts \
  demo/model-a-postgres-agent-inbox-roles.test.ts
```

The new integration test creates and removes its **own disposable private
schema**. It applies both migrations in order, verifies intake/reader isolation,
reads scoped data, rejects direct table access and cross-role function calls,
tests duplicate/conflict behavior (including later-time retries), concurrent
inserts, expiration filtering and reconnect persistence. The test must run
with **zero skipped** tests.

On failure, do not commit. Do **not** run the migration manually against the
live API or a customer database; the test itself applies it to an isolated
private schema and rolls back/removes only its test objects.

## Commit only after successful local tests

```bash
git add \
  sql/20261113_model_a_agent_inbox_roles.sql \
  demo/model-a-postgres-agent-inbox-roles.ts \
  demo/model-a-postgres-agent-inbox-roles.test.ts \
  README-77D3C2.md
git diff --cached --check
git diff --cached --stat
git diff --cached --name-only
git commit -m "feat(inbox): isolate PostgreSQL Model A runtime roles"
```

Do not stage old ZIPs, patches or unrelated files. Preserve
`demo/fall-school-stable`. Next: real separately provisioned LOGIN credentials,
startup privilege audit and integration under a **devnet-only opt-in flag**, then
explicit delivery lifecycle and failure tests. This milestone itself never
approves, claims, broadcasts or pays anything.
