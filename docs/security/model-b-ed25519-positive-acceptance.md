# AgentVault 7.6D.12C — Explicit positive PostgreSQL Ed25519 acceptance

**Test-only, no live payments.** A passing 7.6D.12B suite does not establish that Ed25519 signature verification actually ran in PostgreSQL. The existing test intentionally passes when `pgsodium` is absent and the migration refuses installation. Do not confuse that valid *fail-closed* result with a successful *positive signature-verification* result.

`demo/model-b-ed25519-positive-acceptance.ts` has two modes:

1. Read-only prerequisite inventory (local `agentvault_test*` database only):

   ```sh
   pnpm exec tsx demo/model-b-ed25519-positive-acceptance.ts
   ```

2. **Strict positive verification** (requires existing isolated test-owner and finalizer URLs and an already-installed, extension-owned verifier):

   ```sh
   pnpm exec tsx demo/model-b-ed25519-positive-acceptance.ts --positive
   ```

Strict mode fails before the test if the verifier is absent, inaccessible, or not owned by the actual `pgsodium` extension. With the prerequisite present, it executes the existing real-PostgreSQL 7.6D.12B integration test, which covers valid dual signatures, payment-bound replay resistance, forgery denial, key rotation, terminal idempotence, and finalizer's inability to read the key registry. The integration test creates and drops a disposable private schema. It does not create or install extensions.

Do not install `pgsodium` on a shared or live database to satisfy these tests. Supabase documents pending deprecation of `pgsodium` on its platform, although PGXN distributes its own releases. Extension provenance, updates, operational security, hosting suitability, and future maintenance require an independent decision before production adoption. The database schema remains *test-only* and is not wired into live payment flows.

Even a positive test does not establish trust in the independent RPC observers, key custody, full application integration, or audit readiness. Keep broadcasting disabled and preserve `demo/fall-school-stable`.
