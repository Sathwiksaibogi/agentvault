/**
 * 7.6D.8: prove SQL—not a cooperative finalizer—rejects forged terminal states.
 * All mutations are restricted to disposable local agentvault_test* schemas.
 * The SQL quarantine is an intentional safety stop, NOT finality verification.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

const sql = (name: string): string =>
  readFileSync(resolve("sql", name), "utf8");
const quarantine = sql("20261111_model_b_finality_quarantine.sql");
const audit = sql("20261111_model_b_privilege_audit.sql");

function localTestUrl(raw: string, expectedUser?: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("REFUSE: invalid local test PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/agentvault_test[a-zA-Z0-9_]*$/.test(url.pathname) ||
    !url.password ||
    url.search ||
    url.hash ||
    (expectedUser !== undefined &&
      decodeURIComponent(url.username) !== expectedUser)
  ) {
    throw new Error(
      "REFUSE: quarantine tests require the designated local test database and login"
    );
  }
  return url;
}

test("quarantine is explicitly test-only, owner-gated and rejects historic terminal rows", () => {
  assert.match(quarantine, /current_database\(\) !~ '\^agentvault_test/);
  assert.match(quarantine, /CURRENT_USER::pg_catalog.regrole::oid/);
  assert.match(quarantine, /terminal rows require independent review/);
  assert.match(quarantine, /unexpected guarded finalizer implementation/);
  assert.match(quarantine, /BEGIN;[\s\S]*COMMIT;/);
  assert.doesNotMatch(quarantine, /\b(?:DROP|TRUNCATE|DELETE FROM)\b/i);
});

test("SQL quarantines terminal writes without removing unresolved observations or relaxing ACLs", () => {
  assert.match(
    quarantine,
    /CREATE OR REPLACE FUNCTION[\s\S]*agentvault_model_b_reconcile_guarded/
  );
  assert.match(
    quarantine,
    /LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog/
  );
  assert.match(quarantine, /SET phase = 'UNRESOLVED'/);
  assert.match(quarantine, /AND phase = 'SUBMISSION_RESERVED'/);
  assert.match(quarantine, /AND \$11 = 'UNRESOLVED' AND \$12 IS NULL/);
  assert.doesNotMatch(
    quarantine,
    /\bGRANT\s+(?:EXECUTE|UPDATE|INSERT|ALL)\s+ON\b/i
  );
  assert.doesNotMatch(
    quarantine,
    /\b(?:sendRawTransaction|signTransaction)\s*\(/
  );
});

test("quarantine documentation retains the unresolved trust boundary and stop condition", () => {
  const document = readFileSync(
    resolve("docs/security/model-b-postgres-finality-quarantine.md"),
    "utf8"
  );
  assert.match(
    document,
    /no independently authenticated on-chain finality proof/i
  );
  assert.match(document, /CONFIRMED/);
  assert.match(document, /FAILED/);
  assert.match(document, /UNRESOLVED/);
  assert.match(document, /not production-ready/i);
});

test("real PostgreSQL: stolen finalizer login cannot forge terminal state after SQL quarantine", async (t) => {
  const rootUrl = process.env.AGENTVAULT_TEST_DATABASE_URL;
  const finalizerUrl = process.env.AGENTVAULT_MODEL_B_TEST_FINALIZER_URL;
  if (!rootUrl && !finalizerUrl) {
    t.skip(
      "Configure the owner and isolated finalizer URLs for the dedicated local test database"
    );
    return;
  }
  if (!rootUrl || !finalizerUrl) {
    throw new Error(
      "REFUSE: both the owner and isolated finalizer test URLs are required"
    );
  }
  const root = localTestUrl(rootUrl);
  const finalizer = localTestUrl(finalizerUrl, "av76d6_finalizer_test");
  assert.equal(
    finalizer.pathname,
    root.pathname,
    "Finalizer must use the same disposable test DB"
  );

  const schema = `av76d8_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: rootUrl, max: 1 });
  let owner: Pool | undefined;
  let service: Pool | undefined;
  let created = false;
  try {
    const permission = await admin.query<{ can_create: boolean }>(
      "SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create"
    );
    assert.equal(permission.rows[0]?.can_create, true);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    owner = new Pool({
      connectionString: rootUrl,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    service = new Pool({
      connectionString: finalizerUrl,
      max: 1,
      options: `-c search_path=${schema}`,
    });

    for (const migration of [
      "20261110_model_b_payment_requests.sql",
      "20261110_model_b_payment_finality.sql",
      "20261111_model_b_runtime_roles.sql",
      "20261111_model_b_guarded_writes.sql",
    ]) {
      await owner.query(sql(migration));
    }
    await owner.query(audit);
    const current = await service.query<{ user: string }>(
      "SELECT current_user::text AS user"
    );
    assert.equal(current.rows[0]?.user, "av76d6_finalizer_test");

    // The original SQL trusted an arbitrary finalizer slot. Demonstrate that
    // vulnerability inside a transaction that is ALWAYS rolled back.
    const claim = [
      "modelb-quarantine-001",
      "11111111111111111111111111111111",
      "11111111111111111111111111111111",
      "11111111111111111111111111111111",
      "a".repeat(64),
      "b".repeat(64),
    ];
    const forged = Buffer.from([1, 2, 3, 4]);
    const other = [
      claim[0],
      forged,
      "c".repeat(64),
      "NotARealSolanaSignature",
      9999,
      ...claim.slice(1),
    ];
    const finalityParams = [
      ...claim,
      "c".repeat(64),
      "NotARealSolanaSignature",
      9999,
      forged,
    ];
    const claimFn = `"${schema}".agentvault_model_b_claim_guarded($1,$2,$3,$4,$5,$6)`;
    const prepareFn = `"${schema}".agentvault_model_b_prepare_guarded($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
    const reserveFn = `"${schema}".agentvault_model_b_reserve_guarded($1)`;
    const reconcileFn = `"${schema}".agentvault_model_b_reconcile_guarded($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;

    assert.equal(
      (await owner.query(`SELECT phase FROM ${claimFn}`, claim)).rows[0]?.phase,
      "CLAIMED"
    );
    assert.equal(
      (await owner.query(`SELECT phase FROM ${prepareFn}`, other)).rows[0]
        ?.phase,
      "PREPARED"
    );
    assert.equal(
      (await owner.query(`SELECT phase FROM ${reserveFn}`, [claim[0]])).rows[0]
        ?.phase,
      "SUBMISSION_RESERVED"
    );

    const client = await service.connect();
    try {
      await client.query("BEGIN");
      const fake = await client.query(`SELECT phase FROM ${reconcileFn}`, [
        ...finalityParams,
        "CONFIRMED",
        424242,
      ]);
      assert.equal(
        fake.rows[0]?.phase,
        "CONFIRMED",
        "Baseline confirms the untrusted finalizer issue"
      );
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }

    await owner.query(quarantine);
    await owner.query(audit); // Existing owner, ACL, SQL language and search_path remain intact.

    const confirmed = await service.query(`SELECT phase FROM ${reconcileFn}`, [
      ...finalityParams,
      "CONFIRMED",
      424242,
    ]);
    const failed = await service.query(`SELECT phase FROM ${reconcileFn}`, [
      ...finalityParams,
      "FAILED",
      424242,
    ]);
    assert.equal(confirmed.rowCount, 0);
    assert.equal(failed.rowCount, 0);

    const unchanged = await owner.query<{
      phase: string;
      finalized_slot: string | null;
    }>(
      `SELECT phase, finalized_slot FROM "${schema}".agentvault_model_b_payment_requests WHERE request_id=$1`,
      [claim[0]]
    );
    assert.equal(unchanged.rows[0]?.phase, "SUBMISSION_RESERVED");
    assert.equal(unchanged.rows[0]?.finalized_slot, null);

    await assert.rejects(
      service.query(
        `UPDATE "${schema}".agentvault_model_b_payment_requests SET phase='CONFIRMED' WHERE request_id=$1`,
        [claim[0]]
      ),
      (error: unknown) => (error as { code?: string }).code === "42501"
    );

    const unresolved = await service.query(
      `SELECT phase, finalized_slot FROM ${reconcileFn}`,
      [...finalityParams, "UNRESOLVED", null]
    );
    assert.equal(unresolved.rows[0]?.phase, "UNRESOLVED");
    assert.equal(unresolved.rows[0]?.finalized_slot, null);
    assert.equal(
      (
        await service.query(`SELECT phase FROM ${reconcileFn}`, [
          ...finalityParams,
          "CONFIRMED",
          424242,
        ])
      ).rowCount,
      0,
      "An unresolved payment must never be terminally forged"
    );
  } finally {
    if (service) await service.end();
    if (owner) await owner.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
