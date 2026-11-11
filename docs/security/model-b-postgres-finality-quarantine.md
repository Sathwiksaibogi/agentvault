# 7.6D.8 — Finality quarantine (test-only containment)

**Status:** Experimental and **not production-ready**. This is a deliberate fail-closed containment measure, not a finality verification system. It is disconnected from the live AgentVault Model B executor and must not be applied to production without a reviewed migration and operational plan.

## Threat and consequence

The guarded PostgreSQL finalizer procedure validates the immutable payment identity and allows `SUBMISSION_RESERVED` or `UNRESOLVED` to transition to `CONFIRMED` or `FAILED` using **only a finalizer-supplied slot**. PostgreSQL has **no independently authenticated on-chain finality proof**. If the finalizer login is compromised, the attacker can forge successful or failed settlement metadata even when no payment was confirmed on Solana. The previous JavaScript RPC checks do not stop a stolen SQL login from invoking the procedure directly.

## Deliberate containment

The optional, single-use `sql/20261111_model_b_finality_quarantine.sql` migration is restricted to a disposable local `agentvault_test*` database and a private schema. It must run after the guarded-write migrations as the schema/table owner. The migration refuses schemas containing terminal payment records, unrecognized function definitions, or incorrect role grants.

It replaces only the existing guarded reconciliation procedure (same signature and effective EXECUTE grants). The replacement allows **only**:

`SUBMISSION_RESERVED → UNRESOLVED` with the exact immutable identity and a `NULL` finalized slot.

Calls requesting `CONFIRMED` or `FAILED` return no rows and therefore cannot persist a terminal result. Neither coordinator nor finalizer gains direct table mutation privileges. Read-only inspection still works, and the existing finalizer adapter must treat zero-row terminal CAS as a **hard failure**. No retry, resubmission, replacement transaction, or manual phase override is permitted.

**Tradeoff:** This intentionally blocks *legitimate* terminal finality persistence too. It is a safety quarantine, not a functioning terminal settlement mechanism. Do not claim full lifecycle completion with this gate active.

## Test procedure

Run the new test using the already configured local `AGENTVAULT_TEST_DATABASE_URL` and independent `AGENTVAULT_MODEL_B_TEST_FINALIZER_URL` (credentials must not be printed). The test creates a random disposable private schema, applies previous migrations, demonstrates the old forged-finality behavior inside a rolled-back transaction, applies quarantine, checks that forged terminal writes return zero rows, verifies `UNRESOLVED` remains permitted, and drops the schema. It also reruns the original privilege audit after replacement. Existing 7.6D.7 lifecycle tests use separate random schemas and remain unchanged.

**Do not manually apply this migration to the persistent `agentvault_test_76c3` database's working schemas.** The automated test provisions and tears down its own schema.

## Remaining production gate

An independently authenticated finality-evidence mechanism must be designed and reviewed before restoring terminal persistence. Possible architecture: two independent observers, independent RPC providers, authenticated evidence signatures validated by a verifier whose privileges cannot be assumed by the finalizer, strict genesis/signature/slot/result binding, and audited SQL enforcement. This proposal is not yet implemented or proven sufficient. A DBA, a compromised signing/witness quorum, and the underlying RPC data remain explicit trust assumptions. External security review, additional chain integration tests, and a reviewed recovery procedure are required before any production rollout.
