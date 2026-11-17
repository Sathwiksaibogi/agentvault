# 7.7D.2C.3 — AgentVault SDK Model A payment intents

This extends the existing server-side SDK. It adds **intake and status inspection only**.
It cannot approve, schedule, dispatch, sign or broadcast payments. The server's
`payments:request` credential scope and Devnet on-chain policy preflight remain authoritative.

## Installation

From `~/projects/agentvault`, after extracting this ZIP:

```bash
python3 install_77d2c3.py
pnpm exec prettier --write sdk/src/client.ts sdk/src/types.ts sdk/src/index.ts sdk/src/model-a-payment.ts sdk/test/model-a-payment.test.mjs sdk/README.md
pnpm --filter @agentvault/sdk build
pnpm --filter @agentvault/sdk test
pnpm exec tsc --noEmit
pnpm --filter frontend build
git diff --check
```

If any check fails, stop and inspect before committing.

## Example (developer backend only)

```ts
import { AgentVaultClient } from "@agentvault/sdk";

const token = process.env.AGENTVAULT_PAYMENT_REQUEST_TOKEN;
if (!token) throw new Error("Missing developer API credential");
const sdk = new AgentVaultClient({ baseUrl: "http://127.0.0.1:8787", token });

// Example parameters: use an ACTIVE agent/task, an authorized recipient, and
// the exact token base units within its remaining budget. The server enforces
// the expiry against the current time and live on-chain task expiration.
const accepted = await sdk.submitModelAPaymentIntent({
  requestId: "invoice_001",
  agentAuthority: "<agent-public-key>",
  taskId: "2",
  recipient: "<authorized-recipient-public-key>",
  amountBaseUnits: "1000",
  expiresAtUnix: "<near-future-unix-seconds>",
  reason: "Example invoice",
});
console.log(accepted.status); // "received"; NOT paid, approved or queued

const stored = await sdk.getModelAPaymentIntent(accepted.requestId);
console.log(stored.status); // "received"
```

**No automatic POST retries.** On a connection timeout the server may have
persisted the request; use `getModelAPaymentIntent(requestId)` to reconcile.
Submitting the same request ID with different terms returns HTTP 409. An
idempotent duplicate with identical terms returns HTTP 200 and `duplicate: true`.

Store the credential in a private backend secret manager. Never embed it in
React/Vite or publish it in terminal logs, screenshots or git.

## Planned next milestone

Agent request discovery/polling (separate authenticated agent-facing permission)
and a guarded execution worker; payment execution stays disabled until its
separate security/acceptance gate.
