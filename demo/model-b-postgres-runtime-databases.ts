/**
 * 7.6D.1: inactive Model B PostgreSQL connection boundary.
 *
 * This module is NOT imported by the live Model B executor. The three real
 * login identities must be independently provisioned; never use the local
 * all-roles PostgreSQL integration-test login as a runtime credential.
 *
 * Startup verifies the effective privileges of EACH authenticated connection
 * before exposing its deliberately narrow store interface. This does not
 * establish whether a compromised trusted service can lie about approvals
 * or finality: those remain release blockers.
 */
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { GuardedPostgresModelBPaymentStore } from "./model-b-postgres-payment-store";
import type {
  ClaimModelBPayment,
  AuthorizedSignedModelBPayment,
  ModelBPaymentRecord,
} from "./model-b-postgres-payment-store";

type Role = "reader" | "coordinator" | "finalizer";
type Queryable = Pick<Pool | PoolClient, "query">;

const ENV_URLS = {
  reader: "AGENTVAULT_MODEL_B_READER_DATABASE_URL",
  coordinator: "AGENTVAULT_MODEL_B_COORDINATOR_DATABASE_URL",
  finalizer: "AGENTVAULT_MODEL_B_FINALIZER_DATABASE_URL",
} as const;

const DB_ROLES = {
  reader: "av_model_b_reader",
  coordinator: "av_model_b_coordinator",
  finalizer: "av_model_b_finalizer",
} as const;

export type ModelBRoleDatabaseConfiguration = {
  role: Role;
  privateSchema: string;
  connectionString: string;
  loginName: string;
};

function validPrivateSchema(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9_]{2,62}$/.test(value) &&
    value !== "public" &&
    value !== "information_schema" &&
    !value.startsWith("pg_")
  );
}

