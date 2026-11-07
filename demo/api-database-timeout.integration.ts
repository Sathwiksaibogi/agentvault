import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";

import { createApiDatabase } from "./api-database";

test("production database pool cancels slow statements and recovers", async () => {
  // Let pg resolve credentials using the same configuration
  // as the existing repository integration tests.
  const credentialPool = new Pool({
    host: "127.0.0.1",
    port: 5432,
    database: "agentvault_test",
    user: "agentvault_app",
    max: 1,
    connectionTimeoutMillis: 3000,
  });

  let password: string | undefined;

  try {
    const client = await credentialPool.connect();

    try {
      password = client.password;
    } finally {
      client.release();
    }
  } finally {
    await credentialPool.end();
  }

  assert.ok(
    typeof password === "string" && password.length > 0,
    "Test database credentials must be available"
  );

  const database = createApiDatabase({
    AGENTVAULT_DATABASE_URL:
      `postgresql://agentvault_app:${encodeURIComponent(password)}` +
      "@127.0.0.1:5432/agentvault_test",
  });

  try {
    const settings = await database.pool.query("SHOW statement_timeout");

    assert.equal(settings.rows[0]?.statement_timeout, "5s");

    const startedAt = performance.now();

    await assert.rejects(
      database.pool.query("SELECT pg_sleep(10)"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, "57014");
        return true;
      }
    );

    const elapsedMs = performance.now() - startedAt;

    assert.ok(
      elapsedMs >= 4000 && elapsedMs < 9000,
      `Unexpected timeout duration: ${elapsedMs}ms`
    );

    const result = await database.pool.query("SELECT 1 AS healthy");

    assert.equal(result.rows[0]?.healthy, 1);
  } finally {
    await database.pool.end();
  }
});
