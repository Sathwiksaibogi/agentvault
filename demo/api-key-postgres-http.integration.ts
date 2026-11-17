import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";

import { createApiHandler } from "./api-handler";
import {
  extractDeveloperApiKeyId,
  generateDeveloperApiKey,
  hashDeveloperApiKey,
} from "./api-key-crypto";
import { PostgresDeveloperApiKeyRepository } from "./api-key-postgres-repository";

const VAULT_A = "11111111111111111111111111111111";

test("real PostgreSQL-backed HTTP authentication", async () => {
  const pool = new Pool({
    host: "127.0.0.1",
    port: 5432,
    database: "agentvault_test",
    user: "agentvault_app",
    connectionTimeoutMillis: 3000,
    max: 1,
  });

  let client;
  let server: ReturnType<typeof createServer> | undefined;

  try {
    const identity = await pool.query(
      "SELECT current_database() AS database, current_user AS username"
    );

    assert.equal(identity.rows[0].database, "agentvault_test");
    assert.equal(identity.rows[0].username, "agentvault_app");

    client = await pool.connect();
    await client.query("BEGIN");

    const repository = new PostgresDeveloperApiKeyRepository(client);

    const token = generateDeveloperApiKey();
    const keyId = extractDeveloperApiKeyId(token);

    assert.ok(keyId);

    const now = Date.now();

    await repository.create({
      keyId,
      principalId: `http-test-${randomBytes(8).toString("hex")}`,
      tokenHash: hashDeveloperApiKey(token),
      vaults: [VAULT_A],
      scopes: ["activity:read"],
      createdAt: now - 1000,
      expiresAt: null,
      revokedAt: null,
    });

    const calls = { activity: 0, treasury: 0 };

    server = createServer(
      createApiHandler({
        network: "localnet",
        runtimeVault: VAULT_A,
        credentials: {
          ownerToken: "a".repeat(64),
          developerToken: "b".repeat(64),
          developerVault: VAULT_A,
        },
        lookupDeveloperKey: (id) => repository.findById(id),
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

    const address = server.address();

    assert.ok(address && typeof address !== "string");

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const request = (path: string, bearer = token) =>
      fetch(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });

    const valid = await request("/api/activity");
    assert.equal(valid.status, 200);
    assert.equal(calls.activity, 1);

    const forbidden = await request("/api/treasury");
    assert.equal(forbidden.status, 403);
    assert.equal(calls.treasury, 0);

    const unknown = await request("/api/activity", generateDeveloperApiKey());
    assert.equal(unknown.status, 401);
    assert.equal(calls.activity, 1);

    const revoked = await repository.revoke(keyId, Date.now());
    assert.equal(revoked, true);

    const afterRevocation = await request("/api/activity");
    assert.equal(afterRevocation.status, 401);
    assert.equal(calls.activity, 1);
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
        server!.closeIdleConnections();
      });
    }

    if (client) {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }

    await pool.end();
  }
});

test("committed PostgreSQL credentials authenticate across connections", async () => {
  const appPool = new Pool({
    host: "127.0.0.1",
    port: 5432,
    database: "agentvault_test",
    user: "agentvault_app",
    connectionTimeoutMillis: 3000,
    max: 3,
  });

  const cleanupPool = new Pool({
    host: "127.0.0.1",
    port: 5432,
    database: "agentvault_test",
    user: "agentvault_test_cleanup",
    connectionTimeoutMillis: 3000,
    max: 1,
  });

  const token = generateDeveloperApiKey();
  const keyId = extractDeveloperApiKeyId(token);

  assert.ok(keyId);

  let server: ReturnType<typeof createServer> | undefined;

  try {
    const identity = await appPool.query(
      "SELECT current_database() AS database, current_user AS username"
    );

    assert.equal(identity.rows[0].database, "agentvault_test");
    assert.equal(identity.rows[0].username, "agentvault_app");

    const repository = new PostgresDeveloperApiKeyRepository(appPool);

    const createdAt = Date.now() - 1000;

    await repository.create({
      keyId,
      principalId: `committed-http-test-${randomBytes(8).toString("hex")}`,
      tokenHash: hashDeveloperApiKey(token),
      vaults: [VAULT_A],
      scopes: ["activity:read"],
      createdAt,
      expiresAt: null,
      revokedAt: null,
    });

    let activityCalls = 0;
    let treasuryCalls = 0;

    server = createServer(
      createApiHandler({
        network: "localnet",
        runtimeVault: VAULT_A,
        credentials: {
          ownerToken: "a".repeat(64),
          developerToken: "b".repeat(64),
          developerVault: VAULT_A,
        },
        lookupDeveloperKey: (id) => repository.findById(id),
        readers: {
          getTreasuryData: async () => {
            treasuryCalls++;
            return { balance: 100 };
          },
          getAgentsData: async () => [],
          getWorkflowIds: () => [],
          getWorkflowData: async () => null,
          getActivityData: async () => {
            activityCalls++;
            return { events: [] };
          },
        },
        cachedRead: async (_key, loader) => loader(),
      })
    );

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const request = (path: string, bearer = token) =>
      fetch(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });

    const valid = await request("/api/activity");
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { events: [] });
    assert.equal(activityCalls, 1);

    const forbidden = await request("/api/treasury");
    assert.equal(forbidden.status, 403);
    assert.equal(treasuryCalls, 0);

    const revoked = await repository.revoke(keyId, Date.now());
    assert.equal(revoked, true);

    const afterRevocation = await request("/api/activity");
    assert.equal(afterRevocation.status, 401);
    assert.equal(activityCalls, 1);

    const stored = await repository.findById(keyId);
    assert.ok(stored?.revokedAt !== null);
  } finally {
    try {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server!.close((error) => (error ? reject(error) : resolve()));
          server!.closeIdleConnections();
        });
      }
    } finally {
      try {
        // Verify cleanup is targeting the test database.
        const identity = await cleanupPool.query(
          "SELECT current_database() AS database, current_user AS username"
        );

        assert.equal(identity.rows[0].database, "agentvault_test");
        assert.equal(identity.rows[0].username, "agentvault_test_cleanup");

        await cleanupPool.query(
          "DELETE FROM developer_api_keys WHERE key_id = $1",
          [keyId]
        );
      } finally {
        await Promise.allSettled([appPool.end(), cleanupPool.end()]);
      }
    }
  }
});
