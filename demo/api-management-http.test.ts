import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";

import { createApiHandler } from "./api-handler";
import { InMemoryDeveloperApiKeyRepository } from "./api-key-memory-repository";

const VAULT_A = "11111111111111111111111111111111";

const NOW = 1_800_000_000_000;

const credentials = {
  ownerToken: "a".repeat(64),
  developerToken: "b".repeat(64),
  developerVault: VAULT_A,
};

async function withManagementApi(
  run: (
    baseUrl: string,
    repository: InMemoryDeveloperApiKeyRepository,
    calls: { list: number }
  ) => Promise<void>,
  options: { disableManagement?: boolean } = {}
): Promise<void> {
  const repository = new InMemoryDeveloperApiKeyRepository();

  const calls = { list: 0 };

  await repository.create({
    keyId: "a".repeat(24),
    principalId: "developer_001",
    tokenHash: "c".repeat(64),
    vaults: [VAULT_A],
    scopes: ["activity:read"],
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
  });

  const server = createServer(
    createApiHandler({
      network: "devnet",
      runtimeVault: VAULT_A,
      credentials,

      managementRepository: options.disableManagement
        ? undefined
        : {
            listByPrincipal: async (principalId) => {
              calls.list++;
              return repository.listByPrincipal(principalId);
            },
          },

      now: () => NOW,

      readers: {
        getTreasuryData: async () => ({}),
        getAgentsData: async () => ({}),
        getWorkflowIds: () => [],
        getWorkflowData: async () => null,
        getActivityData: async () => ({}),
      },

      cachedRead: async (_key, loader) => loader(),
    })
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await run(`http://127.0.0.1:${address.port}`, repository, calls);
  } finally {
    server.closeAllConnections();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function ownerHeaders() {
  return {
    Authorization: `Bearer ${credentials.ownerToken}`,
  };
}

test("owner lists developer credential metadata over HTTP", async () => {
  await withManagementApi(async (url) => {
    const response = await fetch(`${url}/api/keys?principalId=developer_001`, {
      headers: ownerHeaders(),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.keys.length, 1);
    assert.equal(body.keys[0].principalId, "developer_001");
    assert.equal(body.keys[0].keyId, "a".repeat(24));

    const serialized = JSON.stringify(body);

    assert.equal(serialized.includes("tokenHash"), false);
    assert.equal(serialized.includes("c".repeat(64)), false);
  });
});

test("unauthenticated callers cannot list credentials", async () => {
  await withManagementApi(async (url) => {
    const response = await fetch(`${url}/api/keys?principalId=developer_001`);

    assert.equal(response.status, 401);
  });
});

test("developer credentials cannot list managed keys", async () => {
  await withManagementApi(async (url) => {
    const response = await fetch(`${url}/api/keys?principalId=developer_001`, {
      headers: {
        Authorization: `Bearer ${credentials.developerToken}`,
      },
    });

    assert.equal(response.status, 401);
  });
});

test("management listing rejects missing principal IDs", async () => {
  await withManagementApi(async (url) => {
    const response = await fetch(`${url}/api/keys`, {
      headers: ownerHeaders(),
    });

    assert.equal(response.status, 400);
  });
});

test("management listing rejects unsupported methods", async () => {
  await withManagementApi(async (url) => {
    const response = await fetch(`${url}/api/keys?principalId=developer_001`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });

    assert.equal(response.status, 405);
  });
});

test("management listing rejects duplicate principalId parameters", async () => {
  await withManagementApi(async (url) => {
    const response = await fetch(
      `${url}/api/keys?principalId=developer_001&principalId=developer_002`,
      { headers: ownerHeaders() }
    );

    assert.equal(response.status, 400);
  });
});

test("management listing rejects malformed principal IDs", async () => {
  await withManagementApi(async (url) => {
    const response = await fetch(
      `${url}/api/keys?principalId=%20developer_001`,
      { headers: ownerHeaders() }
    );

    assert.equal(response.status, 400);
  });
});

test("management listing rejects developer API keys as owner credentials", async () => {
  await withManagementApi(async (url) => {
    const response = await fetch(`${url}/api/keys?principalId=developer_001`, {
      headers: {
        Authorization: `Bearer avk_${"a".repeat(24)}_${"b".repeat(43)}`,
      },
    });

    assert.equal(response.status, 401);
  });
});

test("management listing does not expose credentials across principals", async () => {
  await withManagementApi(async (url) => {
    const response = await fetch(
      `${url}/api/keys?principalId=another_developer`,
      { headers: ownerHeaders() }
    );

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.deepEqual(body.keys, []);
  });
});

test("management listing rejects duplicate Authorization headers", async () => {
  await withManagementApi(async (url, _repository, calls) => {
    const response = await fetch(`${url}/api/keys?principalId=developer_001`, {
      headers: [
        ["Authorization", `Bearer ${credentials.ownerToken}`],
        ["Authorization", `Bearer ${credentials.ownerToken}`],
      ],
    });

    assert.equal(response.status, 401);
    assert.equal(calls.list, 0);
  });
});

test("management listing fails closed when repository lookup fails", async () => {
  await withManagementApi(async (url, repository, calls) => {
    repository.listByPrincipal = async () => {
      throw new Error("Sensitive internal PostgreSQL failure");
    };

    const response = await fetch(`${url}/api/keys?principalId=developer_001`, {
      headers: ownerHeaders(),
    });

    assert.equal(response.status, 503);
    assert.equal(calls.list, 1);

    const body = await response.text();

    assert.equal(body.includes("Sensitive internal PostgreSQL failure"), false);
  });
});

test("management listing fails closed without repository configuration", async () => {
  await withManagementApi(
    async (url, _repository, calls) => {
      const response = await fetch(
        `${url}/api/keys?principalId=developer_001`,
        { headers: ownerHeaders() }
      );

      assert.equal(response.status, 503);
      assert.equal(calls.list, 0);
    },
    { disableManagement: true }
  );
});
