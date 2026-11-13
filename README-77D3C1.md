# AgentVault 77D3C1 — PostgreSQL inbox foundation (inactive)

This is an **additive** storage milestone; the running Devnet API remains on its existing filesystem intake and signed agent inbox. No payments are approved, claimed, or executed. There is **no automatic cutover**.

## New files

- `sql/20261113_model_a_agent_inbox.sql`: private-schema migration with unique `(network, vault, request_id)`, immutable received-state binding and a discovery index. It revokes table access from `PUBLIC`; do not grant broad runtime access.
- `demo/model-a-postgres-agent-inbox.ts`: explicitly-scoped PostgreSQL `receive`, `read` and `discover` methods with parameterized SQL, duplicate/conflict detection and row integrity checks. Uses the existing Model A request validator and types.
- `demo/model-a-postgres-agent-inbox.test.ts`: disposable private-schema tests with concurrent idempotent intake, conflict rejection, agent/vault separation, expiry and reconnect durability.

## Apply without overwriting existing work

From `~/projects/agentvault`:

```bash
unzip -n /path/to/agentvault-77d3c1-foundation.zip
pnpm exec prettier --write demo/model-a-postgres-agent-inbox.ts demo/model-a-postgres-agent-inbox.test.ts
pnpm exec tsc --noEmit
pnpm exec tsx --test demo/model-a-agent-inbox.test.ts
```

Set `AGENTVAULT_TEST_DATABASE_URL` to an existing **local dedicated** database named `agentvault_test_*`. Do not print or commit the URL. The test creates and then drops a randomized schema. Use an appropriate test role with schema creation privileges. Example to load a secret from your existing local environment (not a production URL):

```bash
pnpm exec tsx --test demo/model-a-postgres-agent-inbox.test.ts
```

**Fail if the PostgreSQL test is skipped**; an unset test URL does not count as verification.

Review file changes, then commit only the new files when ALL checks pass:

```bash
GIT_PAGER=cat git status --short
GIT_PAGER=cat git diff --check
# Untracked new files do not appear in 'git diff' until staged.
git add sql/20261113_model_a_agent_inbox.sql demo/model-a-postgres-agent-inbox.ts demo/model-a-postgres-agent-inbox.test.ts README-77D3C1.md
git diff --cached --check
git diff --cached --stat
git commit -m "feat(inbox): add inactive PostgreSQL Model A store foundation"
```

## Security limits and next step

This is **not** a production-safe service cutover. It intentionally does not modify the API, execute payments, acknowledge deliveries, or add retry behavior. The table must only be deployed inside a tightly controlled private schema by a trusted migration principal. A service credential with general table SELECT still has cross-tenant data exposure risk. Before wiring requests into this store:

1. Add dedicated low-privilege writer and reader roles / guarded SQL or equivalent database authorization, with privilege-audit tests.
2. Define atomic intake-plus-queue semantics; test process crash/restart and cross-instance concurrency.
3. Add monotonic per-item delivery/acknowledgment states with idempotency and retention policy. Acknowledgment must never imply payment authorization.
4. Wire the existing authenticated + on-chain verified request/poll handlers behind an explicit devnet feature flag; do not silently switch databases.
5. Demonstrate live registered-agent isolation and regression tests, then conduct independent security review before any production release.

Do not reuse Model B coordinator/finalizer database roles for Model A inbox storage. Do not run this migration in `public`, do not run against mainnet/customer production databases, and do not assume local Postgres test results prove full API security.
