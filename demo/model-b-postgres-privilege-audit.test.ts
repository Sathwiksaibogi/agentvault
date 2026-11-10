import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { PoolClient } from "pg";

const sql = (name: string) => readFileSync(resolve("sql", name), "utf8");
const auditSql = sql("20261111_model_b_privilege_audit.sql");

const claimFunction =
  "agentvault_model_b_claim_guarded(text,text,text,text,text,text)";

// Static validation runs without a database, but cannot replace PostgreSQL tests.
test("privilege audit checks function owners, PUBLIC grants, cross-role membership and guard trigger", () => {
  assert.match(auditSql, /READ-ONLY, fail-closed PostgreSQL privilege audit/);
  assert.match(auditSql, /p\.proowner = table_owner/);
  assert.match(auditSql, /fn_owner <> table_owner/);
  assert.match(auditSql, /fn_is_definer IS DISTINCT FROM TRUE/);
  assert.match(auditSql, /search_path=pg_catalog/);
  assert.match(auditSql, /a\.grantee NOT IN/);
  assert.match(auditSql, /a\.grantee = 0/);
  assert.match(auditSql, /unexpected SECURITY DEFINER function/);
  assert.match(auditSql, /role_name, other_role/);
  assert.match(auditSql, /direct column write privilege/);
  assert.doesNotMatch(
    auditSql,
    /\b(?:GRANT|REVOKE|CREATE|ALTER|DROP)\s+(?:ROLE|TABLE|FUNCTION|SCHEMA|ON)\b/i
  );
});

/**
 * Audit hostile schema changes only inside a disposable localhost test schema.
 * The local test owner has SET ROLE permissions for all three NOLOGIN roles;
 * this does NOT prove production service logins are independently isolated.
 */
