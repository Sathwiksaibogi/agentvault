
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";

import { createApiHandler } from "./api-handler";

import {
  generateDeveloperApiKey,
  extractDeveloperApiKeyId,
  hashDeveloperApiKey,
} from "./api-key-crypto";

import type { DeveloperApiKeyRecord } from "./api-key-model";

const NOW = 1_800_000_000_000;

const VAULT_A = "11111111111111111111111111111111";
const VAULT_B = "SysvarC1ock11111111111111111111111111111111";

const credentials = {
  ownerToken: "a".repeat(64),
  developerToken: "b".repeat(64),
  developerVault: VAULT_A,
};

const token = generateDeveloperApiKey();
const keyId = extractDeveloperApiKeyId(token)!;

function makeRecord(
  overrides: Partial<DeveloperApiKeyRecord> = {}
): DeveloperApiKeyRecord {
  return {
    keyId,
    principalId: "developer_001",
    tokenHash: hashDeveloperApiKey(token),
    vaults: [VAULT_A],
    scopes: ["activity:read"],
    createdAt: NOW - 1000,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

async function withApiServer(
  record: DeveloperApiKeyRecord | null,
  run: (
    baseUrl: string,
    calls: { activity: number; treasury: number }
  ) => Promise<void>,
  options: {
    runtimeVault?: string;
    lookupFails?: boolean;
  } = {}
): Promise<void> {
  const calls = { activity: 0, treasury: 0 };

  const server = createServer(
    createApiHandler({
      network: "localnet",
      runtimeVault: options.runtimeVault ?? VAULT_A,
      credentials,
      lookupDeveloperKey: async (requestedId) => {
        if (options.lookupFails) {
          throw new Error("Sensitive database failure");
        }

        return requestedId === keyId ? record : null;
      },
      now: () => NOW,
      readers: {
        getTreasuryData: async () => {
          calls.treasury++;
          return { balance: 100 };
        },
        getAgentsData: async () => [],
        getWorkflowIds: () => [],
        getWorkflowData: async () => null,
        getActivityData: async () => {
          calls.activity++;
          return { events: [] };
        },
      },
      cachedRead: async (_key, loader) => loader(),
    })
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    await run(
      `http://127.0.0.1:${address.port}`,
      calls
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error ? reject(error) : resolve()
      );
    });
  }
}

function get(
  baseUrl: string,
  pathname: string,
  bearer: string = token
) {
  return fetch(`${baseUrl}${pathname}`, {
    headers: {
      Authorization: `Bearer ${bearer}`,
    },
  });
}

test("valid API key reaches activity reader", async () => {
  await withApiServer(makeRecord(), async (url, calls) => {
    const response = await get(url, "/api/activity");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { events: [] });
    assert.equal(calls.activity, 1);
  });
});

test("developer API key cannot reach treasury reader", async () => {
  await withApiServer(makeRecord(), async (url, calls) => {
    const response = await get(url, "/api/treasury");

    assert.equal(response.status, 403);
    assert.equal(calls.treasury, 0);
  });
});

test("expired API key cannot reach activity reader", async () => {
  await withApiServer(
    makeRecord({ expiresAt: NOW }),
    async (url, calls) => {
      const response = await get(url, "/api/activity");

      assert.equal(response.status, 401);
      assert.equal(calls.activity, 0);
    }
  );
});

test("revoked API key cannot reach activity reader", async () => {
  await withApiServer(
    makeRecord({ revokedAt: NOW - 100 }),
    async (url, calls) => {
      const response = await get(url, "/api/activity");

      assert.equal(response.status, 401);
      assert.equal(calls.activity, 0);
    }
  );
});

test("cross-vault API key cannot reach activity reader", async () => {
  await withApiServer(
    makeRecord(),
    async (url, calls) => {
      const response = await get(url, "/api/activity");

      assert.equal(response.status, 403);
      assert.equal(calls.activity, 0);
    },
    { runtimeVault: VAULT_B }
  );
});

test("unknown API key cannot reach activity reader", async () => {
  await withApiServer(null, async (url, calls) => {
    const response = await get(url, "/api/activity");

    assert.equal(response.status, 401);
    assert.equal(calls.activity, 0);
  });
});

test("credential lookup failures never reach readers", async () => {
  await withApiServer(
    makeRecord(),
    async (url, calls) => {
      const response = await get(url, "/api/activity");

      assert.equal(response.status, 401);
      assert.equal(calls.activity, 0);
    },
    { lookupFails: true }
  );
});

test("legacy owner still reaches treasury reader", async () => {
  await withApiServer(makeRecord(), async (url, calls) => {
    const response = await get(
      url,
      "/api/treasury",
      credentials.ownerToken
    );

    assert.equal(response.status, 200);
    assert.equal(calls.treasury, 1);
  });
});

test("legacy developer still reaches activity reader", async () => {
  await withApiServer(makeRecord(), async (url, calls) => {
    const response = await get(
      url,
      "/api/activity",
      credentials.developerToken
    );

    assert.equal(response.status, 200);
    assert.equal(calls.activity, 1);
  });
});
