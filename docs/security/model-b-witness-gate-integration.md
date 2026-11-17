# Model B 7.6D.11 — Test-only independent witness-to-PostgreSQL gate

**Not production-ready. No live broadcast.** This milestone exercises the
existing isolated witness inspector (7.6D.10) and the guarded HMAC-SHA256
PostgreSQL gate (7.6D.9) in a single disposable local integration.

## What runs

The local `agentvault_test*` DB schema is created and removed by the test
owner. Two independent child processes open *reader-only* PostgreSQL logins;
each independently fetches the immutable signed transaction and inspects its
own **synthetic** RPC result, keeping one distinct ephemeral witness secret.
A third, separately authenticated finalizer child process receives only the
resulting attestations. It holds **neither** witness key, and PostgreSQL checks
both MACs against the stored payment before accepting `CONFIRMED` or `FAILED`.

The test verifies: genuine matching finalized success and finalized failure;
missing witness, forged MAC, mismatched request/payment identity, disagreement,
confirmed-only evidence, wrong ledger, and terminal replay. No child can
claim, sign, reserve, or broadcast a transaction. The parent test harness
necessarily provisions both temporary keys into the disposable schema; this
is **not** an acceptable production secret-distribution pattern.

## Run (after 7.6D.6 local test logins have been provisioned)

Configure these three existing environment variables for the **same local
`agentvault_test*` database** (do not print passwords or connection URLs):
`AGENTVAULT_TEST_DATABASE_URL`, `AGENTVAULT_MODEL_B_TEST_READER_URL`, and
`AGENTVAULT_MODEL_B_TEST_FINALIZER_URL`. The coordinator test URL is not
required by this milestone. Then run:

```bash
pnpm exec prettier --check \
  demo/model-b-finality-witness-agreement.ts \
  demo/model-b-postgres-witness-gate-test-worker.ts \
  demo/model-b-postgres-witness-gate.integration.test.ts
pnpm exec tsc --noEmit
pnpm exec tsx --test demo/model-b-postgres-witness-gate.integration.test.ts
pnpm exec tsx --test demo/*.test.ts
```

If no test URLs are configured, the real-database test skips; **zero skips**
are required before counting the milestone as integration-verified. A partial
set of credentials is rejected. Schema names are randomly generated, validated,
and dropped in `finally`. Never run the D.8/D.9 SQL migrations manually on
an application schema.

## Deliberate trust and release blockers

- Synthetic RPC responses test the finality inspector, **not Solana consensus**.
  Two RPC providers may share infrastructure or return incorrect evidence.
- Symmetric HMAC witness secrets are readable by the test database owner/DBA.
  This prototype still trusts the DBA and test key provisioner; it is not a
  sound production key-custody boundary. Prefer audited asymmetric signatures
  with public keys only in the database, plus controlled key rotation.
- The real witness worker is not launched by this test. Two isolated
  read-only subprocesses execute the same inspection code with controlled fake
  RPC, and the inactive live-facing worker remains disconnected.
- The SQL gate has not been wired into production finality reconciliation or
  a live payment executor. Existing live paths remain unaffected.
- The finalizer's application-level agreement check does not validate MACs;
  only the independently privileged SQL gate performs authentication.
- Do not enable transaction submission, deploy the test migration, or declare
  AgentVault production-ready on the basis of these tests.
