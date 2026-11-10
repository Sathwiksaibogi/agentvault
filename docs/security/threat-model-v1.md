# AgentVault — security threat model (initial review baseline)

**Status:** Draft for owner and independent security-review preparation. **Not an audit.**

**Source baseline:** `hardening/onchain-lifecycle` through commit `43b18ff`, plus verified Devnet Model B payment on 2026-11-10.

**Scope:** Model A task payments, Model B per-payment approvals, shared vault accounting, Devnet demo runtime, AI evaluation, journal and API boundary.

## Security objectives

1. Only the vault owner can establish or revoke spending authority; agents may spend only within the applicable on-chain policy.
2. No payment can exceed an authorized task's remaining budget, alter its fixed recipient, violate expiry, or bypass nonce sequencing.
3. The treasury must stay collateralized against active task reservations. Spending and task revocation must update accounting consistently.
4. Model B must require an exact, valid owner-signed `PaymentApprovalV2`, verified through an immediately preceding native Ed25519 instruction, in addition to a valid agent signature.
5. An application failure or RPC ambiguity must not trigger a second, differently signed or rebroadcast payment for an already claimed request.
6. Untrusted AI output, workflow descriptions, external API data and client input must not grant payment authority.

## Assets, identities and trust boundaries

| Boundary | Trusted for | Not trusted for |
|---|---|---|
| Vault owner key | Creating policies and signing Model B exact payments | Safe custody by default; must be protected operationally |
| Registered agent key | Agent-side execution within an on-chain task | Increasing budget, changing recipient, owner approval |
| Solana program (`programs/agentvault/src`) | Account ownership, PDA checks, budget, nonce, expiry, token CPI, owner-approval binding | Authenticity of off-chain AI judgment or vendor invoices |
| Wallet / treasury token accounts | SPL balances after confirmed chain settlement | Business legitimacy of the recipient |
| Gemini / AI evaluator | A discretionary off-chain PAY/REJECT assessment | Signing authority, immutable truth, on-chain enforceability |
| Devnet Node/TypeScript runtime | Application orchestration and preparation of signed transactions | Integrity or availability of a compromised host |
| Journal, approval files and AI cache | Auditable local request lifecycle with verification checks | Guaranteed multi-host atomicity, immutable evidence, disaster recovery unless tested |
| API and dashboard clients | Explicitly authenticated requests within assigned scopes | Trusted identities or permission claims without validation |
| Program upgrade authority | Upgrade of deployed executable | Implicitly safe or independent security review |

Model A creates `Task` accounts; a registered agent signs payments under a predefined recipient, budget, expiry and next nonce. Model B creates separate `ApprovedTask` accounts and reconstructs an exact owner-approved message from validated chain accounts and arguments. The preceding native Ed25519 instruction verifies that message. Both models debit one shared Vault reservation balance.

**Key distinction:** the on-chain program enforces cryptographic approval and spending constraints. It does **not** prove that Gemini approved a payment. The AI evaluation is an additional application control and may be bypassed by any independent submitter who can assemble an otherwise valid signed transaction with the required agent key and (for Model B) owner approval. Do not market the AI decision as a protocol-level invariant.

## Risk register — hypotheses to validate, not confirmed exploitable vulnerabilities

