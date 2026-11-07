import type { Pool, PoolClient } from "pg";
import type { ApiScope } from "./api-principal";
import type { DeveloperApiKeyRecord } from "./api-key-model";

import type {
  DeveloperApiKeyMetadata,
  DeveloperApiKeyRepository,
} from "./api-key-repository";

type ApiKeyRow = {
  key_id: string;
  principal_id: string;
  token_hash: string;
  vaults: string[];
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

type ApiKeyMetadataRow = Omit<ApiKeyRow, "token_hash">;

function parseTimestamp(value: string | null): number | null {
  if (value === null) return null;

  const timestamp = Number(value);

  if (!Number.isSafeInteger(timestamp)) {
    throw new Error("Invalid API key timestamp from database");
  }

  return timestamp;
}

function isDeveloperScope(scope: string): scope is ApiScope {
  return scope === "activity:read";
}

function parseScopes(scopes: string[]): ApiScope[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    !scopes.every(isDeveloperScope)
  ) {
    throw new Error("Invalid API key scopes from database");
  }

  return [...scopes];
}

function toRecord(row: ApiKeyRow): DeveloperApiKeyRecord {
  return {
    keyId: row.key_id,
    principalId: row.principal_id,
    tokenHash: row.token_hash,
    vaults: [...row.vaults],
    scopes: parseScopes(row.scopes),
    createdAt: parseTimestamp(row.created_at)!,
    expiresAt: parseTimestamp(row.expires_at),
    revokedAt: parseTimestamp(row.revoked_at),
  };
}

function toMetadata(row: ApiKeyMetadataRow): DeveloperApiKeyMetadata {
  return {
    keyId: row.key_id,
    principalId: row.principal_id,
    vaults: [...row.vaults],
    scopes: parseScopes(row.scopes),
    createdAt: parseTimestamp(row.created_at)!,
    expiresAt: parseTimestamp(row.expires_at),
    revokedAt: parseTimestamp(row.revoked_at),
  };
}

export class PostgresDeveloperApiKeyRepository
  implements DeveloperApiKeyRepository
{
  constructor(private readonly db: Pick<Pool | PoolClient, "query">) {}

  async findById(keyId: string): Promise<DeveloperApiKeyRecord | null> {
    const result = await this.db.query<ApiKeyRow>(
      `
      SELECT
        key_id,
        principal_id,
        token_hash,
        vaults,
        scopes,
        created_at,
        expires_at,
        revoked_at
      FROM developer_api_keys
      WHERE key_id = $1
      `,
      [keyId]
    );

    const row = result.rows[0];

    return row ? toRecord(row) : null;
  }

  async create(record: DeveloperApiKeyRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO developer_api_keys (
        key_id,
        principal_id,
        token_hash,
        vaults,
        scopes,
        created_at,
        expires_at,
        revoked_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        record.keyId,
        record.principalId,
        record.tokenHash,
        record.vaults,
        record.scopes,
        record.createdAt,
        record.expiresAt,
        record.revokedAt,
      ]
    );
  }

  async revoke(keyId: string, revokedAt: number): Promise<boolean> {
    if (!Number.isSafeInteger(revokedAt) || revokedAt < 0) {
      throw new Error("Invalid revocation timestamp");
    }

    const result = await this.db.query(
      `
      UPDATE developer_api_keys
      SET revoked_at = $2
      WHERE key_id = $1
        AND revoked_at IS NULL
        AND created_at <= $2
      RETURNING key_id
      `,
      [keyId, revokedAt]
    );

    return result.rowCount === 1;
  }

  async revokeForVault(
    keyId: string,
    vault: string,
    revokedAt: number
  ): Promise<boolean> {
    if (!Number.isSafeInteger(revokedAt) || revokedAt < 0) {
      throw new Error("Invalid revocation timestamp");
    }

    const result = await this.db.query(
      `
      UPDATE developer_api_keys
      SET revoked_at = $3
      WHERE key_id = $1
        AND $2 = ANY(vaults)
        AND revoked_at IS NULL
        AND created_at <= $3
      RETURNING key_id
      `,
      [keyId, vault, revokedAt]
    );

    return result.rowCount === 1;
  }

  async listByPrincipal(
    principalId: string
  ): Promise<DeveloperApiKeyMetadata[]> {
    const result = await this.db.query<ApiKeyMetadataRow>(
      `
      SELECT
        key_id,
        principal_id,
        vaults,
        scopes,
        created_at,
        expires_at,
        revoked_at
      FROM developer_api_keys
      WHERE principal_id = $1
      ORDER BY created_at DESC, key_id ASC
      `,
      [principalId]
    );

    return result.rows.map(toMetadata);
  }
}
