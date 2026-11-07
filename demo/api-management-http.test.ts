import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";

import { request as httpRequest } from "node:http";

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
  options: {
    disableManagement?: boolean;
    failCreate?: boolean;
  } = {}
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
            create: async (record) => {
              if (options.failCreate) {
                throw new Error("Sensitive internal PostgreSQL failure");
              }

              return repository.create(record);
            },
          },

      // IMPORTANT: This belongs outside managementRepository.
      lookupDeveloperKey: (keyId) => repository.findById(keyId),

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

test("owner can issue a developer API key over HTTP", async () => {
  await withManagementApi(async (url, repository) => {
    const response = await fetch(`${url}/api/keys`, {
      method: "POST",
      headers: {
        ...ownerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        principalId: "developer_002",
        expiresAt: NOW + 86_400_000,
      }),
    });

    assert.equal(response.status, 201);

    const body = await response.json();

    assert.match(body.token, /^avk_/);
    assert.equal(typeof body.keyId, "string");

    const stored = await repository.findById(body.keyId);

    assert.ok(stored);
    assert.equal(stored.principalId, "developer_002");
    assert.deepEqual(stored.vaults, [VAULT_A]);
    assert.deepEqual(stored.scopes, ["activity:read"]);
    assert.equal(stored.expiresAt, NOW + 86_400_000);

    assert.notEqual(stored.tokenHash, body.token);
    assert.equal(JSON.stringify(stored).includes(body.token), false);

    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("developer cannot issue API keys over HTTP", async () => {
  await withManagementApi(async (url, repository) => {
    const response = await fetch(`${url}/api/keys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.developerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        principalId: "developer_002",
        expiresAt: NOW + 86_400_000,
      }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await repository.listByPrincipal("developer_002"), []);
  });
});

test("HTTP issuance rejects missing expiration", async () => {
  await withManagementApi(async (url, repository) => {
    const response = await fetch(`${url}/api/keys`, {
      method: "POST",
      headers: {
        ...ownerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        principalId: "developer_002",
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await repository.listByPrincipal("developer_002"), []);
  });
});

test("HTTP issuance rejects client-supplied vault and scopes", async () => {
  await withManagementApi(async (url, repository) => {
    const response = await fetch(`${url}/api/keys`, {
      method: "POST",
      headers: {
        ...ownerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        principalId: "developer_002",
        expiresAt: NOW + 86_400_000,
        vault: VAULT_A,
        scopes: ["treasury:read"],
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await repository.listByPrincipal("developer_002"), []);
  });
});

test("HTTP issuance rejects malformed JSON", async () => {
  await withManagementApi(async (url, repository) => {
    const response = await fetch(`${url}/api/keys`, {
      method: "POST",
      headers: {
        ...ownerHeaders(),
        "Content-Type": "application/json",
      },
      body: '{"principalId":',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await repository.listByPrincipal("developer_002"), []);
  });
});

test("HTTP issuance rejects oversized request bodies", async () => {
  await withManagementApi(async (url, repository) => {
    const response = await fetch(`${url}/api/keys`, {
      method: "POST",
      headers: {
        ...ownerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        principalId: "developer_002",
        expiresAt: NOW + 86_400_000,
        padding: "x".repeat(5000),
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await repository.listByPrincipal("developer_002"), []);
  });
});

test("HTTP issuance rejects expired and invalid timestamps", async () => {
  await withManagementApi(async (url, repository) => {
    for (const expiresAt of [NOW, NOW - 1, null, "tomorrow", 1.5]) {
      const response = await fetch(`${url}/api/keys`, {
        method: "POST",
        headers: {
          ...ownerHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          principalId: "developer_002",
          expiresAt,
        }),
      });

      assert.equal(response.status, 400);
    }

    assert.deepEqual(await repository.listByPrincipal("developer_002"), []);
  });
});

test("HTTP issuance rejects unsupported content types", async () => {
  await withManagementApi(async (url, repository) => {
    const response = await fetch(`${url}/api/keys`, {
      method: "POST",
      headers: {
        ...ownerHeaders(),
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({
        principalId: "developer_002",
        expiresAt: NOW + 86_400_000,
      }),
    });

    assert.equal(response.status, 415);
    assert.deepEqual(await repository.listByPrincipal("developer_002"), []);
  });
});

test("HTTP issuance rejects duplicate Authorization headers", async () => {
  await withManagementApi(async (url, repository) => {
    const response = await fetch(`${url}/api/keys`, {
      method: "POST",
      headers: [
        ["Authorization", `Bearer ${credentials.ownerToken}`],
        ["Authorization", `Bearer ${credentials.ownerToken}`],
        ["Content-Type", "application/json"],
      ],
      body: JSON.stringify({
        principalId: "developer_002",
        expiresAt: NOW + 86_400_000,
      }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await repository.listByPrincipal("developer_002"), []);
  });
});

test("HTTP issuance rejects additional request fields", async () => {
  await withManagementApi(async (url, repository) => {
    const response = await fetch(`${url}/api/keys`, {
      method: "POST",
      headers: {
        ...ownerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        principalId: "developer_002",
        expiresAt: NOW + 86_400_000,
        issuer: "owner",
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await repository.listByPrincipal("developer_002"), []);
  });
});

test("HTTP issuance never returns a token when persistence fails", async () => {
  await withManagementApi(
    async (url, repository) => {
      const response = await fetch(`${url}/api/keys`, {
        method: "POST",
        headers: {
          ...ownerHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          principalId: "developer_002",
          expiresAt: NOW + 86_400_000,
        }),
      });

      assert.equal(response.status, 503);

      const body = await response.text();

      assert.equal(body.includes("avk_"), false);
      assert.equal(body.includes("Sensitive internal"), false);

      assert.deepEqual(await repository.listByPrincipal("developer_002"), []);
    },
    { failCreate: true }
  );
});

test("newly issued API key can read activity but not treasury", async () => {
  await withManagementApi(async (url) => {
    const issuanceResponse = await fetch(`${url}/api/keys`, {
      method: "POST",
      headers: {
        ...ownerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        principalId: "developer_002",
        expiresAt: NOW + 86_400_000,
      }),
    });

    assert.equal(issuanceResponse.status, 201);

    const { token } = await issuanceResponse.json();

    const activityResponse = await fetch(`${url}/api/activity`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(activityResponse.status, 200);

    const treasuryResponse = await fetch(`${url}/api/treasury`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(treasuryResponse.status, 403);

    const managementResponse = await fetch(
      `${url}/api/keys?principalId=developer_002`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    assert.equal(managementResponse.status, 401);
  });
});

test("HTTP issuance rejects separate raw Authorization headers", async () => {
  await withManagementApi(async (url, repository) => {
    const payload = JSON.stringify({
      principalId: "developer_002",
      expiresAt: NOW + 86_400_000,
    });

    const result = await new Promise<{
      status: number | undefined;
      body: string;
    }>((resolve, reject) => {
      const request = httpRequest(
        `${url}/api/keys`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
          joinDuplicateHeaders: false,
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });

          response.on("end", () => {
            resolve({
              status: response.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });

          response.on("error", reject);
        }
      );

      request.on("error", reject);

      // Send two separate Authorization header lines.
      request.setHeader("Authorization", [
        `Bearer ${credentials.ownerToken}`,
        `Bearer ${credentials.ownerToken}`,
      ]);

      request.end(payload);
    });

    assert.equal(result.status, 401);
    assert.equal(result.body.includes("avk_"), false);

    assert.deepEqual(await repository.listByPrincipal("developer_002"), []);
  });
});
