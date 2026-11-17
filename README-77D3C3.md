# AgentVault 77D3C3 — Durable acknowledgment foundation (inactive)

**Status:** Additive migration and restricted PostgreSQL adapter only. This is **not**
a new live route, agent dispatcher, payment authorization, execution claim,
reservation, or transfer. Current Devnet filesystem intake and signed polling
remain unchanged.

## Contract

- Existing `model_a_agent_inbox` rows and their original `status='received'`
  JSONB records remain unchanged. No `UPDATE` on original payment intents.
- New `model_a_inbox_acks` table stores a single, immutable acknowledgment
  receipt per `(devnet, vault, request_id)`; inserts are idempotent and
  transactionally durable.
- Only matching `(vault, agentAuthority, requestId)` and unexpired requests
  can acquire an acknowledgment, using a **trusted backend** `nowUnix`.
- An acknowledgment never consumes/removes the payment intent from discovery.
  It is proof only that the system recorded an agent delivery acknowledgment;
  it **cannot** authorize a payment.
- `av_model_a_ack` is a separately provisioned `NOLOGIN` role and receives only
  `EXECUTE` on `model_a_inbox_acknowledge(...)`. It cannot read/write either table,
  call submit or discovery, or create schema objects.
- The TS `RestrictedModelAInboxAcknowledger` adapter does not prove identity.
  Before live use, the backend must independently validate agent-signed scope,
  active on-chain registration, selected vault and trusted clock. SQL function
  arguments alone are not authentication. No HTTP endpoint is added.

## Requirements / limitations

This is **receipt persistence**, not a complete reliable delivery queue. A
consumer must never interpret `acknowledged` as execution approval. No leased
claims, retry scheduler, polling cursor, delivery attempts, event outbox, or
separate service credential startup audits are provided here. There is no live
runtime cutover, and the migration is not suitable for production deployment
without additional privilege and security review. PostgreSQL role-based tests
use `SET LOCAL ROLE` under a TEST-ONLY owner account, **not** separate logins.

## Test-only role provisioning

For the existing localhost `agentvault_test_76c3` database, **once**:

```bash
sudo -u postgres psql -d agentvault_test_76c3 -v ON_ERROR_STOP=1 <<'SQL'
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='av_model_a_ack') THEN
    CREATE ROLE av_model_a_ack NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
END
$role$;
GRANT av_model_a_ack TO av_test_76c3_runner WITH INHERIT FALSE;
SQL
```

This affects only role setup on the local test cluster; tests themselves
create and destroy unique private schemas. Never run these tests against live
or customer DBs. Do not use the migration owner credential in the API.

## Validation

After unzipping this package from the project root:

```bash
pnpm exec prettier --write \
  demo/model-a-postgres-agent-inbox-ack.ts \
  demo/model-a-postgres-agent-inbox-ack.test.ts
pnpm exec tsc --noEmit
pnpm exec tsx --test \
  demo/model-a-agent-inbox.test.ts \
  demo/model-a-postgres-agent-inbox.test.ts \
  demo/model-a-postgres-agent-inbox-roles.test.ts \
  demo/model-a-postgres-agent-inbox-ack.test.ts
git diff --check
```

The new test checks same-agent idempotency, cross-agent/vault denial, expiry,
unauthorized SQL operations, concurrent receipts, rollback recovery, reconnect
persistence and the original payment request remaining unchanged. **Zero skips**
required. Never manually apply SQL to the live API schema.

If all tests pass, stage exactly:

```bash
git add README-77D3C3.md \
  sql/20261113_model_a_inbox_ack.sql \
  demo/model-a-postgres-agent-inbox-ack.ts \
  demo/model-a-postgres-agent-inbox-ack.test.ts
git diff --cached --check
git diff --cached --stat
git commit -m "feat(inbox): add inactive durable acknowledgment receipts"
```

Leave `demo/fall-school-stable` untouched. Next: separate credential/login
startup audits and an authenticated signed-ack API design before optional
Devnet integration. No automatic payment execution.