test("real PostgreSQL: audit detects privilege escalation, and forged SQL finality remains an explicit blocker", async (t) => {
  const connectionString = process.env.AGENTVAULT_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip(
      "Set AGENTVAULT_TEST_DATABASE_URL for the local agentvault_test* database"
    );
    return;
  }
  const url = new URL(connectionString);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/agentvault_test[a-zA-Z0-9_]*$/.test(url.pathname)
  ) {
    throw new Error(
      "REFUSE: security audit requires a local agentvault_test* database"
    );
  }

  const { Pool } = await import("pg");
  const schema = `av76c10_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  let pool: InstanceType<typeof Pool> | undefined;
  let created = false;
  try {
    const setup = await admin.query<{
      reader: boolean;
      coordinator: boolean;
      finalizer: boolean;
    }>(`
      SELECT to_regrole('av_model_b_reader') IS NOT NULL
               AND pg_has_role(current_user, 'av_model_b_reader', 'SET') AS reader,
             to_regrole('av_model_b_coordinator') IS NOT NULL
               AND pg_has_role(current_user, 'av_model_b_coordinator', 'SET') AS coordinator,
             to_regrole('av_model_b_finalizer') IS NOT NULL
               AND pg_has_role(current_user, 'av_model_b_finalizer', 'SET') AS finalizer
    `);
    assert.deepEqual(
      setup.rows[0],
      {
        reader: true,
        coordinator: true,
        finalizer: true,
      },
      "Local test roles or SET ROLE grants are missing"
    );
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({
      connectionString,
      max: 2,
      options: `-c search_path=${schema}`,
    });
    for (const migration of [
      "20261110_model_b_payment_requests.sql",
      "20261110_model_b_payment_finality.sql",
      "20261111_model_b_runtime_roles.sql",
      "20261111_model_b_guarded_writes.sql",
    ]) {
      await pool.query(sql(migration));
    }
    await pool.query(auditSql);

    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      const claim = `"${schema}".${claimFunction}`;
      const cases: { name: string; mutation: string; error: RegExp }[] = [
        {
          name: "PUBLIC may execute coordinator function",
          mutation: `GRANT EXECUTE ON FUNCTION ${claim} TO PUBLIC`,
          error: /function EXECUTE granted to PUBLIC/,
        },
        {
          name: "reader may execute coordinator function",
          mutation: `GRANT EXECUTE ON FUNCTION ${claim} TO av_model_b_reader`,
          error: /function EXECUTE granted to PUBLIC\/other role/,
        },
        {
          name: "SECURITY DEFINER removed",
          mutation: `ALTER FUNCTION ${claim} SECURITY INVOKER`,
          error: /unsafe owner, language or execution context/,
        },
        {
          name: "function search_path changed",
          mutation: `ALTER FUNCTION ${claim} SET search_path = public`,
          error: /unsafe owner, language or execution context/,
        },
        {
          name: "mutation trigger disabled",
          mutation: `ALTER TABLE "${schema}".agentvault_model_b_payment_requests
            DISABLE TRIGGER agentvault_model_b_mutation_guard`,
          error: /mutation trigger or its owner is untrusted/,
        },
        {
          name: "direct column write permission restored",
          mutation: `GRANT UPDATE (phase) ON TABLE "${schema}".agentvault_model_b_payment_requests
            TO av_model_b_coordinator`,
          error: /direct column write privilege/,
        },
        {
          name: "schema CREATE granted to reader",
          mutation: `GRANT CREATE ON SCHEMA "${schema}" TO av_model_b_reader`,
          error: /object creation privilege/,
        },
        {
          name: "unexpected SECURITY DEFINER routine",
          mutation: `CREATE FUNCTION "${schema}".agentvault_unreviewed_definer()
            RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
          error: /unexpected SECURITY DEFINER function/,
        },
      ];
      for (const probe of cases) {
        await client.query("SAVEPOINT isolated_attack");
        try {
          await client.query(probe.mutation);
          await assert.rejects(client.query(auditSql), (error: unknown) => {
            assert.equal(
              (error as { code?: string }).code,
              "P0001",
              probe.name
            );
            assert.match((error as Error).message, probe.error, probe.name);
            return true;
          });
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT isolated_attack");
          await client.query("RELEASE SAVEPOINT isolated_attack");
        }
        await client.query(auditSql); // prove the audit succeeds again after rollback
      }

      // Demonstrate the RESIDUAL threat: SQL accepts coordinator-supplied bytes
      // without Ed25519 verification, then accepts a finalizer's reported slot.
      // This is not a successful authorization test; it is a known release
      // blocker until services and credentials are separately trusted.
      const requestId = "modelb-audit-forged-001";
      const genesis = "11111111111111111111111111111111";
      const bogusBytes = Buffer.from([1, 2, 3, 4]);
      const fakeSignature = "NotARealSolanaSignature";
      const workflowDigest = "a".repeat(64);
      const paymentDigest = "b".repeat(64);
      const txDigest = "c".repeat(64);
      const identity = [
        requestId,
        genesis,
        genesis,
        genesis,
        workflowDigest,
        paymentDigest,
      ];
      await client.query("SET LOCAL ROLE av_model_b_coordinator");
      const forgedClaim = await client.query(
        `SELECT phase FROM "${schema}".agentvault_model_b_claim_guarded($1,$2,$3,$4,$5,$6)`,
        identity
      );
      assert.equal(forgedClaim.rows[0]?.phase, "CLAIMED");
      const forgedPreparation = await client.query(
        `SELECT phase FROM "${schema}".agentvault_model_b_prepare_guarded(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          requestId,
          bogusBytes,
          txDigest,
          fakeSignature,
          1,
          ...identity.slice(1),
        ]
      );
      assert.equal(forgedPreparation.rows[0]?.phase, "PREPARED");
      const forgedReservation = await client.query(
        `SELECT phase FROM "${schema}".agentvault_model_b_reserve_guarded($1)`,
        [requestId]
      );
      assert.equal(forgedReservation.rows[0]?.phase, "SUBMISSION_RESERVED");
      await client.query("SET LOCAL ROLE av_model_b_finalizer");
      const forgedFinality = await client.query(
        `SELECT phase, finalized_slot FROM "${schema}".agentvault_model_b_reconcile_guarded(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          ...identity,
          txDigest,
          fakeSignature,
          1,
          bogusBytes,
          "CONFIRMED",
          424242,
        ]
      );
      assert.equal(forgedFinality.rows[0]?.phase, "CONFIRMED");
      assert.equal(Number(forgedFinality.rows[0]?.finalized_slot), 424242);
      // Switching roles is possible ONLY because this local test's original
      // session login has SET ROLE membership in both roles. Never deploy it.
      await client.query("ROLLBACK"); // no bogus data survives
    } finally {
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
