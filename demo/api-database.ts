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
    allowExitOnIdle: false,
  });

  return {
    pool,
    repository: new PostgresDeveloperApiKeyRepository(pool),
  };
}

export async function verifyApiDatabase(database: ApiDatabase): Promise<void> {
  const result = await database.pool.query(
    "SELECT current_user AS username, current_database() AS database"
  );

  if (result.rows.length !== 1) {
    throw new Error("PostgreSQL readiness check failed");
  }
}
