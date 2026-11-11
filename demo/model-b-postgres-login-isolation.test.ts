import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

const sql = (name: string) => readFileSync(resolve("sql", name), "utf8");
const provisioning = sql("20261111_model_b_test_login_provisioning.sql");
const requiredRoles = ["reader", "coordinator", "finalizer"] as const;
type Role = (typeof requiredRoles)[number];
const probeUrls = {
  reader: "AGENTVAULT_MODEL_B_TEST_READER_URL",
  coordinator: "AGENTVAULT_MODEL_B_TEST_COORDINATOR_URL",
  finalizer: "AGENTVAULT_MODEL_B_TEST_FINALIZER_URL",
} as const;
const runtimeUrls = {
  reader: "AGENTVAULT_MODEL_B_READER_DATABASE_URL",
  coordinator: "AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL",
  finalizer: "AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL",
} as const;
const expectedLogins = {
  reader: "av76d6_reader_test",
  coordinator: "av76d6_coordinator_test",
  finalizer: "av76d6_finalizer_test",
} as const;

function assertLocalTestUrl(raw: string, expectedName?: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid local test database URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/agentvault_test[a-zA-Z0-9_]*$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    !url.password ||
    (expectedName !== undefined &&
      decodeURIComponent(url.username) !== expectedName)
  ) {
    throw new Error(
      "REFUSE: isolated login test requires a dedicated local agentvault_test* URL and expected login"
    );
  }
  return url;
}

test("test-login bootstrap is DBA-only and restricted to a dedicated local test database", () => {
  assert.match(provisioning, /agentvault_test\[a-zA-Z0-9_\]\*/);
  assert.match(provisioning, /requires a DBA superuser/);
  assert.match(provisioning, /REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC/);
  assert.match(provisioning, /PASSWORD NULL/);
  assert.doesNotMatch(provisioning, /PASSWORD\s+'[^']+'/i);
  assert.doesNotMatch(provisioning, /ALTER\s+ROLE\s+\S+\s+PASSWORD/i);
});

test("bootstrap creates three separate nonprivileged LOGIN roles with one capability each", () => {
  for (const [login, capability] of [
    ["av76d6_reader_test", "av_model_b_reader"],
    ["av76d6_coordinator_test", "av_model_b_coordinator"],
    ["av76d6_finalizer_test", "av_model_b_finalizer"],
  ]) {
    assert.ok(provisioning.includes(login));
    assert.ok(provisioning.includes(capability));
  }
  assert.match(
    provisioning,
    /LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/
  );
  assert.match(provisioning, /GRANT %I TO %I/);
  assert.match(provisioning, /test login already exists/);
});

test("isolated login probes cannot run with shared test-owner or sibling service URLs", () => {
  const worker = readFileSync(
    resolve("demo/model-b-postgres-login-probe-worker.ts"),
    "utf8"
  );
  assert.match(worker, /AGENTVAULT_TEST_DATABASE_URL/);
  assert.match(worker, /Sibling credential leaked into subprocess/);
  assert.match(worker, /SET ROLE/);
  assert.match(worker, /UPDATE/);
  assert.doesNotMatch(
    worker,
    /(?:sendRawTransaction|sendTransaction|signTransaction|reserveOneSubmission)\s*\(/
  );
});

/**
 * Genuine process isolation test. The owner connection creates a disposable
 * private schema; each subprocess receives ONLY its own login URL and tests
 * actual PostgreSQL grants, verified preflight, direct-DML denial and
 * cross-service SET ROLE denial. No broadcasting or Solana RPC.
 */
test("real PostgreSQL: three independent LOGIN processes cannot mutate or impersonate one another", async (t) => {
  const rootUrl = process.env.AGENTVAULT_TEST_DATABASE_URL;
  const provided = requiredRoles.filter((r) =>
    Boolean(process.env[probeUrls[r]])
  );
  if (!rootUrl && provided.length === 0) {
    t.skip(
      "Configure AGENTVAULT_TEST_DATABASE_URL and all three AGENTVAULT_MODEL_B_TEST_*_URL variables"
    );
    return;
  }
  if (!rootUrl)
    throw new Error("Missing AGENTVAULT_TEST_DATABASE_URL for real role test");
  if (provided.length === 0) {
    t.skip(
      "Run local DBA provisioning and configure all three AGENTVAULT_MODEL_B_TEST_*_URL variables"
    );
    return;
  }
  if (provided.length !== 3)
    throw new Error("REFUSE: incomplete isolated role test URLs");
  const root = assertLocalTestUrl(rootUrl);
  const logins = {} as Record<Role, string>;
  for (const role of requiredRoles) {
    const raw = process.env[probeUrls[role]];
    if (!raw) throw new Error(`Missing ${probeUrls[role]}`);
    const parsed = assertLocalTestUrl(raw, expectedLogins[role]);
    if (parsed.pathname !== root.pathname)
      throw new Error("REFUSE: role URL points to a different test database");
    logins[role] = raw;
  }

  const schema = `av76d6_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: rootUrl, max: 1 });
  let migration: Pool | undefined;
  let created = false;
  try {
    const prior = await admin.query<{ login: string; can_create: boolean }>(
      "SELECT current_user::text AS login, has_database_privilege(current_user, current_database(), 'CREATE') AS can_create"
    );
    assert.equal(
      prior.rows[0]?.can_create,
      true,
      "Test-owner login cannot create disposable schemas"
    );
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    migration = new Pool({
      connectionString: rootUrl,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    for (const name of [
      "20261110_model_b_payment_requests.sql",
      "20261110_model_b_payment_finality.sql",
      "20261111_model_b_runtime_roles.sql",
      "20261111_model_b_guarded_writes.sql",
    ]) {
      await migration.query(sql(name));
    }
    await migration.query(sql("20261111_model_b_privilege_audit.sql"));

    for (const role of requiredRoles) {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AGENTVAULT_MODEL_B_PRIVATE_SCHEMA: schema,
        AGENTVAULT_MODEL_B_LOGIN_PROBE_ROLE: role,
        [runtimeUrls[role]]: logins[role],
      };
      const result = spawnSync(
        "pnpm",
        ["exec", "tsx", "demo/model-b-postgres-login-probe-worker.ts"],
        {
          cwd: process.cwd(),
          env,
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 512 * 1024,
        }
      );
      assert.equal(
        result.error,
        undefined,
        `${role} login child could not launch`
      );
      assert.equal(
        result.status,
        0,
        `${role} login child failed security probe (details withheld)`
      );
      assert.match(result.stdout, new RegExp(`MODEL_B_LOGIN_PROBE_OK:${role}`));
      assert.doesNotMatch(
        result.stdout,
        /postgresql?:\/\//,
        "Credential appeared in child output"
      );
    }
  } finally {
    if (migration) await migration.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
