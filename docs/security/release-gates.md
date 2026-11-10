# AgentVault — release gates and next engineering milestones

**Status:** Internal planning baseline, not evidence of audit sign-off.

**Baseline:** `hardening/onchain-lifecycle`; keep `demo/fall-school-stable` unchanged.

**Rule:** A passing local test, Devnet settlement or app demonstration is **not** permission to move customer funds on mainnet.

## Verified baseline

- Both Model A and Model B exist and have been exercised on Devnet.
- One Model B payment, `modelb-devnet-008`, was confirmed, recovered read-only, and verified by account balances (`docs/demo/model-b-devnet-e2e.md`).
- Latest reported TypeScript demo suite: 563 passing. Earlier validator test results were reported separately; rerun relevant Anchor tests from the current commit before release.
- Existing API tests cover authorization, credentials and cross-vault access, but that does not establish an operationally secured public service.

## Gate 0 — stabilize and preserve evidence (current milestone)

- [ ] Record the verified Devnet evidence without storing private keys, signed secret files, journal contents, HMAC keys or `.env` values.
- [ ] Record deployed program ID, upgrade authority, ELF checksum/build commands and known state-account compatibility results in a signed, reproducible release manifest.
- [ ] Keep old Model A unresolved/expired journal files immutable; never delete or replay them.
- [ ] Review/revoke completed sandbox task `1003` when no further tests need it. **It had 9,000 unspent base units at the last verified snapshot**; only a separate owner-confirmed revocation should release them.
- [ ] Classify and safely archive the exposed mock key from task `1002` as permanently compromised; verify it is not used in any production fixture.
- [ ] Produce one concise branch/diff inventory before further code changes.

## Gate 1 — protocol security and adversarial testing (P0)

- [ ] Independent review of all Anchor instructions, account constraints, PDA derivations and CPI behavior.
- [ ] Test total-reserved conservation across Model A and Model B: create, execute, revoke, pause, deactivate, withdraw, expiry and concurrent transactions.
- [ ] Fuzz/proptest canonical owner-approval serialization, offsets, length, sysvar instruction ordering and signatures against Rust/TypeScript fixtures.
- [ ] Establish an emergency-pause and incident-response procedure, including authority custody and key compromise scenarios.
- [ ] Verify supported token-program/mint requirements and intentionally reject unsupported assets.
- [ ] Verify direct instruction invocation without the demo CLI cannot bypass any advertised on-chain authorization guarantee.

## Gate 2 — off-chain correctness, durability and operations (P0)

- [ ] Durable transactional store for requests, claims, submitted transaction bytes and recovery states; handle multiple hosts and concurrent workers.
- [ ] Fault-injection tests for process crash, storage error and RPC timeout at every payment lifecycle boundary.
- [ ] Enforce exact signed transaction bytes and single-submission behavior in integration tests with real validator/devnet fixtures.
- [ ] Design backup/restore procedures that never turn an unresolved request into a fresh authorization.
- [ ] Audit signing-key custody and log redaction; stop accidental publication of recovery phrases or private key material.
- [ ] Document Devnet-only Gemini sandbox configuration; exclude it from all production deployment artifacts.
- [ ] Add metrics/alerts for repeated failures, revoked agents, expired approvals and reserved-vs-available treasury checks.

## Gate 3 — API/SDK and owner experience (P1)

- [ ] Define a stable versioned developer SDK for vault/task creation, Model A payment requests, Model B approvals, status and recovery.
- [ ] Keep server-side signing and owner-side approval explicit; no private key in browser bundles or committed fixtures.
- [ ] Implement an owner dashboard for vaults, agents, tasks, reservations, approval queue and immutable activity view.
- [ ] Exercise end-to-end role separation, tenancy, revocation and rate limiting against a deployed staging environment.
- [ ] Document nonce and approval-expiry semantics for SDK consumers; reject ambiguous retries.

## Gate 4 — independent audit and production release (blocking)

- [ ] Complete independent security assessment of the exact program and off-chain release candidates.
- [ ] Resolve all critical/high findings and rerun evidence-backed regression suite; document accepted residual risks.
- [ ] Establish safe program upgrade/rollback and protected upgrade-authority operations.
- [ ] Independent reconciliation of assets and reservations, including incident and treasury-recovery simulations.
- [ ] Stage a restricted pilot with controlled value and operational monitoring; set limits and emergency response.
- [ ] Explicit owner/release approval after review of tests, audit scope and deployment hashes.

## Routine verification commands (local, no payment broadcast)

```bash
cd ~/projects/agentvault
pnpm exec tsc --noEmit
pnpm exec tsx --test demo/*.test.ts
git diff --check
git status --short
git --no-pager log -5 --oneline
```

Run Rust/Anchor validator tests in the appropriate documented validator environment for your pinned toolchain; do not substitute TypeScript mock tests for a full on-chain suite. The commands above do not deploy or execute payments.

## Immediate next code change after this docs commit

**Gate 1A: state-machine invariant and adversarial tests.** Extend existing `tests/reservation-invariants.test.ts` (or an appropriate new validator test) to cover partial Model B spending, permanent revocation of the remaining budget, Model A reservations in the same vault, transaction-order races, and replay after nonce increment. Require a narrow focused commit with test evidence. No upgrade of a live program until those tests and explicit deployment checks pass.
