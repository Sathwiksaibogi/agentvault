# AgentVault 7.7D.1 — Model A payment intent inbox (foundation)

## Status and security boundary

This is the **first, intentionally non-executing slice** of AgentVault's payment-request system. It receives a structured *intent* from a **trusted caller** and durably stores it in a separate `payment-intent-inbox/` directory under an application-selected runtime directory.

**It is not an HTTP endpoint, scheduler, webhook, agent notification, approval, transaction, or payment.** Do not expose `receiveModelAPaymentIntent` to untrusted requests without authenticated per-vault authorization and on-chain policy verification. Do not report status `received` as `paid`.

The current `request-journal.ts` is specifically for claiming an **already approved** workflow. We intentionally do not put incoming requests into that claim journal. Model B payment/finality quarantine and the existing payment-execution guards remain unchanged.

## New files

- `demo/model-a-payment-intake.ts` — validates a bounded payment intent and persists it using exclusive create, `fsync`, 0600 permissions and idempotency keyed by (network, vault, requestId).
- `demo/model-a-payment-intake.test.mjs` — 9 tests for durability, exact duplicate handling, conflicting replay, isolation, amounts, expiry, injection and corrupted stores.

## Contract (future authenticated API body)

```json
{
  "requestId": "invoice_1042",
  "agentAuthority": "8xF8jf7n4WHVNekuEggo9Ekvt8NYEarNo1c9M6fFD7pY",
  "taskId": "1",
  "recipient": "CMbQSedspHrgqKEhUpYrxiaZkoseWcuEMWoLb4Ah7Wc",
  "amountBaseUnits": "10000",
  "expiresAtUnix": "1794593600",
  "reason": "Completed report delivery"
}
```

All amount, ID and expiry quantities are **decimal strings** (no floating point). Expiry must be in the next 24 hours. `vault`, `principalId` and `network` must come exclusively from the backend's **already authenticated and vault-authorized context**, not user-supplied JSON. The JSON example's expiry is illustrative and must be replaced with a future value when used.

The returned state is always `received`; the system has **not** verified the policy or notified any agent. An identical request from the same principal returns the original record; a changed request using the same ID fails with `PaymentIntentConflict`.

## Run checks

```bash
pnpm exec tsx --test demo/model-a-payment-intake.test.mjs
pnpm exec tsc --noEmit
pnpm exec prettier --check demo/model-a-payment-intake.ts
```

Do **not** run `pnpm lint:fix` to fix formatting in this step; it can rewrite unrelated tracked files.

## Next integration (7.7D.2)

1. Build an authenticated **developer-scoped** route, e.g. `POST /v1/payment-requests`, with exact vault-scoped authority/scope checks. Do not reuse the demo owner Bearer token for unrelated vaults. Use the existing API-key principal/role policy and PostgreSQL-backed idempotency when moving beyond single-host local development.
2. Before storing/dispatching, verify the canonical selected vault, active agent, active task, recipient, budget/remaining, nonce and expiry on Solana; handle conflict and duplicate statuses without payment submission.
3. A separately privileged dispatcher later reads the authorized inbox, calls the **existing** Model A execution checks and approval/journal boundary, and sends status updates or webhooks. Agent signature keys must not be accepted in HTTP bodies or embedded in frontend source.
4. Live Devnet payment acceptance comes **after** audit of the broadcast gate and recovery; Model B finality controls are not changed.
