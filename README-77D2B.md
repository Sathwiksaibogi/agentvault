# AgentVault 7.7D.2B — authenticated Model A payment-intent HTTP intake

Local development only. This endpoint **accepts requests, never triggers payments**.

- `POST /api/model-a/payment-intents`: strict JSON body exactly matching `ModelAPaymentIntentInput`; returns HTTP 202 with `status: received`, 200 for an identical retry, 409 for conflicting reused IDs.
- `GET /api/model-a/payment-intents/:requestId`: returns the stored `received` record for the same developer principal and vault.
- Both routes require an `avk_...` developer API key with **only** `payments:request` scope and exactly one vault. Neither legacy Bearer token nor existing `activity:read` keys can use them.
- The vault comes from the verified key record, not from the HTTP body/query. The handler checks the Devnet genesis, then calls the existing on-chain Model A policy preflight before storing new intents.
- Existing key issuance `POST /api/keys` defaults to `activity:read`; a legacy demo owner may now explicitly request `{ "principalId": "dev-1", "expiresAt": <Unix milliseconds>, "scope": "payments:request" }`. Elevated keys must expire within 24 hours. Key secrets are returned only at issuance. **Never send them to a browser.**
- This legacy management route issues only for the configured demo vault. Issuance from independent Phantom-owner sessions still needs to be implemented and security-tested before this serves multi-owner developers.
- Disk inbox is a *single-process local-development prototype*, not a production transaction-journal or delivery queue. Request acceptance does not deliver a notification to an agent, make an owner approval, or execute a payment.
- No existing Model B execution, PostgreSQL finality quarantine, or Solana program code changed.

Verification:

```
pnpm exec tsx --test demo/model-a-payment-http.test.ts
pnpm exec tsx --test demo/model-a-payment-intake.test.mjs
pnpm exec tsx --test demo/model-a-payment-policy.test.ts
pnpm exec tsx --test demo/api-key-issuance.test.ts demo/api-key-resolver.test.ts demo/api-key-management.test.ts demo/api-management-http.test.ts
pnpm exec tsc --noEmit
```
