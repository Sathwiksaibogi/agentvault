import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { PoolClient } from "pg";
import { GuardedPostgresModelBPaymentStore } from "./model-b-postgres-payment-store";
import { makeModelBPostgresFixture } from "./model-b-postgres-payment-fixture";

const guardedSql = readFileSync(
  resolve("sql/20261111_model_b_guarded_writes.sql"),
  "utf8"
);

test("guarded payment migration revokes direct DML and separates finality execution", () => {
  assert.match(
    guardedSql,
    /REVOKE INSERT \(request_id, genesis_hash, program_id/
  );
  assert.match(guardedSql, /REVOKE UPDATE \(phase, signed_tx_bytes/);
  assert.match(guardedSql, /SECURITY DEFINER SET search_path = pg_catalog/g);
  assert.match(
    guardedSql,
    /GRANT EXECUTE ON FUNCTION[\s\S]*?agentvault_model_b_reconcile_guarded[\s\S]*?TO av_model_b_finalizer/
  );
  assert.match(guardedSql, /REFUSE: direct column mutation privilege remains/);
  assert.doesNotMatch(
    guardedSql,
    /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)\s+ON\s+TABLE/i
  );
});

test("guarded payment storage rejects unsafe or absent schema names", () => {
  const fake = {
    async query() {
      throw new Error("should not query");
    },
  };
  for (const bad of [
    undefined,
    "",
    "public",
    "information_schema",
    "pg_temp_1",
    "public;DROP TABLE payments",
    'agentvault".payments',
    "MixedCase",
    "a",
  ]) {
    assert.throws(
      () => new GuardedPostgresModelBPaymentStore(fake as never, bad as string),
      /explicit private schema/
    );
  }
});

test("guarded payment queries pin their private schema, never the session search_path", async () => {
  const statements: string[] = [];
  const fake = {
    async query(sql: string) {
      statements.push(sql);
      return { rowCount: 0, rows: [] };
    },
  };
  const store = new GuardedPostgresModelBPaymentStore(
    fake as never,
    "av76c9_private"
  );
  const verified = makeModelBPostgresFixture("modelb-audit-schema-001");
  await assert.rejects(store.claim(verified.claim), /already transitioned/);
  await assert.rejects(
    store.persistSignedPayment(verified.payment),
    /already transitioned/
  );
  await assert.rejects(
    store.reserveOneSubmission(verified.claim.requestId),
    /already transitioned/
  );
  assert.equal(await store.get(verified.claim.requestId), null);
  assert.equal(
    await store.getForReconciliation(verified.claim.requestId),
    null
  );
  const expected = {
    ...verified.claim,
    phase: "SUBMISSION_RESERVED" as const,
    signedTransaction: Buffer.from(verified.payment.signedTransaction),
    signedTransactionSha256: createHash("sha256")
      .update(verified.payment.signedTransaction)
      .digest("hex"),
    signature: verified.payment.signature,
    lastValidBlockHeight: verified.payment.lastValidBlockHeight,
  };
  assert.equal(
    await store.applyInspectedStatus(expected, {
      status: "UNRESOLVED",
      requestId: verified.claim.requestId,
      signature: verified.payment.signature,
    }),
    null
  );
  assert.equal(statements.length, 6);
  for (const sql of statements) {
    assert.match(sql, /"av76c9_private"\.agentvault_model_b_/);
    assert.doesNotMatch(
      sql,
      /FROM\s+agentvault_model_b_/,
      "Unqualified payment lookup"
    );
  }
});

/**
 * Run exclusively in disposable private schemas under a dedicated localhost
 * agentvault_test* PostgreSQL database. Requires the existing two NOLOGIN
 * roles plus av_model_b_finalizer, and explicit SET ROLE permission for the
 * test database owner. No real Solana payment is submitted.
 */
test("real PostgreSQL: guarded functions permit the lifecycle but prohibit direct coordinator SQL writes", async (t) => {
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
      "REFUSE: guarded-write integration requires a local agentvault_test* database"
    );
  }
  const { Pool } = await import("pg");
  const schema = `av76c8_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  let pool: InstanceType<typeof Pool> | undefined;
  let created = false;
  try {
    const prerequisite = await admin.query<{
      reader: boolean;
      coordinator: boolean;
      finalizer: boolean;
      may_set_reader: boolean;
      may_set_coordinator: boolean;
      may_set_finalizer: boolean;
    }>(`
      SELECT to_regrole('av_model_b_reader') IS NOT NULL AS reader,
             to_regrole('av_model_b_coordinator') IS NOT NULL AS coordinator,
             to_regrole('av_model_b_finalizer') IS NOT NULL AS finalizer,
             CASE WHEN to_regrole('av_model_b_reader') IS NULL THEN false
                  ELSE pg_has_role(current_user, 'av_model_b_reader', 'SET') END AS may_set_reader,
             CASE WHEN to_regrole('av_model_b_coordinator') IS NULL THEN false
                  ELSE pg_has_role(current_user, 'av_model_b_coordinator', 'SET') END AS may_set_coordinator,
             CASE WHEN to_regrole('av_model_b_finalizer') IS NULL THEN false
                  ELSE pg_has_role(current_user, 'av_model_b_finalizer', 'SET') END AS may_set_finalizer
    `);
    const p = prerequisite.rows[0];
    assert.ok(
      p.reader &&
        p.coordinator &&
        p.finalizer &&
        p.may_set_reader &&
        p.may_set_coordinator &&
        p.may_set_finalizer,
      "Local test-only NOLOGIN roles and SET ROLE membership missing (including av_model_b_finalizer)"
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
    await pool.query(
      readFileSync(resolve("sql/20261111_model_b_runtime_roles.sql"), "utf8")
    );
    await pool.query(guardedSql);

    // Prove the effective grants, not merely the syntactic SQL policy.
    const grants = await pool.query<{
      reader_mutate: boolean;
      coordinator_mutate: boolean;
      finalizer_mutate: boolean;
      reader_claim: boolean;
      coordinator_claim: boolean;
      coordinator_finalize: boolean;
      finalizer_finalize: boolean;
    }>(`
      SELECT has_table_privilege('av_model_b_reader',
               'agentvault_model_b_payment_requests', 'UPDATE') AS reader_mutate,
             has_column_privilege('av_model_b_coordinator',
               'agentvault_model_b_payment_requests', 'phase', 'UPDATE') AS coordinator_mutate,
             has_column_privilege('av_model_b_finalizer',
               'agentvault_model_b_payment_requests', 'phase', 'UPDATE') AS finalizer_mutate,
             has_function_privilege('av_model_b_reader',
               'agentvault_model_b_claim_guarded(text,text,text,text,text,text)', 'EXECUTE') AS reader_claim,
             has_function_privilege('av_model_b_coordinator',
               'agentvault_model_b_claim_guarded(text,text,text,text,text,text)', 'EXECUTE') AS coordinator_claim,
             has_function_privilege('av_model_b_coordinator',
               'agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint)', 'EXECUTE') AS coordinator_finalize,
             has_function_privilege('av_model_b_finalizer',
               'agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint)', 'EXECUTE') AS finalizer_finalize
    `);
    assert.deepEqual(grants.rows[0], {
      reader_mutate: false,
      coordinator_mutate: false,
      finalizer_mutate: false,
      reader_claim: false,
      coordinator_claim: true,
      coordinator_finalize: false,
      finalizer_finalize: true,
    });

    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      const setRole = async (
        role:
          | "av_model_b_reader"
          | "av_model_b_coordinator"
          | "av_model_b_finalizer"
      ) => {
        await client.query(`SET LOCAL ROLE ${role}`);
        const identity = await client.query<{ current_user: string }>(
          "SELECT current_user"
        );
        assert.equal(identity.rows[0].current_user, role);
      };
      const denied = async (sql: string, args: unknown[] = []) => {
        await client.query("SAVEPOINT prohibited_sql");
        try {
          await assert.rejects(client.query(sql, args), (error: unknown) => {
            assert.equal((error as { code?: string }).code, "42501");
            return true;
          });
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT prohibited_sql");
          await client.query("RELEASE SAVEPOINT prohibited_sql");
        }
      };
      const verified = makeModelBPostgresFixture("modelb-guarded-write-001");
      const store = new GuardedPostgresModelBPaymentStore(client, schema);
      await setRole("av_model_b_reader");
      await denied(
        "INSERT INTO agentvault_model_b_payment_requests(request_id) VALUES('forbidden888')"
      );
      await denied(
        "UPDATE agentvault_model_b_payment_requests SET phase='PREPARED'"
      );
      await denied(
        "SELECT * FROM agentvault_model_b_claim_guarded($1,$2,$3,$4,$5,$6)",
        [
          verified.claim.requestId,
          verified.claim.genesisHash,
          verified.claim.programId,
          verified.claim.vault,
          verified.claim.workflowDigest,
          verified.claim.paymentDigest,
        ]
      );

      await setRole("av_model_b_coordinator");
      await denied(
        "INSERT INTO agentvault_model_b_payment_requests(request_id) VALUES('forbidden777')"
      );
      assert.equal((await store.claim(verified.claim)).phase, "CLAIMED");
      await denied(
        "UPDATE agentvault_model_b_payment_requests SET phase='PREPARED' WHERE request_id=$1",
        [verified.claim.requestId]
      );
      assert.equal(
        (await store.persistSignedPayment(verified.payment)).phase,
        "PREPARED"
      );
      await denied(
        "UPDATE agentvault_model_b_payment_requests SET phase='SUBMISSION_RESERVED' WHERE request_id=$1",
        [verified.claim.requestId]
      );
      const reserved = await store.reserveOneSubmission(
        verified.claim.requestId
      );
      assert.equal(reserved.phase, "SUBMISSION_RESERVED");
      await assert.rejects(
        store.reserveOneSubmission(verified.claim.requestId),
        /already transitioned/
      );
      await assert.rejects(
        store.recordChainStatus(
          verified.claim.requestId,
          verified.payment.signature,
          "CONFIRMED"
        ),
        /disabled for guarded PostgreSQL store/
      );
      await denied(
        "UPDATE agentvault_model_b_payment_requests SET phase='CONFIRMED', finalized_slot=100 WHERE request_id=$1",
        [verified.claim.requestId]
      );
      await denied(
        "SELECT * FROM agentvault_model_b_reconcile_guarded($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [
          reserved.requestId,
          reserved.genesisHash,
          reserved.programId,
          reserved.vault,
          reserved.workflowDigest,
          reserved.paymentDigest,
          reserved.signedTransactionSha256,
          reserved.signature,
          reserved.lastValidBlockHeight,
          reserved.signedTransaction,
          "CONFIRMED",
          100,
        ]
      );

      await setRole("av_model_b_finalizer");
      await denied(
        "UPDATE agentvault_model_b_payment_requests SET phase='FAILED' WHERE request_id=$1",
        [verified.claim.requestId]
      );
      await denied("SELECT * FROM agentvault_model_b_reserve_guarded($1)", [
        verified.claim.requestId,
      ]);
      const finalized = await store.applyInspectedStatus(reserved, {
        status: "CONFIRMED",
        requestId: verified.claim.requestId,
        signature: verified.payment.signature,
        finalizedSlot: 100,
      });
      assert.equal(finalized?.phase, "CONFIRMED");
      assert.equal(finalized?.finalizedSlot, 100);
      assert.equal(
        await store.applyInspectedStatus(reserved, {
          status: "CONFIRMED",
          requestId: verified.claim.requestId,
          signature: verified.payment.signature,
          finalizedSlot: 100,
        }),
        null
      );
      assert.equal(
        (await store.getForReconciliation(verified.claim.requestId))?.phase,
        "CONFIRMED"
      );
      // PostgreSQL resolves unqualified relation names to pg_temp first.
      // A read-only runtime role may spoof reads using a local TEMP table.
      await setRole("av_model_b_reader");
      const tempPrivilege = await client.query<{ allowed: boolean }>(
        "SELECT has_database_privilege(current_user, current_database(), 'TEMP') AS allowed"
      );
      if (tempPrivilege.rows[0].allowed) {
        await client.query(`CREATE TEMP TABLE agentvault_model_b_payment_requests AS
          SELECT * FROM "${schema}".agentvault_model_b_payment_requests`);
        await client.query(
          `UPDATE pg_temp.agentvault_model_b_payment_requests
          SET phase = 'FAILED', finalized_slot = 456
          WHERE request_id = $1`,
          [verified.claim.requestId]
        );
        const shadowed = await client.query<{ phase: string }>(
          "SELECT phase FROM agentvault_model_b_payment_requests WHERE request_id = $1",
          [verified.claim.requestId]
        );
        assert.equal(
          shadowed.rows[0].phase,
          "FAILED",
          "Attack setup must shadow bare table reads"
        );
        assert.equal(
          (await store.get(verified.claim.requestId))?.phase,
          "CONFIRMED"
        );
        assert.equal(
          (await store.getForReconciliation(verified.claim.requestId))?.phase,
          "CONFIRMED"
        );
      }

      await client.query("ROLLBACK"); // all test payment rows are discarded
    } finally {
      // A failed assertion may leave the transaction open; never commit it.
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
