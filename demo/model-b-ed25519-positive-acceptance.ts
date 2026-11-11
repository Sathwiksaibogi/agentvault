/** 7.6D.12C strict PostgreSQL Ed25519 acceptance runner; no extension installation. */
import { spawnSync } from "node:child_process";
import { Pool } from "pg";

function assertLocalTestUrl(
  raw: string | undefined,
  expectedUser?: string
): string {
  if (!raw)
    throw new Error("REFUSE: missing isolated AgentVault test database URL");
  const url = new URL(raw);
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
      "REFUSE: only local, isolated AgentVault test DB roles are supported"
    );
  }
  return raw;
}

async function main(): Promise<void> {
  const strict = process.argv.slice(2).includes("--positive");
  if (process.argv.slice(2).some((arg) => arg !== "--positive")) {
    throw new Error(
      "Usage: pnpm exec tsx demo/model-b-ed25519-positive-acceptance.ts [--positive]"
    );
  }
  const ownerUrl = assertLocalTestUrl(process.env.AGENTVAULT_TEST_DATABASE_URL);
  const finalizerUrl = process.env.AGENTVAULT_MODEL_B_TEST_FINALIZER_URL;
  if (strict) {
    assertLocalTestUrl(finalizerUrl, "av76d6_finalizer_test");
    if (new URL(ownerUrl).pathname !== new URL(finalizerUrl!).pathname) {
      throw new Error(
        "REFUSE: owner and finalizer roles must access the same test database"
      );
    }
  }
  const pool = new Pool({
    connectionString: ownerUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  let ready = false;
  try {
    const database = await pool.query<{
      database_name: string;
      pg_version: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS pg_version"
    );
    const available = await pool.query(
      "SELECT default_version FROM pg_catalog.pg_available_extensions WHERE name='pgsodium'"
    );
    const verifier = await pool.query<{
      extension_version: string;
      schema_name: string;
      extension_owned: boolean;
      accessible: boolean;
    }>(`
      SELECT e.extversion AS extension_version,
             n.nspname AS schema_name,
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_proc p
               JOIN pg_catalog.pg_depend d
                 ON d.classid='pg_catalog.pg_proc'::pg_catalog.regclass
                AND d.objid=p.oid
                AND d.refclassid='pg_catalog.pg_extension'::pg_catalog.regclass
                AND d.refobjid=e.oid AND d.deptype='e'
               WHERE p.oid=pg_catalog.to_regprocedure(
                 pg_catalog.format('%I.crypto_sign_verify_detached(bytea,bytea,bytea)',n.nspname))
                 AND p.prorettype='boolean'::pg_catalog.regtype
             ) AS extension_owned,
             COALESCE(
               pg_catalog.has_function_privilege(current_user,
                 pg_catalog.to_regprocedure(
                   pg_catalog.format('%I.crypto_sign_verify_detached(bytea,bytea,bytea)',n.nspname)
                 ),'EXECUTE')
               AND pg_catalog.has_schema_privilege(current_user,n.nspname,'USAGE'),
               FALSE
             ) AS accessible
        FROM pg_catalog.pg_extension e
        JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
       WHERE e.extname='pgsodium'
    `);
    const current = verifier.rows[0];
    console.log(
      `Test database: ${database.rows[0]?.database_name ?? "unknown"}`
    );
    console.log(
      `PostgreSQL version: ${database.rows[0]?.pg_version ?? "unknown"}`
    );
    console.log(
      `pgsodium on server: ${
        available.rows.length ? "available" : "not available"
      }`
    );
    console.log(
      `pgsodium installed: ${
        current ? `yes (${current.extension_version})` : "no"
      }`
    );
    console.log(
      `Extension-owned detached verifier: ${
        current?.extension_owned ? "yes" : "no"
      }`
    );
    console.log(
      `Verifier accessible to DB owner: ${current?.accessible ? "yes" : "no"}`
    );
    ready = !!current?.extension_owned && !!current?.accessible;
  } finally {
    await pool.end();
  }
  if (!ready) {
    console.log(
      "POSITIVE ED25519 ACCEPTANCE: NOT VERIFIED — prerequisites missing"
    );
    if (strict) {
      throw new Error(
        "POSITIVE ACCEPTANCE BLOCKED: vetted extension-owned verifier unavailable"
      );
    }
    return;
  }
  if (!strict) {
    console.log(
      "POSITIVE ED25519 ACCEPTANCE: prerequisites found; run with --positive for actual integration"
    );
    return;
  }
  console.log(
    "Executing existing real PostgreSQL Ed25519 integration test with extension preflight satisfied..."
  );
  const child = spawnSync(
    "pnpm",
    ["exec", "tsx", "--test", "demo/model-b-postgres-ed25519-gate.test.ts"],
    { cwd: process.cwd(), env: process.env, stdio: "inherit", timeout: 120_000 }
  );
  if (child.error || child.status !== 0) {
    throw (
      child.error ??
      new Error(`POSITIVE ACCEPTANCE FAILED: test exit status ${child.status}`)
    );
  }
  console.log(
    "POSITIVE ACCEPTANCE TEST PASSED: verifier was present, so the real DB signature branch was exercised"
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Positive acceptance failed"
  );
  process.exitCode = 1;
});
