# AgentVault TypeScript SDK — 7.7D.2C.3

**Status:** private server-side SDK, not published or production-ready. It supports treasury/agent/workflow/activity reads and Devnet Model A payment-intent submission and status lookup. It cannot construct transactions, issue API keys, approve payments, or bypass finality quarantine.

## Build and test (from the AgentVault repository root)

```bash
pnpm exec tsc -p sdk/tsconfig.build.json
node --test sdk/test/*.test.mjs
```

The build outputs `sdk/dist/`; do not commit generated files. The root project already contains the TypeScript compiler.

## Usage (backend only)

```js
import { AgentVaultClient } from "./sdk/dist/index.js";

const token = process.env.AGENTVAULT_API_TOKEN;
if (!token) throw new Error("Set AGENTVAULT_API_TOKEN in the backend process");

const client = new AgentVaultClient({
  baseUrl: "http://127.0.0.1:3000",
  token,
});

const treasury = await client.getTreasury();
const agents = await client.listAgents();
console.log({ paused: treasury.paused, agentCount: agents.length });
```

Do **not** put a developer or owner Bearer token in React/Vite client code, public environment variables, logs, or committed files. These methods are subject to the API server's existing role and scope policy. HTTP is only accepted for loopback hosts; use HTTPS for remote services.

The money and nonce fields already represented as base-unit decimal strings by the frontend stay as strings in this SDK. The SDK validates all returned JSON shapes before returning typed data.

Next: integrate authenticated payment-intent intake with a safe agent-discovery mechanism. All payment execution and finality release gates remain unchanged.

## Workflow and activity reads

```ts
const ids = await client.listWorkflowIds();
for (const id of ids) {
  const status = await client.getWorkflow(id);
  console.log(status.execution.journalStatus);
}
const activity = await client.listActivity();
```

The API serves `GET /api/workflows`, `GET /api/workflows/:requestId`,
and `GET /api/activity`. Workflow IDs use the API's exact
`[a-zA-Z0-9_-]{8,64}` validation rule. The SDK rejects malformed
responses, including IDs that do not match the requested workflow.

**Security:** This SDK is designed for trusted server-side applications.
Never place a developer or owner Bearer token in browser JavaScript.
No payment-broadcasting or key-management calls are exposed. The API's
role and vault authorization rules remain authoritative.

Note: workflow amounts are numeric in the existing API response, unlike
treasury balances and task amounts, which are decimal strings. The SDK
checks workflow numeric amounts are safe integers; larger workflow values
require a separate, coordinated API contract change.

## Integration with the real API handler (7.7A.3)

After building the SDK, run the integration test using the repository's
`createApiHandler`, actual HTTP requests over an ephemeral loopback port,
and deterministic read-only data readers:

```bash
pnpm exec tsc -p sdk/tsconfig.build.json
pnpm exec tsx --test sdk/test/http-handler.integration.test.ts
```

This checks all five SDK read calls, owner/developer authorization, vault
isolation, unauthorized credentials, 404 errors, and sanitized 503 responses
through the existing backend code (not a fake `fetch` implementation).

**Test boundary:** the HTTP handler is real, but its data readers are fixtures.
This test does **not** assert live Devnet RPC, PostgreSQL integration, payment
execution, or finality acceptance. It neither starts the production server
nor reads real credentials or submits transactions.

## Model A developer payment-intent intake (7.7D.2C.3)

The SDK now supports `submitModelAPaymentIntent(input)` and
`getModelAPaymentIntent(requestId)` for trusted **server-side** integrations.
These use the explicit, short-lived `payments:request` developer API key, not an
owner session or a read-only `activity:read` credential. The API determines the
vault from that credential; request JSON has no vault parameter.

```ts
const receipt = await client.submitModelAPaymentIntent({
  requestId: "invoice_001",
  agentAuthority: agentPublicKey,
  taskId: "2",
  recipient: authorizedRecipient,
  amountBaseUnits: "1000",
  expiresAtUnix: expirationUnixSeconds,
});
const stored = await client.getModelAPaymentIntent(receipt.requestId, { includeDelivery: true });
console.log(receipt.status, stored.status, stored.delivery); // received received ...
```

**Do not automatically retry POST on transport failure.** First inspect the
intent status by request ID, then choose whether a literal, identical replay is
appropriate. The storage API returns HTTP 409 for changed terms with the same
request ID. These methods do not notify the agent or broadcast transactions.
The inbox is filesystem-backed for local development and is not production-grade.

## Agent inbox discovery and durable acknowledgments

AI agents poll for payment intents assigned to their registered on-chain
authority using a cryptographic Ed25519 challenge-response handshake:

```ts
// 1. Request a challenge nonce
const challenge = await client.requestAgentInboxChallenge(agentAuthorityPublicKey);

// 2. Sign challenge message using agent's private key (e.g. nacl.sign.detached)
const signature = signChallenge(challenge.challengeMessage, agentSecretKey);

// 3. Poll for assigned payment intents
const pendingIntents = await client.pollAgentInbox(challenge, signature);

// 4. Durably acknowledge receipt of payment intent
if (pendingIntents.length > 0) {
  const ack = await client.acknowledgeAgentInboxItem({
    challenge,
    signature,
    requestId: pendingIntents[0].requestId,
  });
  console.log(`Acknowledged receipt: ${ack.requestId} at ${ack.receivedAtUnix}`);
}
```

The challenge nonce is single-use and expires after 5 minutes. The agent
acknowledgment is durably recorded in `payment-intent-acks/` and verifiable by
intake callers via `getModelAPaymentIntent(requestId, { includeDelivery: true })`.
