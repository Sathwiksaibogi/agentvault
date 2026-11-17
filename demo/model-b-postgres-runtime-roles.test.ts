import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { PoolClient } from "pg";
import { PostgresModelBPaymentStore } from "./model-b-postgres-payment-store";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";

const rolesSql = readFileSync(
  resolve("sql/20261111_model_b_runtime_roles.sql"),
  "utf8"
);

// These tests make no assertions about signature verification inside SQL.
// The 7.6C.6 TypeScript validator remains mandatory for authorized payments.
test("runtime privileges require separate reader/coordinator identities", () => {
  assert.match(rolesSql, /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM PUBLIC/);
  assert.match(rolesSql, /GRANT SELECT ON TABLE[\s\S]*av_model_b_reader/);
  assert.match(
    rolesSql,
    /GRANT INSERT \(request_id, genesis_hash, program_id, vault,/
  );
  assert.match(
    rolesSql,
    /GRANT UPDATE \(phase, signed_tx_bytes, signed_tx_sha256/
  );
  assert.doesNotMatch(
    rolesSql,
    /GRANT\s+(?:ALL|DELETE|TRUNCATE|TRIGGER)\s+ON\s+TABLE/i
  );
  assert.match(rolesSql, /REFUSE: runtime role acquired schema CREATE/);
});

/**
 * Local-only integration test with disposable private schema. DBA setup:
 * create NOLOGIN roles av_model_b_reader and av_model_b_coordinator, then
 * GRANT both roles TO av_test_76c3_runner WITH INHERIT FALSE (testing ONLY).
 * Never grant either role ownership, CREATE, BYPASSRLS, or superuser powers.
 */
test("real PostgreSQL: read-only API role is denied writes and coordinator is column-scoped", async (t) => {
  const connectionString = process.env.AGENTVAULT_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip(
      "Set AGENTVAULT_TEST_DATABASE_URL for the localhost agentvault_test* database"
    );
    return;
  }
  const url = new URL(connectionString);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/agentvault_test[a-zA-Z0-9_]*$/.test(url.pathname)
  ) {
    throw new Error(
      "REFUSE: runtime privilege integration must use a local agentvault_test* database"
    );
  }
  const { Pool } = await import("pg");
  const schema = `av76c7_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  let pool: InstanceType<typeof Pool> | undefined;
  let created = false;
  try {
    const prerequisites = await admin.query<{
      reader: boolean;
      coordinator: boolean;
      may_set_reader: boolean;
      may_set_coordinator: boolean;
    }>(`
      SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'av_model_b_reader') AS reader,
             EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'av_model_b_coordinator') AS coordinator,
             CASE WHEN to_regrole('av_model_b_reader') IS NULL THEN false
                  ELSE pg_has_role(current_user, 'av_model_b_reader', 'SET') END AS may_set_reader,
             CASE WHEN to_regrole('av_model_b_coordinator') IS NULL THEN false
                  ELSE pg_has_role(current_user, 'av_model_b_coordinator', 'SET') END AS may_set_coordinator
    `);
    const p = prerequisites.rows[0];
    assert.ok(
      p.reader && p.coordinator && p.may_set_reader && p.may_set_coordinator,
      "Test roles not provisioned: create av_model_b_reader/coordinator as NOLOGIN, then GRANT both TO the dedicated test database owner WITH INHERIT FALSE"
    );
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({
      connectionString,
      max: 3,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      readFileSync(resolve("sql/20261110_model_b_payment_requests.sql"), "utf8")
    );
    await pool.query(
      readFileSync(resolve("sql/20261110_model_b_payment_finality.sql"), "utf8")
    );
    await pool.query(rolesSql);

    type Client = PoolClient;
    const asRole = async <T>(
      role: "av_model_b_reader" | "av_model_b_coordinator",
      body: (client: Client) => Promise<T>
    ): Promise<T> => {
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        // Role is one of the two fixed literals above; never accept caller input.
        await client.query(`SET LOCAL ROLE ${role}`);
        const identity = await client.query<{ current_user: string }>(
          "SELECT current_user"
        );
        assert.equal(identity.rows[0].current_user, role);
        return await body(client);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    const denied = async (
      role: "av_model_b_reader" | "av_model_b_coordinator",
      sql: string
    ) => {
      await asRole(role, async (client) => {
        await assert.rejects(client.query(sql), (error: unknown) => {
          assert.equal((error as { code?: string }).code, "42501");
          return true;
        });
      });
    };

    await asRole("av_model_b_reader", async (client) => {
      const result = await client.query(
        "SELECT count(*)::int AS count FROM agentvault_model_b_payment_requests"
      );
      assert.equal(result.rows[0].count, 0);
    });
    await denied(
      "av_model_b_reader",
      "INSERT INTO agentvault_model_b_payment_requests (request_id) VALUES ('forbidden001')"
    );
    await denied(
      "av_model_b_reader",
      "UPDATE agentvault_model_b_payment_requests SET phase='PREPARED'"
    );
    await denied(
      "av_model_b_reader",
      "DELETE FROM agentvault_model_b_payment_requests"
    );
    await denied(
      "av_model_b_reader",
      "TRUNCATE agentvault_model_b_payment_requests"
    );
    await denied("av_model_b_reader", "CREATE TABLE not_allowed (x integer)");
    await denied(
      "av_model_b_coordinator",
      "INSERT INTO agentvault_model_b_payment_requests (request_id, phase) VALUES ('forbidden002', 'CONFIRMED')"
    );
    await denied(
      "av_model_b_coordinator",
      "DELETE FROM agentvault_model_b_payment_requests"
    );
    await denied(
      "av_model_b_coordinator",
      "TRUNCATE agentvault_model_b_payment_requests"
    );
    await denied(
      "av_model_b_coordinator",
      "UPDATE agentvault_model_b_payment_requests SET workflow_digest = repeat('a', 64)"
    );
    await denied(
      "av_model_b_coordinator",
      "UPDATE agentvault_model_b_payment_requests SET changed_at = clock_timestamp()"
    );
    await denied(
      "av_model_b_coordinator",
      "ALTER TABLE agentvault_model_b_payment_requests DISABLE TRIGGER agentvault_model_b_mutation_guard"
    );
    await denied(
      "av_model_b_coordinator",
      "CREATE TABLE not_allowed (x integer)"
    );

    // Even though a coordinator may write phase, the existing trigger must
    // reject a direct jump that bypasses CLAIMED -> PREPARED -> RESERVED.
    await asRole("av_model_b_coordinator", async (client) => {
      const verified = makeModelBPostgresFixture("modelb-role-guard-009");
      const store = new PostgresModelBPaymentStore(client);
      await store.claim(verified.claim);
      await assert.rejects(
        client.query(
          "UPDATE agentvault_model_b_payment_requests SET phase = 'CONFIRMED' WHERE request_id = $1",
          [verified.claim.requestId]
        ),
        /forbidden payment request phase transition/
      );
    });

    // The authorized coordinator must still be able to exercise the existing
    // cryptographic validation and exact-identity CAS through the store.
    await asRole("av_model_b_coordinator", async (client) => {
      const verified = makeModelBPostgresFixture("modelb-role-test-007");
      const store = new PostgresModelBPaymentStore(client);
      assert.equal((await store.claim(verified.claim)).phase, "CLAIMED");
      assert.equal(
        (await store.persistSignedPayment(verified.payment)).phase,
        "PREPARED"
      );
      const reserved = await store.reserveOneSubmission(
        verified.claim.requestId
      );
      assert.equal(reserved.phase, "SUBMISSION_RESERVED");
      const terminal = await store.applyInspectedStatus(reserved, {
        status: "CONFIRMED",
        requestId: verified.claim.requestId,
        signature: verified.payment.signature,
        finalizedSlot: 123,
      });
      assert.equal(terminal?.phase, "CONFIRMED");
      assert.equal(terminal?.finalizedSlot, 123);
    });
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
