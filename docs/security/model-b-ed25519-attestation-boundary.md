# AgentVault 7.6D.12A — Ed25519 witness attestation boundary (INACTIVE)

This milestone introduces asymmetric **Ed25519 detached signatures** over a domain-separated, canonical, immutable Model B payment identity and finalized outcome. It **does not authorize PostgreSQL writes** or enable broadcasting. Leave `demo/fall-school-stable` unchanged.

## Implementation

- `demo/model-b-finality-ed25519.ts` implements detached Ed25519 signatures using Node.js `crypto.sign(null, ...)` and independent verification using `crypto.verify(null, ...)` and **raw 32-byte public keys** (SPKI-wrapped only within Node.js).
- The payload covers protocol domain/version, witness identity, key ID, registry generation, exact stored payment identity, transaction signature, signed-transaction SHA-256, on-chain genesis/program/vault, terminal result, and finalized slot. It reuses the deterministic v1 length-prefixed payment envelope, under a **different v2 domain prefix**. No cross-version signature substitution is permitted.
- Signatures are generated only after the witness's **own** `inspectModelBFinality` verifies the signed bytes, history status, matching finalized receipt, slot, transaction error, and genesis before/after inspection. `UNRESOLVED` never receives a signature.
- Verification receives a **trusted**, externally administered public-key registry, not one supplied by the finalizer. Exactly one active key per observer must exist for a single generation; public keys and key IDs must be distinct. Old revoked keys are rejected. Rotation is an atomic policy generation change; mixing generations fails closed. This is a *test-only policy model*, not a deployed rotation workflow.
- Replay against a different request, signature, outcome, slot, witness role, key ID, generation, or chain is rejected. Replay of a previously terminal request is rejected by the input phase gate. **Actual one-shot persistence and race safety still require database CAS**.

## Critical remaining blocker

The existing 7.6D.9/11 PostgreSQL finality gate verifies **symmetric HMAC-SHA256**, not Ed25519. Standard `pgcrypto` has no Ed25519 detached-signature verification primitive. **Do not** call this new TypeScript verification function and then use the legacy database terminal function as if the database independently verified Ed25519; a stolen privileged finalizer login could bypass application checks.

The next slice needs a separately reviewed database-side Ed25519 verifier such as a vetted `pgsodium` extension, an authenticated capability boundary with equivalent independence, or another audited implementation. Until that is deployed and privilege-audited, keep D.8 quarantine active and all real payment broadcasting disabled. If such an extension is unavailable, **fail closed** rather than creating a second unverified SQL terminal writer.

Witness private keys should be generated and held by separate operators, not the database owner or the finalizer. This milestone uses only ephemeral test keys; it does not implement production key custody, administrative rotation, independent RPC infrastructure, or Solana consensus proofs.
