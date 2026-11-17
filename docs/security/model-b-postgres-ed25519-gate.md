# AgentVault 7.6D.12B — database-side Ed25519 gate (TEST-ONLY)

This is an **optional, test-only** SQL implementation, **not a release authorization**. It is only for a disposable private schema in a local `agentvault_test*` database. **No live payment or broadcast path is activated.** Never apply to an application database or the stable demo branch.

## Why the dependency is mandatory

PostgreSQL `pgcrypto` does not verify detached Ed25519 signatures. The migration therefore requires an **already-installed, operator-vetted `pgsodium` extension**, and checks PostgreSQL catalog membership of `crypto_sign_verify_detached(bytea,bytea,bytea)`. A same-named user-created function is insufficient. This migration **does not install pgsodium**; if it is unavailable or has an unexpected privilege boundary, installation refuses and the original D.8 quarantine remains intact.

## Authorization and upgrade boundary

- Only the schema/table owner can install the gate, and only inside a dedicated disposable local test database. D.8 quarantine and the D.9 HMAC prototype must already exist.
- The same transaction revokes finalizer execution of the old HMAC terminal routine and grants execution of the new **database-verifying** Ed25519 routine. Unexpected effective ACLs abort the whole transaction; no partial upgrade.
- PostgreSQL builds both canonical v2 signed messages from the **locked stored payment record**, witness identity, key ID, active registry generation, result and finalized slot. It does not accept a payment identity or public key from the finalizer.
- Detached signatures are verified by the installed extension against two independently registered **raw 32-byte Ed25519 public keys**. The finalizer cannot write public keys, read or change the registry/policy, or directly update the payment table.
- Rotation is a **single DBA-controlled transaction**: revoke old keys, insert both new keys and update the active policy generation. Evidence from an old generation or a mixed generation is rejected. Admin key governance, operator control and retention still require a separate review.
- Existing `UNRESOLVED` observations remain locked; neither missing signatures nor an RPC ambiguity allows a new submission. The original quarantine still denies unauthenticated terminal results.

## Testing and limits

`pnpm exec tsx --test demo/model-b-postgres-ed25519-gate.test.ts` checks migration structure and, with existing local owner/finalizer test URLs, either (a) demonstrates that **missing pgsodium fails closed and leaves no new SQL objects**, or (b) if a vetted extension was installed independently, exercises real PostgreSQL Ed25519 verification, replay denial, key rotation and the old-gate ACL revocation. **A green result on a machine without pgsodium does not validate the positive database signature path. A failed install rolls back any ACL changes; if the legacy HMAC gate was separately provisioned with secrets, it remains an independent risk and must never be treated as protected by this uninstalled migration.** No PostgreSQL extensions should be installed solely to make these tests pass without separate review.

Trust assumptions remain: PostgreSQL superuser and schema owner can modify registries or functions; two RPC operators could collude or rely on correlated data; a signature authenticates a witness's observation, not Solana consensus. Production needs reviewed extension supply chain, operational key custody, separate independent RPC, migration/rollback policy, audit of function ownership and inherited grants, realistic Devnet tests, and an external security assessment. Leave live broadcasts disabled and do not treat this milestone as a security audit.
