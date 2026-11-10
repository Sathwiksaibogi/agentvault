import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  parseModelBRoleDatabaseConfiguration,
  verifyModelBRoleDatabase,
} from "./model-b-postgres-runtime-databases";

const roles = ["reader", "coordinator", "finalizer"] as const;
const vars = {
  reader: "AGENTVAULT_MODEL_B_READER_DATABASE_URL",
  coordinator: "AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL",
  finalizer: "AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL",
} as const;
const urls = {
  reader: "postgresql://av_read:reader-secret@127.0.0.1:5432/agentvault",
  coordinator:
    "postgresql://av_coord:coordinator-secret@127.0.0.1:5432/agentvault",
  finalizer: "postgresql://av_final:finalizer-secret@127.0.0.1:5432/agentvault",
} as const;
function envFor(role: (typeof roles)[number]): NodeJS.ProcessEnv {
  return {
    AGENTVAULT_MODEL_B_PRIVATE_SCHEMA: "agentvault_payments",
    [vars[role]]: urls[role],
  };
}

test("Model B runtime requires a dedicated URL for each requested service", () => {
  for (const role of roles) {
    assert.throws(
      () =>
        parseModelBRoleDatabaseConfiguration(role, {
          AGENTVAULT_MODEL_B_PRIVATE_SCHEMA: "agentvault_payments",
        }),
      /Missing AGENTVAULT_MODEL_B_/
    );
  }
});

test("Model B runtime refuses unsafe or missing private schemas", () => {
  for (const schema of [
    undefined,
    "",
    "public",
    "pg_temp_123",
    "MixedCase",
    "a",
    "a;drop schema",
  ]) {
    assert.throws(
      () =>
        parseModelBRoleDatabaseConfiguration("reader", {
          ...envFor("reader"),
          AGENTVAULT_MODEL_B_PRIVATE_SCHEMA: schema,
        }),
      /explicit safe private schema/
    );
  }
});

test("Model B service process refuses another service's database credentials", () => {
  for (const role of roles) {
    for (const other of roles) {
      if (role === other) continue;
      assert.throws(
        () =>
          parseModelBRoleDatabaseConfiguration(role, {
            ...envFor(role),
            [vars[other]]: urls[other],
          }),
        /another role's credentials/
      );
    }
  }
});

test("Model B runtime rejects role-injection URL options and malformed credentials", () => {
  for (const url of [
    "https://av_read:reader-secret@127.0.0.1:5432/agentvault",
    "postgresql://av_read:reader-secret@127.0.0.1:5432/agentvault?options=-c%20role%3Dav_model_b_finalizer",
    "postgresql://av_read:reader-secret@127.0.0.1:5432/agentvault?role=av_model_b_finalizer",
    "postgresql://av_read:@127.0.0.1:5432/agentvault",
    "postgresql://av_model_b_reader:reader-secret@127.0.0.1:5432/agentvault",
  ]) {
    assert.throws(
      () =>
        parseModelBRoleDatabaseConfiguration("reader", {
          ...envFor("reader"),
          AGENTVAULT_MODEL_B_READER_DATABASE_URL: url,
        }),
      /PostgreSQL/
    );
  }
});

test("Model B runtime parses an isolated role without accessing sibling credentials", () => {
  for (const role of roles) {
    const config = parseModelBRoleDatabaseConfiguration(role, envFor(role));
    assert.equal(config.role, role);
    assert.equal(config.privateSchema, "agentvault_payments");
    assert.equal(config.loginName, new URL(urls[role]).username);
    assert.equal(config.connectionString, urls[role]);
  }
});

type TestRow = {
  session_login: string;
  effective_login: string;
  safe_login: boolean;
  schema_isolated: boolean;
  role_isolated: boolean;
  object_creation_denied: boolean;
  table_is_read_only: boolean;
  function_scope_correct: boolean;
  functions_present: boolean;
};
const ready: TestRow = {
  session_login: "av_coord",
  effective_login: "av_coord",
  safe_login: true,
  schema_isolated: true,
  role_isolated: true,
  object_creation_denied: true,
  table_is_read_only: true,
  function_scope_correct: true,
  functions_present: true,
};