function parseLogin(raw: string, role: Role): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${role} PostgreSQL connection URL`);
  }
  if (
    !["postgresql:", "postgres:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === "/" ||
    url.hash ||
    Array.from(url.searchParams.keys()).some(
      (key) =>
        ![
          "sslmode",
          "sslcert",
          "sslkey",
          "sslrootcert",
          "channel_binding",
          "application_name",
          "connect_timeout",
        ].includes(key)
    )
  ) {
    throw new Error(`Unsafe ${role} PostgreSQL connection URL`);
  }
  let login: string;
  let password: string;
  try {
    login = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new Error(`Invalid ${role} PostgreSQL credentials`);
  }
  if (
    !/^[a-z_][a-z0-9_]{0,62}$/.test(login) ||
    !password ||
    login === DB_ROLES.reader ||
    login === DB_ROLES.coordinator ||
    login === DB_ROLES.finalizer
  ) {
    throw new Error(`Invalid ${role} PostgreSQL login identity`);
  }
  return login;
}

/**
 * Only one Model B service credential may exist in a process environment.
 * A compromised coordinator process must not be able to read a finalizer URL.
 */
export function parseModelBRoleDatabaseConfiguration(
  role: Role,
  env: NodeJS.ProcessEnv = process.env
): ModelBRoleDatabaseConfiguration {
  if (!Object.prototype.hasOwnProperty.call(DB_ROLES, role)) {
    throw new Error("Invalid Model B database role");
  }
  const schema = env.AGENTVAULT_MODEL_B_PRIVATE_SCHEMA;
  if (!validPrivateSchema(schema)) {
    throw new Error("Model B runtime requires an explicit safe private schema");
  }
  for (const other of ["reader", "coordinator", "finalizer"] as const) {
    if (other !== role && env[ENV_URLS[other]]) {
      throw new Error(
        "Model B service environment contains another role's credentials"
      );
    }
  }
  const connectionString = env[ENV_URLS[role]];
  if (!connectionString || !connectionString.trim()) {
    throw new Error(`Missing ${ENV_URLS[role]}`);
  }
  return {
    role,
    privateSchema: schema,
    connectionString,
    loginName: parseLogin(connectionString, role),
  };
}

// Schema lookup uses a query parameter rather than any caller-controlled SQL
// interpolation. The function checks ACTUAL session grants, not claimed URLs.
const ROLE_PREFLIGHT = `
SELECT
  session_user::text AS session_login,
  current_user::text AS effective_login,
  (SELECT r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb
           OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
     FROM pg_catalog.pg_roles r WHERE r.rolname = session_user) AS safe_login,
  n.nspowner = c.relowner AND n.nspowner <> session_user::regrole::oid
    AS schema_isolated,
  pg_catalog.pg_has_role(session_user, $2::name, 'USAGE')
    AND NOT pg_catalog.pg_has_role(session_user::regrole::oid, c.relowner, 'MEMBER')
    AND NOT (pg_catalog.pg_has_role(session_user, 'av_model_b_reader', 'MEMBER')
             AND $2 <> 'av_model_b_reader')
    AND NOT (pg_catalog.pg_has_role(session_user, 'av_model_b_coordinator', 'MEMBER')
             AND $2 <> 'av_model_b_coordinator')
    AND NOT (pg_catalog.pg_has_role(session_user, 'av_model_b_finalizer', 'MEMBER')
             AND $2 <> 'av_model_b_finalizer')
    AS role_isolated,
  NOT pg_catalog.has_schema_privilege(session_user::regrole::oid, n.oid, 'CREATE')
    AND NOT pg_catalog.has_database_privilege(session_user, pg_catalog.current_database(), 'CREATE')
    AND NOT pg_catalog.has_database_privilege(session_user, pg_catalog.current_database(), 'TEMP')
    AS object_creation_denied,
  pg_catalog.has_table_privilege(session_user::regrole::oid, c.oid, 'SELECT')
    AND NOT pg_catalog.has_table_privilege(session_user::regrole::oid, c.oid, 'INSERT')
    AND NOT pg_catalog.has_table_privilege(session_user::regrole::oid, c.oid, 'UPDATE')
    AND NOT pg_catalog.has_table_privilege(session_user::regrole::oid, c.oid, 'DELETE')
    AND NOT pg_catalog.has_table_privilege(session_user::regrole::oid, c.oid, 'TRUNCATE')
    AND NOT pg_catalog.has_table_privilege(session_user::regrole::oid, c.oid, 'TRIGGER')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        AND (pg_catalog.has_column_privilege(session_user::regrole::oid, c.oid, a.attname, 'INSERT')
             OR pg_catalog.has_column_privilege(session_user::regrole::oid, c.oid, a.attname, 'UPDATE'))
    ) AS table_is_read_only,
  pg_catalog.to_regprocedure(pg_catalog.format('%I.agentvault_model_b_claim_guarded(text,text,text,text,text,text)', $1::text)) IS NOT NULL
  AND pg_catalog.to_regprocedure(pg_catalog.format('%I.agentvault_model_b_prepare_guarded(text,bytea,text,text,bigint,text,text,text,text,text)', $1::text)) IS NOT NULL
  AND pg_catalog.to_regprocedure(pg_catalog.format('%I.agentvault_model_b_reserve_guarded(text)', $1::text)) IS NOT NULL
  AND pg_catalog.to_regprocedure(pg_catalog.format('%I.agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint)', $1::text)) IS NOT NULL
    AS functions_present,
  COALESCE(pg_catalog.has_function_privilege(session_user::regrole::oid,
    pg_catalog.to_regprocedure(pg_catalog.format('%I.agentvault_model_b_claim_guarded(text,text,text,text,text,text)', $1::text)),
    'EXECUTE'), false) = ($2 = 'av_model_b_coordinator')
  AND COALESCE(pg_catalog.has_function_privilege(session_user::regrole::oid,
    pg_catalog.to_regprocedure(pg_catalog.format('%I.agentvault_model_b_prepare_guarded(text,bytea,text,text,bigint,text,text,text,text,text)', $1::text)),
    'EXECUTE'), false) = ($2 = 'av_model_b_coordinator')
  AND COALESCE(pg_catalog.has_function_privilege(session_user::regrole::oid,
    pg_catalog.to_regprocedure(pg_catalog.format('%I.agentvault_model_b_reserve_guarded(text)', $1::text)),
    'EXECUTE'), false) = ($2 = 'av_model_b_coordinator')
  AND COALESCE(pg_catalog.has_function_privilege(session_user::regrole::oid,
    pg_catalog.to_regprocedure(pg_catalog.format('%I.agentvault_model_b_reconcile_guarded(text,text,text,text,text,text,text,text,bigint,bytea,text,bigint)', $1::text)),
    'EXECUTE'), false) = ($2 = 'av_model_b_finalizer')
    AS function_scope_correct
FROM pg_catalog.pg_namespace n
JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
WHERE n.nspname = $1::name AND c.relname = 'agentvault_model_b_payment_requests'
  AND c.relkind = 'r'
