# 7.6D.7 — INACTIVE Model B cross-process lifecycle integration

## Scope

This milestone adds **integration tests only**. It neither changes the live Model B
CLI nor connects payment submission to a production or Devnet RPC. The
`demo/model-b-postgres-lifecycle-worker.ts` executable is test-only: it has no
key-loading, wallet signing, network connection, or live Solana transport. The
broadcast boundary's `mode: "test-harness"` is used ONLY with an injected
in-memory fake RPC in this subprocess.

The test spans separate operating-system processes, each with exactly one of
three separately authenticated PostgreSQL `LOGIN` URLs. The parent process
receives the privileged test database URL solely to create and remove a
disposable private schema; **it never sends that URL or sibling role URLs to
children**. Children receive the signed/public test payment over stdin, not
wallet secret keys or raw database administration capabilities.

## Setup and execution

Use the local `agentvault_test_76c3` database and the three independent test
logins provisioned in milestone 7.6D.6. In the current WSL shell, export:

- `AGENTVAULT_TEST_DATABASE_URL`
- `AGENTVAULT_MODEL_B_TEST_READER_URL`
- `AGENTVAULT_MODEL_B_TEST_COORDINATOR_URL`
- `AGENTVAULT_MODEL_B_TEST_FINALIZER_URL`

Never place their values in Git, screenshots, or this chat. Do not re-run the
one-time 7.6D.6 DBA provisioning script merely to run these tests.

```bash
pnpm exec tsc --noEmit
pnpm exec tsx --test demo/model-b-postgres-lifecycle.integration.test.ts
pnpm exec tsx --test demo/*.test.ts
```

The test creates `av76d7_<random hex>` and applies the existing protected
payment, finality, role, guarded-write and privilege-audit migrations. It
executes the following independent subprocess paths:

1. Fresh owner-approved payment goes through durable `PREPARED` state, one
   SQL submission CAS, one fake-RPC send, a rejected duplicate send, and
   verified fake-RPC finality via a finalizer-only role.
2. Failed signature-verified fake simulation leaves `PREPARED` unchanged and
   sends nothing.
3. Lost SQL `claim` acknowledgment leaves `CLAIMED` locked across restarts.
   A replacement preparation fails; the reader sees only metadata.
4. Ambiguous fake send occurs after the one-time reservation; the reader sees
   `SUBMISSION_RESERVED`, a second send is forbidden, confirmed-only evidence
   becomes `UNRESOLVED`, and later matching finalized evidence settles it.
5. Incorrect fake-RPC ledger identity denies finality without any write;
   matching finalized instruction error yields `FAILED`.
6. Two independent coordinators race the same payment: only one can acquire
   the reserved send permission.

The disposable schema is dropped in a `finally` block. Four new tests should
run: three static security/structure checks and one full integration scenario.
When credentials are absent, the integration test may skip itself; that is not
proof of success. Do not commit as verified unless **all tests pass and zero
are skipped**.

## Trust boundaries and production blockers

- The injected fake chain checks are **not** authenticated Solana state.
- The finalizer still trusts the RPC provider and privileged service code;
  PostgreSQL cannot independently validate finalized Solana evidence.
- A compromised coordinator/finalizer with permitted SQL functions can lie
  about approvals or finality. Database-role isolation alone cannot solve it.
- Application-level one-time send does not guarantee exactly-once network
  delivery; ambiguous RPC outcomes require inspection, never resubmission.
- This is a test suite, **not a live runtime activation**. Production needs
  independent reviews, real secure deployment configuration, trusted chain
  policy, RPC hardening, and separate Devnet end-to-end acceptance gates.
