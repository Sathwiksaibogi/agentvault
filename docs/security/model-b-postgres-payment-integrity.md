# Milestone 7.6C.6 — Model B PostgreSQL payment integrity boundary

This is an **inactive/test-only** storage hardening milestone. It does not sign, submit, or broadcast any transaction, and it does not change the Devnet CLI executor.

Before any `CLAIMED -> PREPARED` PostgreSQL update, `persistSignedPayment` requires an owner-signed Model B workflow and payment approval, verified via the existing v2 signatures and binding routines. The signed transaction must exactly match the canonical three-instruction message (`idempotent ATA`, native `Ed25519`, `execute_approved_payment`) with the approved agent fee payer, accounts, amount, nonce, expiry, request hash, recipient and program. The exact workflow and payment approval digests are recomputed from authenticated messages and signatures. All immutable claim fields are compared in the atomic SQL UPDATE predicate, preventing a same-request/different-approval prepared payment.

## Tests

- Unit: valid signed payment, wrong request, missing authorization context, plain signed SOL transfer, extra transfer, altered amount, forged owner signatures, wrong nonce/agent PDA/recipient/amount, expired owner signatures even with forged `nowUnix`, and SQL CAS identity predicate. Invalid cases must not reach PostgreSQL.
- Local PostgreSQL (opt in only with `AGENTVAULT_TEST_DATABASE_URL`): real signed Model B fixtures through the existing coordination and finality-race tests. Mismatched claimed payment digest must remain `CLAIMED`; one submission reservation and one reconciler still win under concurrency.

## Unmet release requirements

- No direct client/third-party SQL privileges. PostgreSQL has no built-in verification of these Solana signatures; a compromised highly privileged DB writer can bypass the application checks. Validate role privileges and add a reviewed write-service boundary before live use.
- Live executor integration is **NOT ENABLED**. Recheck actual on-chain policy and trusted clock, nonce, and token balances before signing and submitting. A caller-provided task expiry or nonce is only internally checked for consistency here; it is **not independently fetched** by this offline validator.
- Plan safe migration of historical file-journal claims (including unresolved Model A/B IDs); test process crashes, operator restores, failover, and backup. Do not apply to mainnet or production as-is.