test("preflight checks database identity, cross-role membership, and guarded grants", async () => {
  let checked = false;
  const fake = {
    async query(sql: string, params: unknown[]) {
      assert.deepEqual(params, [
        "agentvault_payments",
        "av_model_b_coordinator",
      ]);
      assert.match(sql, /session_user::text AS session_login/);
      assert.match(sql, /current_user::text AS effective_login/);
      assert.match(sql, /pg_has_role\(session_user, \$2::name, 'USAGE'\)/);
      assert.match(
        sql,
        /has_database_privilege\(session_user, pg_catalog\.current_database\(\), 'TEMP'\)/
      );
      assert.match(sql, /has_column_privilege/);
      for (const fn of [
        "claim_guarded",
        "prepare_guarded",
        "reserve_guarded",
        "reconcile_guarded",
      ]) {
        assert.ok(sql.includes(fn), `missing privilege gate for ${fn}`);
      }
      checked = true;
      return { rows: [ready] };
    },
  };
  await verifyModelBRoleDatabase(
    fake as never,
    "coordinator",
    "agentvault_payments",
    "av_coord"
  );
  assert.equal(checked, true);
});

test("preflight refuses wrong login, role switching or any unsafe effective grant", async () => {
  for (const [name, value] of [
    ["session_login", "another_user"],
    ["effective_login", "another_user"],
    ["safe_login", false],
    ["schema_isolated", false],
    ["role_isolated", false],
    ["object_creation_denied", false],
    ["table_is_read_only", false],
    ["function_scope_correct", false],
    ["functions_present", false],
  ] as const) {
    await assert.rejects(
      verifyModelBRoleDatabase(
        {
          async query() {
            return { rows: [{ ...ready, [name]: value }] };
          },
        } as never,
        "coordinator",
        "agentvault_payments",
        "av_coord"
      ),
      /privileges are not isolated/,
      `should reject ${name}`
    );
  }
});

test("preflight rejects missing or duplicate rows and invalid configurations", async () => {
  for (const rows of [[], [ready, ready]]) {
    await assert.rejects(
      verifyModelBRoleDatabase(
        {
          async query() {
            return { rows };
          },
        } as never,
        "coordinator",
        "agentvault_payments",
        "av_coord"
      ),
      /privileges are not isolated/
    );
  }
  await assert.rejects(
    verifyModelBRoleDatabase(
      {
        async query() {
          throw Error("unreachable");
        },
      } as never,
      "coordinator",
      "public",
      "av_coord"
    ),
    /Invalid Model B role preflight configuration/
  );
  await assert.rejects(
    verifyModelBRoleDatabase(
      {
        async query() {
          throw Error("unreachable");
        },
      } as never,
      "wrong-role" as never,
      "agentvault_payments",
      "av_coord"
    ),
    /Invalid Model B role preflight configuration/
  );
});

test("real PostgreSQL: all-roles test owner cannot impersonate a runtime login", async (t) => {
  const connectionString = process.env.AGENTVAULT_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip(
      "Set AGENTVAULT_TEST_DATABASE_URL for local privilege preflight regression"
    );
    return;
  }
  const url = new URL(connectionString);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/agentvault_test[a-zA-Z0-9_]*$/.test(url.pathname)
  ) {
    throw new Error(
      "REFUSE: isolated runtime test requires local agentvault_test* database"
    );
  }
  const { Pool } = await import("pg");
  const schema = `av76d1_${randomBytes(6).toString("hex")}`;
  const owner = new Pool({ connectionString, max: 1 });
  let migrationPool: InstanceType<typeof Pool> | undefined;
  let created = false;
  try {
    await owner.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    migrationPool = new Pool({
      connectionString,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    for (const name of [
      "20261110_model_b_payment_requests.sql",
      "20261110_model_b_payment_finality.sql",
      "20261111_model_b_runtime_roles.sql",
      "20261111_model_b_guarded_writes.sql",
    ]) {
      await migrationPool.query(readFileSync(resolve("sql", name), "utf8"));
    }
    const loginResult = await owner.query<{ login: string }>(
      "SELECT session_user::text AS login"
    );
    await assert.rejects(
      verifyModelBRoleDatabase(
        owner,
        "coordinator",
        schema,
        loginResult.rows[0].login
      ),
      /privileges are not isolated/
    );
  } finally {
    if (migrationPool) await migrationPool.end();
    if (created) await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
    await owner.end();
  }
});