| ID | Priority | Threat / failure mode | Existing boundary or evidence | Required follow-up |
|---|---|---|---|---|
| AV-01 | Critical | Compromised owner/upgrade key creates policies, signs payments, or deploys malicious bytecode | Owner signatures and upgrade-authority enforcement exist | Define custody, separation of roles, hardware/multisig, rotation, backup and recovery; document residual risk |
| AV-02 | High | Agent signing key compromised | PDAs, budget, recipient, expiry, nonce, status enforced on-chain; Model B requires exact owner signature | Validate cap-at-risk scenarios and emergency pause/deactivation; test stolen-key use of already-signed approval |
| AV-03 | High | Replay/duplicate payment during crash, timeout or RPC uncertainty | On-chain nonce; signed request digest; durable request claim and exact-byte recovery tests | Fault-injection at every claim/fsync/sign/broadcast boundary; verify no replay across processes/hosts |
| AV-04 | High | Reservation mismatch or treasury undercollateralization | Checked arithmetic, reserve release, token `transfer_checked`; tests and observed balance conservation | Independently model/test full state machine across both models and concurrent task mutations |
| AV-05 | High | Changed owner-approved payment amount, recipient, task, nonce, expiry or ledger | `PaymentApprovalV2` includes fields; canonical preceding Ed25519 instruction; adversarial tests | Independent review of serialization, CPI/account aliasing, and all checked addresses |
| AV-06 | High | Upgrade or dependency introduces an account-layout or authorization regression | Program can be upgraded under existing authority; past Model A accounts survived Devnet upgrade | Freeze audited hash, protect upgrade authority, rehearse upgrade/rollback and account-compatibility checks |
| AV-07 | High | AI prompt injection or malicious model output causes inappropriate action | Purpose treated as untrusted; deterministic app checks; `AI_REJECTED` fails closed | Red-team model inputs, fail closed on provider outage/schema mismatch, remove sandbox-only policy from prod |
| AV-08 | High | Devnet sandbox configuration accidentally enabled in production | Scoped flag checks only pinned request/addresses on Devnet | Build/deployment isolation; startup guards; CI checks; do not include pinned sandbox exception in mainnet runtime |
| AV-09 | High | Local journal/cached decision lost, tampered with, or inconsistently read across hosts | Verified exact bytes, digests, receipt checks and fail-closed tests | Define transactionally durable storage, backups, restore protocol, single-writer/locking and multi-instance test |
| AV-10 | Medium | Phishing/leakage of wallet seed phrases or CLI secrets | Exposed mock key retired; associated task revoked | Secret scanning, redaction tests, no-seed-key generation procedure, key file permissions and rotation playbook |
| AV-11 | Medium | Unauthorized API caller or cross-vault access | Authenticated owner/developer scoping and endpoint tests exist | Deploy behind TLS, test revocation propagation, rate limits, DB permission boundaries and real tenant isolation |
| AV-12 | Medium | Reserved funds stranded after task expiry or successful test | Owner-only task revocation releases unspent budget | Document lifecycle/cleanup UX and monitor reservations; test revocation following partial spend/expiry |
| AV-13 | Medium | Unexpected token/mint behavior, nonstandard token program, CPI hazards | Current payment implementation uses `anchor_spl::token` and `transfer_checked` | Explicit supported-mint policy; reject unsupported token program/extensions; audit decimals/account derivation |
| AV-14 | Medium | Nonce/race interactions among pause, revoke, deposit, withdraw and multiple agents | Existing validator security tests cover several concurrent/orderings | Review missing interleavings and high-contention stress/property tests |

## Concrete attack-path tests to prioritize

1. A stolen Model A agent key attempts exceeding budget, skipping nonce, paying a different wallet, paying after expiry, and paying after owner pause/revoke.
2. A stolen Model B agent key attempts payment without owner Ed25519 approval; with an approval for a different task/mint/recipient/amount/genesis/nonce; with a once-valid but expired approval; and with a previously executed approval.
3. Transaction assembly moves Ed25519 away from the immediately preceding instruction, inserts an extra transfer, changes token accounts, or tampers with serialized bytes after signing.
4. Crash and recovery simulation around claimed-but-not-sent, sent-but-not-confirmed, processed-only, expired-but-unobserved, and status-query failure. Never replace or replay an unresolved journal.
5. Two agents race against total reserved funds; owner concurrently revokes/pauses/withdraws. Assert conservation and no double payment.
6. Sandbox-only Gemini output contains REJECT, malformed JSON, invalid amount, malicious purpose text or provider errors. Ensure the app fails closed and no journal claim occurs.
7. API callers present expired/revoked keys, forged scopes, unknown routes and cross-vault identifiers. Verify that privileged reads are never reached.

## Review notes and known scope exclusions

- Program addresses and signatures above refer only to the recorded **Devnet** demonstration.
- `PaymentApprovalV2` uses an on-chain `ApprovedTask` genesis hash and program ID to bind authorization, but independent reviewers must validate encoding and all account constraints.
- Upgradable programs remain subject to compromise/misconfiguration of their authority.
- Logs, green tests and Devnet settlement cannot replace an independent audit.
- Do not treat a successful Gemini sandbox `PAY` as evidence that a real procurement decision was safe.
- No claim here that multisig, HSM, cross-host journal storage, formal verification, or mainnet deployment are already implemented.

## Expected reviewer deliverables

Threat assumptions, full instruction/account map, owner/agent signing authority matrix, canonical message layout, invariants, property-based and adversarial tests, reproducible program build/deployed hash, dependency inventory, validated operational runbooks, severity-ranked findings and fixes, and a signed release decision.
