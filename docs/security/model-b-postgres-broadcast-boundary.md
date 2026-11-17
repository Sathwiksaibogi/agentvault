# 7.6D.3 — Model B PostgreSQL broadcast boundary (inactive)

The exported `exerciseModelBPostgresBroadcastBoundary` **is not imported by the
live execution CLI**. Its `test-harness` mode is only for injected fake Solana
RPC tests, **not** for a live RPC or production deployment. There is no supported
production activation switch in this milestone.

## Order of operations

1. Fail closed unless explicitly running the isolated test harness.
2. Cryptographically verify the exact owner-approved Model B payment. Reject
   any ledger other than the independently configured trusted Devnet genesis.
3. Obtain a fresh on-chain policy check from the trusted caller; verify RPC
   genesis and confirmed block height (the original blockhash must still live).
4. Simulate the **original bytes** with `sigVerify: true` and
   `replaceRecentBlockhash: false`; reject simulation failures.
5. Recheck ledger, block height, and trusted policy **before** reserving.
6. Atomically transition `PREPARED -> SUBMISSION_RESERVED` using the existing
   one-winner PostgreSQL CAS; compare the returned transaction to the original.
7. Make at most one `sendRawTransaction` call using **only the reserved bytes**,
   `skipPreflight: false`, and `maxRetries: 0`. Do not automatically retry a
   failed, lost, contradictory, or ambiguous RPC response.
8. Return `rpc_accepted_not_finalized` only if the returned signature matches.
   Reconciliation belongs to the separately isolated finalizer, not this module.

## Remaining blockers

- A database reservation and a Solana transaction broadcast are **not atomic**.
  Lost SQL acknowledgments and RPC timeouts remain permanently ambiguous until
  independent chain inspection. Never reset the durable reservation or issue a
  second payment. The network/provider may also retry outside app-level control.
- A caller-supplied policy callback is a **trust boundary**, not independently
  authenticated evidence. Production integration must wire the reviewed live
  on-chain guard, explicit trusted Devnet identity, and real isolated database
  credentials. It must not supply a no-op callback.
- `mode: "test-harness"` does not prevent misuse with a real network connection.
  It only avoids accidental activation. Do not call this function with a real
  `Connection`; production activation requires a distinct reviewed runner.
- The finalizer can still write forged status data if its own service is
  compromised. SQL grants alone cannot authenticate Solana finality.
- No signing, CLI changes, mainnet access, or customer-fund handling are
  included in this milestone.
