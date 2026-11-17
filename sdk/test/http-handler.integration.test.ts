/**
 * Integration test of the compiled AgentVault SDK against the repository's
 * real HTTP API handler and authorization guard.
 *
 * Runs in-process with deterministic readers: no Solana RPC, database,
 * external credentials, transaction signing, or payment broadcast.
 *
 * From repo root:
 *   pnpm exec tsc -p sdk/tsconfig.build.json
 *   pnpm exec tsx --test sdk/test/http-handler.integration.test.ts
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  createApiHandler,
  type ApiDataReaders,
} from "../../demo/api-handler";
import type { ApiCredentials } from "../../demo/api-auth";
import {
  AgentVaultClient,
  AgentVaultHttpError,
} from "../dist/index.js";

const VAULT_A = "11111111111111111111111111111111";
const VAULT_B = "SysvarC1ock11111111111111111111111111111111";
const REQUEST_ID = "sdkhandler123";

const credentials: ApiCredentials = {
  ownerToken: "o".repeat(64),
  developerToken: "d".repeat(64),
  developerVault: VAULT_A,
};

const treasury = {
  network: "devnet",
  vault: VAULT_A,
  owner: "OwnerPubkey",
  tokenMint: "MintPubkey",
  treasury: "TreasuryPda",
  vaultId: "7",
  decimals: 6,
  paused: false,
  balanceBaseUnits: "900719925474099312345",
  reservedBaseUnits: "100",
  availableBaseUnits: "900719925474099312245",
};

const agent = {
  id: "agent-one",
  name: "Agent One",
  workflow: "vendor_payment",
  authority: "AuthorityPubkey",
  agentPda: "AgentPda",
  active: true,
  task: {
    taskId: 2,
    taskPda: "TaskPda",
    active: true,
    recipient: "RecipientPubkey",
    budgetBaseUnits: "1000",
    spentBaseUnits: "100",
    remainingBaseUnits: "900",
    nextNonce: "3",
    expiresAtUnix: "1799999999",
  },
};

const workflow = {
  requestId: REQUEST_ID,
  assignedAgent: "agent-one",
  workflowKind: "vendor_payment",
  taskId: 2,
  amountBaseUnits: 90,
  network: "devnet",
  recipient: "RecipientPubkey",
  approval: {
    signatureVerified: true,
    currentlyValid: true,
    expiresAtUnix: 1799999999,
  },
  aiDecision: {
    receiptFilePresent: true,
    verification: "verified",
  },
  execution: {
    journalStatus: "prepared",
    payment: null,
  },
};

const activity = {
  signature: "TransactionSignature",
  slot: 1234,
  blockTimeUnix: null,
  agentId: "agent-one",
  workflow: "vendor_payment",
  taskId: 2,
  taskPda: "TaskPda",
  succeeded: true,
  explorerUrl: "https://explorer.solana.com/tx/example?cluster=devnet",
};

type ServerContext = {
  owner: AgentVaultClient;
  developer: AgentVaultClient;
  invalid: AgentVaultClient;
  calls: string[];
};

async function withRealApi(
  run: (context: ServerContext) => Promise<void>,
  options: { runtimeVault?: string; treasuryFails?: boolean } = {},
): Promise<void> {
  const calls: string[] = [];
  const readers: ApiDataReaders = {
    getTreasuryData: async () => {
      calls.push("treasury");
      if (options.treasuryFails) throw new Error("internal secret RPC failure");
      return treasury;
    },
    getAgentsData: async () => {
      calls.push("agents");
      return { agents: [agent] };
    },
    getWorkflowIds: () => {
      calls.push("workflowIds");
      return [REQUEST_ID];
    },
    getWorkflowData: async (requestId) => {
      calls.push(`workflow:${requestId}`);
      return requestId === REQUEST_ID ? workflow : null;
    },
    getActivityData: async () => {
      calls.push("activity");
      return { activity: [activity] };
    },
  };

  const server = createServer(
    createApiHandler({
      network: "devnet",
      runtimeVault: options.runtimeVault ?? VAULT_A,
      credentials,
      readers,
      cachedRead: async <T>(
        _key: string,
        loader: () => Promise<T>,
        _ttlMs?: number,
      ): Promise<T> => loader(),
    }),
  );

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await run({
      owner: new AgentVaultClient({ baseUrl, token: credentials.ownerToken }),
      developer: new AgentVaultClient({ baseUrl, token: credentials.developerToken }),
      invalid: new AgentVaultClient({ baseUrl, token: "not-a-valid-api-token" }),
      calls,
    });
  } finally {
    // Close only this ephemeral in-process test server.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function expectHttpStatus(work: Promise<unknown>, expectedStatus: number) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof AgentVaultHttpError);
    assert.equal(error.status, expectedStatus);
    assert.ok(!error.message.includes(credentials.ownerToken));
    assert.ok(!error.message.includes(credentials.developerToken));
    return true;
  });
}

test("owner SDK reads all five routes through the real API handler", async () => {
  await withRealApi(async ({ owner, calls }) => {
    assert.deepEqual(await owner.getTreasury(), treasury);
    assert.deepEqual(await owner.listAgents(), [agent]);
    assert.deepEqual(await owner.listWorkflowIds(), [REQUEST_ID]);
    assert.deepEqual(await owner.getWorkflow(REQUEST_ID), workflow);
    assert.deepEqual(await owner.listActivity(), [activity]);
    assert.deepEqual(calls, [
      "treasury", "agents", "workflowIds", `workflow:${REQUEST_ID}`, "activity",
    ]);
  });
});

test("developer SDK is allowed activity but forbidden owner-only reads", async () => {
  await withRealApi(async ({ developer, calls }) => {
    await expectHttpStatus(developer.getTreasury(), 403);
    await expectHttpStatus(developer.listAgents(), 403);
    await expectHttpStatus(developer.listWorkflowIds(), 403);
    await expectHttpStatus(developer.getWorkflow(REQUEST_ID), 403);
    assert.deepEqual(calls, []);
    assert.deepEqual(await developer.listActivity(), [activity]);
    assert.deepEqual(calls, ["activity"]);
  });
});

test("developer cannot read activity for a different vault", async () => {
  await withRealApi(async ({ developer, calls }) => {
    await expectHttpStatus(developer.listActivity(), 403);
    assert.deepEqual(calls, []);
  }, { runtimeVault: VAULT_B });
});

test("unknown Bearer credential is rejected without reaching data readers", async () => {
  await withRealApi(async ({ invalid, calls }) => {
    await expectHttpStatus(invalid.listActivity(), 401);
    await expectHttpStatus(invalid.getTreasury(), 401);
    assert.deepEqual(calls, []);
  });
});

test("SDK preserves a 404 response for unknown workflow IDs", async () => {
  await withRealApi(async ({ owner, calls }) => {
    await expectHttpStatus(owner.getWorkflow("unknown123"), 404);
    assert.deepEqual(calls, ["workflow:unknown123"]);
  });
});

test("API reader failure stays a sanitized 503 through the SDK", async () => {
  await withRealApi(async ({ owner, calls }) => {
    await expectHttpStatus(owner.getTreasury(), 503);
    assert.deepEqual(calls, ["treasury"]);
  }, { treasuryFails: true });
});
