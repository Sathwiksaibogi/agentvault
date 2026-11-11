# AgentVault 7.6D.4 — Inactive coordinator wiring and read-only recovery

**State:** Testable foundation only. Not imported by the executable Model B CLI.
It does **not** authorize real Solana broadcasts or customer funds.

## Boundaries

- `openInactiveModelBCoordinatorRuntime` opens **only** the coordinator login
  through the 7.6D.1 preflight and provides `prepare` + `inspect`, not a
  submission reservation, signer, finalizer, or broadcast method.
- `openInactiveModelBReaderRecoveryRuntime` opens **only** the reader login
  and provides `inspect`; it cannot mutate any PostgreSQL payment state.
- `prepare` verifies the owner-approved serialized Model B payment, trusted
  Devnet genesis, current block height and caller-provided trusted policy
  check **before** claiming a request. The ledger/height and policy checks
  repeat immediately before persistence; any failed check leaves no claim.
- After a claim commits, **do not retry** `prepare`, even if a response is
  lost. A `CLAIMED` record may remain locked intentionally. Transaction
  preparation happens through the existing durable adapter.
- `inspect` validates stored record identity and transaction digest, returns
  only metadata, and never reserves, signs, replaces, or rebroadcasts. A
  `SUBMISSION_RESERVED` or `UNRESOLVED` record requires chain-finality
  inspection by a **separate trusted finalizer**, never a new submission.
- On corrupted/mismatched records, recovery throws instead of suggesting a
  retry. It is safe to repeat only the **read-only** inspection.

## Release blockers

The provided policy callback is *not itself proof* of trusted chain state.
A future reviewed runner must supply a trusted RPC client, recheck all Vault,
Agent, ApprovedTask, recipient, budget, nonce, expiry and treasury invariants,
use chain time and enforce the original owner-signed scope. Tests using fake
callbacks are not substitutes. The coordinator must also have its own login,
separate from the API reader and finalizer. This milestone **does not connect
or enable the 7.6D.3 fake broadcast harness**.

Solana RPC finality cannot be authenticated inside PostgreSQL. The finalizer
must be isolated and reviewed independently; the ability to forge a SQL
terminal status with compromised finalizer credentials remains a release
blocker. Network-level exactly-once broadcast cannot be guaranteed by a
PostgreSQL transaction. Production migration, external security review and
controlled Devnet integration remain outstanding.
