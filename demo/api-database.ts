import { Pool } from "pg";

import { PostgresDeveloperApiKeyRepository } from "./api-key-postgres-repository";

export type ApiDatabase = {
  pool: Pool;
  repository: PostgresDeveloperApiKeyRepository;
};

export function createApiDatabase(
  env: NodeJS.ProcessEnv = process.env
): ApiDatabase {
  const connectionString = env.AGENTVAULT_DATABASE_URL;

  if (!connectionString || connectionString.trim().length === 0) {
    throw new Error(
      "AGENTVAULT_DATABASE_URL is required for PostgreSQL authentication"
    );
  }

  const url = new URL(connectionString);

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("Invalid PostgreSQL connection URL protocol");
  }

  if (!url.hostname || !url.username || !url.password) {
    throw new Error(
      "PostgreSQL connection URL must include host, user and password"
    );
  }

  if (url.pathname.length <= 1) {
    throw new Error("PostgreSQL database name is required");
  }

  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    query_timeout: 6000,
    allowExitOnIdle: false,
  });

  return {
    pool,
    repository: new PostgresDeveloperApiKeyRepository(pool),
  };
}

type ReadinessRow = {
  table_exists: boolean;
  schema_valid: boolean;
  permissions_valid: boolean;
  trigger_valid: boolean;
};

export type DatabaseReadinessQuery = (
  sql: string
) => Promise<{ rows: ReadinessRow[] }>;

export async function verifyApiDatabase(
  database: ApiDatabase,
  query: DatabaseReadinessQuery = (sql) => database.pool.query(sql)
): Promise<void> {
  const result = await query(`
    SELECT
      to_regclass('public.developer_api_keys') IS NOT NULL
        AS table_exists,

      (
        SELECT COUNT(*) = 8
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'developer_api_keys'
          AND (
            (column_name = 'key_id'
              AND data_type = 'text'
              AND is_nullable = 'NO')
            OR
            (column_name = 'principal_id'
              AND data_type = 'text'
              AND is_nullable = 'NO')
            OR
            (column_name = 'token_hash'
              AND data_type = 'text'
              AND is_nullable = 'NO')
            OR
            (column_name = 'vaults'
              AND data_type = 'ARRAY'
              AND udt_name = '_text'
              AND is_nullable = 'NO')
            OR
            (column_name = 'scopes'
              AND data_type = 'ARRAY'
              AND udt_name = '_text'
              AND is_nullable = 'NO')
            OR
            (column_name = 'created_at'
              AND data_type = 'bigint'
              AND is_nullable = 'NO')
            OR
            (column_name = 'expires_at'
              AND data_type = 'bigint'
              AND is_nullable = 'YES')
            OR
            (column_name = 'revoked_at'
              AND data_type = 'bigint'
              AND is_nullable = 'YES')
          )
      ) AS schema_valid ,
       (
  SELECT
    has_table_privilege(
      current_user,
      'public.developer_api_keys',
      'SELECT'
    )
    AND has_table_privilege(
      current_user,
      'public.developer_api_keys',
      'INSERT'
    )
    AND has_column_privilege(
      current_user,
      'public.developer_api_keys',
      'revoked_at',
      'UPDATE'
    )
    AND NOT has_table_privilege(
      current_user,
      'public.developer_api_keys',
      'DELETE'
    )
    AND NOT has_table_privilege(
      current_user,
      'public.developer_api_keys',
      'UPDATE'
    )
    AND NOT has_column_privilege(
      current_user,
      'public.developer_api_keys',
      'token_hash',
      'UPDATE'
    )
    AND NOT has_column_privilege(
      current_user,
      'public.developer_api_keys',
      'scopes',
      'UPDATE'
    )
    AND NOT has_column_privilege(
      current_user,
      'public.developer_api_keys',
      'vaults',
      'UPDATE'
    )
      AND NOT has_column_privilege(
  current_user,
  'public.developer_api_keys',
  'key_id',
  'UPDATE'
)
AND NOT has_column_privilege(
  current_user,
  'public.developer_api_keys',
  'principal_id',
  'UPDATE'
)
AND NOT has_column_privilege(
  current_user,
  'public.developer_api_keys',
  'created_at',
  'UPDATE'
)
AND NOT has_column_privilege(
  current_user,
  'public.developer_api_keys',
  'expires_at',
  'UPDATE'
)
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n
    ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'developer_api_keys'
    AND c.relkind IN ('r', 'p')
) AS permissions_valid,

EXISTS (
  SELECT 1
  FROM pg_catalog.pg_trigger AS t
  JOIN pg_catalog.pg_class AS c
    ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace AS table_schema
    ON table_schema.oid = c.relnamespace
  JOIN pg_catalog.pg_proc AS p
    ON p.oid = t.tgfoid
  JOIN pg_catalog.pg_namespace AS function_schema
    ON function_schema.oid = p.pronamespace
  WHERE table_schema.nspname = 'public'
    AND c.relname = 'developer_api_keys'
    AND t.tgname = 'trg_enforce_developer_api_key_revocation'
    AND t.tgenabled = 'O'
    AND NOT t.tgisinternal
    AND p.proname = 'enforce_developer_api_key_revocation'
    AND function_schema.nspname = 'public'
    AND p.pronargs = 0
    AND t.tgtype::integer = 19
) AS trigger_valid
  `);

  if (
    result.rows.length !== 1 ||
    result.rows[0]?.table_exists !== true ||
    result.rows[0]?.schema_valid !== true ||
    result.rows[0]?.permissions_valid !== true ||
    result.rows[0]?.trigger_valid !== true
  ) {
    throw new Error("PostgreSQL authentication schema is not ready");
  }
}
