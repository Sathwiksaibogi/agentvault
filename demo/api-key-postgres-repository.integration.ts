
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolClient } from "pg";

import type { DeveloperApiKeyRecord } from "./api-key-model";
import { PostgresDeveloperApiKeyRepository } from "./api-key-postgres-repository";

const pool = new Pool({
  host: "127.0.0.1",
  port: 5432,
  database: "agentvault_test",
  user: "agentvault_app",
  connectionTimeoutMillis: 3000,
  max: 5,
});

function createTestRecord(
  overrides: Partial<DeveloperApiKeyRecord> = {},
): DeveloperApiKeyRecord {
  return {
    keyId: randomBytes(12).toString("hex"),
    principalId: "integration-test-developer",
    tokenHash: randomBytes(32).toString("hex"),
    vaults: ["11111111111111111111111111111111"],
    scopes: ["activity:read"],
    createdAt: Date.now(),
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

async function withRollback(
  run: (
    repository: PostgresDeveloperApiKeyRepository,
    client: PoolClient,
  ) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const repository =
      new PostgresDeveloperApiKeyRepository(client);

    await run(repository, client);
  } finally {
    try {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
  }
}

before(async () => {
  const result = await pool.query(
    "SELECT current_database() AS database, current_user AS username",
  );

  assert.equal(result.rows[0].database, "agentvault_test");
  assert.equal(result.rows[0].username, "agentvault_app");
});

after(async () => {
  await pool.end();
});

test("PostgreSQL creates and retrieves a credential", async () => {
  await withRollback(async (repository) => {
    const record = createTestRecord();

    await repository.create(record);

    const stored = await repository.findById(record.keyId);

    assert.deepEqual(stored, record);
  });
});

test("PostgreSQL returns null for an unknown key", async () => {
  await withRollback(async (repository) => {
    const result = await repository.findById(
      randomBytes(12).toString("hex"),
    );

    assert.equal(result, null);
  });
});

test("PostgreSQL rejects duplicate key identifiers", async () => {
  await withRollback(async (repository) => {
    const record = createTestRecord();

    await repository.create(record);

    await assert.rejects(
      repository.create(record),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505",
    );
  });
});

test("PostgreSQL revocation is irreversible", async () => {
  await withRollback(async (repository) => {
    const record = createTestRecord();

    await repository.create(record);

    const revokedAt = record.createdAt + 1000;

    assert.equal(
      await repository.revoke(record.keyId, revokedAt),
      true,
    );

    assert.equal(
      await repository.revoke(record.keyId, revokedAt + 1000),
      false,
    );

    const stored = await repository.findById(record.keyId);

    assert.equal(stored?.revokedAt, revokedAt);
  });
});

test("PostgreSQL rejects invalid revocation timestamps", async () => {
  await withRollback(async (repository) => {
    const record = createTestRecord();

    await repository.create(record);

    await assert.rejects(
      repository.revoke(record.keyId, -1),
      /Invalid revocation timestamp/,
    );

    await assert.rejects(
      repository.revoke(record.keyId, Number.NaN),
      /Invalid revocation timestamp/,
    );

    assert.equal(
      await repository.revoke(record.keyId, record.createdAt - 1),
      false,
    );
  });
});

test("PostgreSQL lists only principal metadata", async () => {
  await withRollback(async (repository) => {
    const principalId = `test-${randomBytes(8).toString("hex")}`;

    const first = createTestRecord({ principalId });
    const second = createTestRecord({ principalId });

    const other = createTestRecord({
      principalId: "another-test-principal",
    });

    await repository.create(first);
    await repository.create(second);
    await repository.create(other);

    const results = await repository.listByPrincipal(principalId);

    assert.equal(results.length, 2);

    assert.deepEqual(
      new Set(results.map((record) => record.keyId)),
      new Set([first.keyId, second.keyId]),
    );

    for (const record of results) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(record, "tokenHash"),
        false,
      );

      assert.equal(record.principalId, principalId);
    }
  });
});


test("PostgreSQL propagates database query failures", async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const repository =
      new PostgresDeveloperApiKeyRepository(client);

    // Deliberately trigger a PostgreSQL error.
    await assert.rejects(
      client.query("SELECT 1 / 0"),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "22012",
    );

    // PostgreSQL now marks this transaction as aborted.
    // Repository queries must propagate the database error.
    await assert.rejects(
      repository.findById(randomBytes(12).toString("hex")),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "25P02",
    );
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
});





test("PostgreSQL permits only one concurrent revocation", async () => {
  const record = createTestRecord();
  const repository = new PostgresDeveloperApiKeyRepository(pool);

  // Dedicated cleanup connection, never used by the API.
  const cleanupPool = new Pool({
    host: "127.0.0.1",
    port: 5432,
    database: "agentvault_test",
    user: "agentvault_test_cleanup",
    connectionTimeoutMillis: 3000,
    max: 1,
  });

  try {
    // Commit a unique fixture so separate connections can see it.
    await repository.create(record);

    const revokedAt = record.createdAt + 1000;

    // Separate pool connections can compete for the same row.
    const results = await Promise.all([
      repository.revoke(record.keyId, revokedAt),
      repository.revoke(record.keyId, revokedAt + 1),
    ]);

    assert.deepEqual(results.sort(), [false, true]);

    const stored = await repository.findById(record.keyId);

    assert.ok(stored);
    assert.ok(
      stored.revokedAt === revokedAt ||
      stored.revokedAt === revokedAt + 1,
    );
  } finally {
    try {
      // Exact-key cleanup, never a broad principal-based DELETE.
      await cleanupPool.query(
        "DELETE FROM developer_api_keys WHERE key_id = $1",
        [record.keyId],
      );
    } finally {
      await cleanupPool.end();
    }
  }
});


