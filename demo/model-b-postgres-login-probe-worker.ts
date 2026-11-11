/** 7.6D.6: test-only subprocess. Never imported by a runtime or live CLI. */
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  openModelBReaderDatabase,
  openModelBCoordinatorDatabase,
  openModelBFinalizerDatabase,
} from "./model-b-postgres-runtime-databases";

const urls = {
  reader: "AGENTVAULT_MODEL_B_READER_DATABASE_URL",
  coordinator: "AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL",
  finalizer: "AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL",
} as const;
const capabilities = {
  reader: "av_model_b_reader",
  coordinator: "av_model_b_coordinator",
  finalizer: "av_model_b_finalizer",
} as const;
type Role = keyof typeof urls;

async function main(): Promise<void> {
  const role = process.env.AGENTVAULT_MODEL_B_LOGIN_PROBE_ROLE;
  assert.ok(
    role && Object.prototype.hasOwnProperty.call(urls, role),
    "Invalid login probe role"
  );
  const selected = role as Role;
  const schema = process.env.AGENTVAULT_MODEL_B_PRIVATE_SCHEMA;
  const connectionString = process.env[urls[selected]];
  assert.ok(schema && /^[a-z][a-z0-9_]{2,62}$/.test(schema));
  assert.ok(connectionString, "Missing role-specific test URL");
  for (const other of Object.keys(urls) as Role[]) {
    if (other !== selected) {
      assert.equal(
        process.env[urls[other]],
        undefined,
        "Sibling credential leaked into subprocess"
      );
    }
  }
  assert.equal(
    process.env.AGENTVAULT_TEST_DATABASE_URL,
    undefined,
    "Shared all-roles test owner credential leaked into subprocess"
  );

  const connection =
    selected === "reader"
      ? await openModelBReaderDatabase(process.env)
      : selected === "coordinator"
      ? await openModelBCoordinatorDatabase(process.env)
      : await openModelBFinalizerDatabase(process.env);
  try {
    const expectedMethods =
      selected === "reader"
        ? ["get", "getForReconciliation"]
        : selected === "coordinator"
        ? [
            "claim",
            "get",
            "getForReconciliation",
            "persistSignedPayment",
            "reserveOneSubmission",
          ]
        : ["applyInspectedStatus", "get", "getForReconciliation"];
    assert.deepEqual(
      Object.keys(connection.service).sort(),
      expectedMethods.sort()
    );
    assert.equal(
      await connection.service.get("modelb-login-probe-missing-01"),
      null
    );

    // The facade is narrow. An independent SQL connection proves that the
    // authenticated LOGIN role cannot bypass its facade through direct DML
    // or SET ROLE to another service role.
    const pool = new Pool({ connectionString, max: 1 });
    try {
      const session = await pool.connect();
      try {
        const identity = await session.query<{ login: string; active: string }>(
          "SELECT session_user::text AS login, current_user::text AS active"
        );
        const expectedLogin = new URL(connectionString).username;
        assert.deepEqual(identity.rows[0], {
          login: expectedLogin,
          active: expectedLogin,
        });
        const table = `"${schema}".agentvault_model_b_payment_requests`;
        await assert.rejects(
          session.query(
            `UPDATE ${table} SET phase = phase WHERE request_id = $1`,
            ["modelb-login-probe-missing-01"]
          ),
          /permission denied|must be owner/i
        );
        for (const other of Object.keys(capabilities) as Role[]) {
          if (other === selected) continue;
          await session.query("BEGIN");
          try {
            await assert.rejects(
              session.query(`SET ROLE ${capabilities[other]}`),
              /permission denied/i,
              `Cross-service SET ROLE unexpectedly succeeded: ${selected} -> ${other}`
            );
          } finally {
            await session.query("ROLLBACK");
          }
        }
      } finally {
        session.release();
      }
    } finally {
      await pool.end();
    }
  } finally {
    await connection.close();
  }
  // No connection URLs or credential fragments are printed.
  process.stdout.write(`MODEL_B_LOGIN_PROBE_OK:${selected}\n`);
}

main().catch(() => {
  process.stderr.write(
    "Model B isolated login probe failed (details withheld)\n"
  );
  process.exitCode = 1;
});