`;

type PreflightRow = {
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

/** Rejects the local all-roles test-owner login, even on a prepared schema. */
export async function verifyModelBRoleDatabase(
  db: Queryable,
  role: Role,
  privateSchema: string,
  expectedLogin: string
): Promise<void> {
  if (
    !validPrivateSchema(privateSchema) ||
    !Object.prototype.hasOwnProperty.call(DB_ROLES, role) ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(expectedLogin)
  ) {
    throw new Error("Invalid Model B role preflight configuration");
  }
  const result = await db.query<PreflightRow>(ROLE_PREFLIGHT, [
    privateSchema,
    DB_ROLES[role],
  ]);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.session_login !== expectedLogin ||
    row.effective_login !== expectedLogin ||
    row.safe_login !== true ||
    row.schema_isolated !== true ||
    row.role_isolated !== true ||
    row.object_creation_denied !== true ||
    row.table_is_read_only !== true ||
    row.function_scope_correct !== true ||
    row.functions_present !== true
  ) {
    throw new Error(`Model B ${role} PostgreSQL privileges are not isolated`);
  }
}

export type ModelBReadService = Pick<
  GuardedPostgresModelBPaymentStore,
  "get" | "getForReconciliation"
>;
export type ModelBPrepareService = ModelBReadService &
  Pick<
    GuardedPostgresModelBPaymentStore,
    "claim" | "persistSignedPayment" | "reserveOneSubmission"
  >;
export type ModelBFinalityService = ModelBReadService &
  Pick<GuardedPostgresModelBPaymentStore, "applyInspectedStatus">;

type RoleConnection = {
  store: GuardedPostgresModelBPaymentStore;
  close: () => Promise<void>;
};

/**
 * Inactive opt-in single-role factory. Does NOT open all three credentials in
 * one process. This ensures a compromised coordinator cannot read a finalizer
 * connection string merely because the same server bootstrapped both roles.
 *
 * One VERIFIED client is pinned for the lifetime: Pool.query() could
 * otherwise open a new, unverified connection after the startup check.
 * A broken session fails closed and must be reopened through preflight.
 */
async function openRole(
  role: Role,
  env: NodeJS.ProcessEnv
): Promise<RoleConnection> {
  const config = parseModelBRoleDatabaseConfiguration(role, env);
  const pool = new Pool({
    connectionString: config.connectionString,
    max: 1,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    query_timeout: 6000,
    allowExitOnIdle: false,
  });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await verifyModelBRoleDatabase(
      client,
      role,
      config.privateSchema,
      config.loginName
    );
  } catch (error) {
    if (client) client.release();
    await pool.end().catch(() => undefined);
    throw error;
  }
  const store = new GuardedPostgresModelBPaymentStore(
    client,
    config.privateSchema
  );
  let closed = false;
  return {
    store,
    async close() {
      if (closed) return;
      closed = true;
      client.release();
      await pool.end();
    },
  };
}

export type ModelBRoleConnection<T> = {
  service: T;
  close: () => Promise<void>;
};

/** Only read-only store methods; usable in a separately deployed API reader. */
export async function openModelBReaderDatabase(
  env: NodeJS.ProcessEnv = process.env
): Promise<ModelBRoleConnection<ModelBReadService>> {
  const connection = await openRole("reader", env);
  return Object.freeze({
    service: Object.freeze({
      get: (id: string) => connection.store.get(id),
      getForReconciliation: (id: string) =>
        connection.store.getForReconciliation(id),
    }),
    close: connection.close,
  });
}

/** Preparation only; no finality write, SQL pool, or broadcast permission. */
export async function openModelBCoordinatorDatabase(
  env: NodeJS.ProcessEnv = process.env
): Promise<ModelBRoleConnection<ModelBPrepareService>> {
  const connection = await openRole("coordinator", env);
  return Object.freeze({
    service: Object.freeze({
      get: (id: string) => connection.store.get(id),
      getForReconciliation: (id: string) =>
        connection.store.getForReconciliation(id),
      claim: (input: ClaimModelBPayment) => connection.store.claim(input),
      persistSignedPayment: (input: AuthorizedSignedModelBPayment) =>
        connection.store.persistSignedPayment(input),
      reserveOneSubmission: (id: string) =>
        connection.store.reserveOneSubmission(id),
    }),
    close: connection.close,
  });
}

/** Finality reconciliation only; no claim/sign/prepare/reservation capability. */
export async function openModelBFinalizerDatabase(
  env: NodeJS.ProcessEnv = process.env
): Promise<ModelBRoleConnection<ModelBFinalityService>> {
  const connection = await openRole("finalizer", env);
  return Object.freeze({
    service: Object.freeze({
      get: (id: string) => connection.store.get(id),
      getForReconciliation: (id: string) =>
        connection.store.getForReconciliation(id),
      applyInspectedStatus: (
        expected: ModelBPaymentRecord,
        observation: {
          status: "UNRESOLVED" | "CONFIRMED" | "FAILED";
          requestId: string;
          signature: string;
          finalizedSlot?: number;
        }
      ) => connection.store.applyInspectedStatus(expected, observation),
    }),
    close: connection.close,
  });
}
