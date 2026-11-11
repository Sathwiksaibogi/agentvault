# AgentVault TypeScript SDK — 7.7A.2

**Status:** private, server-side, read-only foundation. This is not a published or production-ready SDK. It wraps the existing treasury, agent, workflow, and activity read endpoints; it does not construct transactions, issue API keys, approve payments, or bypass finality quarantine.

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

Next: test the SDK against the current running API with permitted owner/developer roles, then integrate safe owner dashboard reads. Write operations remain a separate, explicitly reviewed slice. All payment execution and finality release gates remain unchanged.

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
