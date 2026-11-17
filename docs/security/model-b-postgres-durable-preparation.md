# 7.6D.2 — Inactive Model B PostgreSQL preparation and submission reservation

**Status:** Implemented in an additive, unused module. Neither the HTTP API nor
`execute-ai-workflow-model-b.ts` imports it. It never signs or broadcasts; no
runtime flag is introduced. `demo/fall-school-stable` remains untouched.

## Separation of irreversible operations

`demo/model-b-postgres-durable-preparation.ts` accepts only the 7.6D.1
coordinator service's narrow interface (`claim`, `persistSignedPayment`,
`getForReconciliation`, and `reserveOneSubmission`). The adapter exposes:

- `prepareModelBPaymentDurably` — verifies **both owner approvals** and exact
  signed transaction, atomically claims the request ID in PostgreSQL, then
  persists the same bytes. Validates DB responses and never reserves a send.
  A crash between CLAIMED and PREPARED deliberately strands a request. Do not
  regenerate its transaction, replace approvals, or retry the claim.
- `reserveOriginalModelBSubmissionOnce` — independently re-verifies owner
  authorization and the exact PREPARED record, then attempts ONE SQL
  `PREPARED → SUBMISSION_RESERVED` CAS. Returns a copy of the original bytes
  but **does not send them**. Another worker cannot obtain a second permit.
  If the SQL response is lost, post-reservation verification fails, or the
  process crashes, assume the permit may have committed. **Never call again**;
  inspect the original request/signature and reconcile read-only.
- `inspectDurableModelBPayment` — read-only restart lookup. Cannot submit,
  claim, re-sign, or change state.

No automatic retries or replacement bytes. The private schema and SQL grant
requirements from 7.6C.8–7.6D.1 still apply. The adapter is not a substitute
for live chain policy and blockhash revalidation, signed simulation, interactive
owner intent, independent finality inspection, or deployment isolation.

## Tests

`demo/model-b-postgres-durable-preparation.test.ts` covers pre-SQL forged-byte
rejection, response substitution, post-claim crash and recovery behavior,
corrupted stored bytes, approval substitution, double reservations, concurrent
one-winner CAS, ambiguous SQL response, and read-only inspection. Its real
PostgreSQL test uses two distinct pinned clients with the restricted coordinator
NOLOGIN role on a **disposable private schema**, under the existing local
`agentvault_test*` database. This test cannot substitute for real independent
production LOGIN credentials or a process/host failure test.

## Release blockers and next integration step

The future broadcaster must be another carefully reviewed module that sends
only the original bytes after SQL reservation, at most once, with no retry
on missing/ambiguous RPC response. `SUBMISSION_RESERVED` is *not* proof that
Solana accepted or processed the transaction. Chain finality must be inspected
by a separate finalizer process before any final SQL status is accepted.

Critical unresolved threats: trusted coordinator may pass false SQL data,
trusted finalizer may forge finality observations, current DB preflight needs
real isolated logins, and this adapter is not connected to the live CLI.
Independent security review and adversarial deployment testing are required
before production or customer funds.
