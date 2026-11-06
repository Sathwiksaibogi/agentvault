import assert from "node:assert/strict";
import { test } from "node:test";

import { createApiDatabase } from "./api-database";

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
