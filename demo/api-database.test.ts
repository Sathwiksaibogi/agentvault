import assert from "node:assert/strict";
import { test } from "node:test";

import { createApiDatabase, verifyApiDatabase } from "./api-database";

test("database configuration requires a connection URL", () => {
  assert.throws(
    () => createApiDatabase({}),
    /AGENTVAULT_DATABASE_URL is required/
  );
});

test("database configuration rejects unsupported protocols", () => {
  assert.throws(
    () =>
      createApiDatabase({
        AGENTVAULT_DATABASE_URL:
          "https://user:password@localhost:5432/agentvault_dev",
      }),
    /Invalid PostgreSQL connection URL protocol/
  );
});

test("database configuration rejects missing credentials", () => {
  assert.throws(
    () =>
      createApiDatabase({
        AGENTVAULT_DATABASE_URL:
          "postgresql://agentvault_app@localhost:5432/agentvault_dev",
      }),
    /must include host, user and password/
  );
});

test("database configuration rejects missing database name", () => {
  assert.throws(
    () =>
      createApiDatabase({
        AGENTVAULT_DATABASE_URL:
          "postgresql://agentvault_app:password@localhost:5432/",
      }),
    /database name is required/
  );
});

test("database configuration creates a PostgreSQL repository", async () => {
  const database = createApiDatabase({
    AGENTVAULT_DATABASE_URL:
      "postgresql://agentvault_app:placeholder@127.0.0.1:5432/agentvault_test",
  });

  try {
    assert.ok(database.pool);
    assert.ok(database.repository);
    assert.equal(typeof database.repository.findById, "function");
  } finally {
    await database.pool.end();
  }
});

test("database readiness rejects a missing authentication table", async () => {
  const database = createApiDatabase({
    AGENTVAULT_DATABASE_URL:
      "postgresql://agentvault_app:placeholder@127.0.0.1:5432/agentvault_test",
  });

  try {
    await assert.rejects(
      verifyApiDatabase(database, async () => ({
        rows: [
          {
            table_exists: false,
            schema_valid: false,
            permissions_valid: false,
            trigger_valid: false,
          },
        ],
      })),
      /PostgreSQL authentication schema is not ready/
    );
  } finally {
    await database.pool.end();
  }
});

test("database readiness rejects an invalid authentication schema", async () => {
  const database = createApiDatabase({
    AGENTVAULT_DATABASE_URL:
      "postgresql://agentvault_app:placeholder@127.0.0.1:5432/agentvault_test",
  });

  try {
    await assert.rejects(
      verifyApiDatabase(database, async () => ({
        rows: [
          {
            table_exists: true,
            schema_valid: false,
            permissions_valid: true,
            trigger_valid: true,
          },
        ],
      })),
      /PostgreSQL authentication schema is not ready/
    );
  } finally {
    await database.pool.end();
  }
});

test("database readiness accepts the expected authentication schema", async () => {
  const database = createApiDatabase({
    AGENTVAULT_DATABASE_URL:
      "postgresql://agentvault_app:placeholder@127.0.0.1:5432/agentvault_test",
  });

  try {
    await assert.doesNotReject(
      verifyApiDatabase(database, async () => ({
        rows: [
          {
            table_exists: true,
            schema_valid: true,
            permissions_valid: true,
            trigger_valid: true,
          },
        ],
      }))
    );
  } finally {
    await database.pool.end();
  }
});

test("database readiness rejects unsafe application permissions", async () => {
  const database = createApiDatabase({
    AGENTVAULT_DATABASE_URL:
      "postgresql://agentvault_app:placeholder@127.0.0.1:5432/agentvault_test",
  });

  try {
    await assert.rejects(
      verifyApiDatabase(database, async () => ({
        rows: [
          {
            table_exists: true,
            schema_valid: true,
            permissions_valid: false,
            trigger_valid: true,
          },
        ],
      })),
      /PostgreSQL authentication schema is not ready/
    );
  } finally {
    await database.pool.end();
  }
});

test("database readiness rejects a missing or disabled revocation trigger", async () => {
  const database = createApiDatabase({
    AGENTVAULT_DATABASE_URL:
      "postgresql://agentvault_app:placeholder@127.0.0.1:5432/agentvault_test",
  });

  try {
    await assert.rejects(
      verifyApiDatabase(database, async () => ({
        rows: [
          {
            table_exists: true,
            schema_valid: true,
            permissions_valid: true,
            trigger_valid: false,
          },
        ],
      })),
      /PostgreSQL authentication schema is not ready/
    );
  } finally {
    await database.pool.end();
  }
});
