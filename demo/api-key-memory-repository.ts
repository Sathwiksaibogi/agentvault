
import type { DeveloperApiKeyRecord } from "./api-key-model";

import type {
  DeveloperApiKeyMetadata,
  DeveloperApiKeyRepository,
} from "./api-key-repository";

function cloneRecord(
  record: DeveloperApiKeyRecord
): DeveloperApiKeyRecord {
  return {
    ...record,
    vaults: [...record.vaults],
    scopes: [...record.scopes],
  };
}

function toMetadata(
  record: DeveloperApiKeyRecord
): DeveloperApiKeyMetadata {
  return {
    keyId: record.keyId,
    principalId: record.principalId,
    vaults: [...record.vaults],
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  };
}

export class InMemoryDeveloperApiKeyRepository
  implements DeveloperApiKeyRepository
{
  private readonly records = new Map<
    string,
    DeveloperApiKeyRecord
  >();

  async findById(
    keyId: string
  ): Promise<DeveloperApiKeyRecord | null> {
    const record = this.records.get(keyId);

    return record ? cloneRecord(record) : null;
  }

  async create(
    record: DeveloperApiKeyRecord
  ): Promise<void> {
    if (this.records.has(record.keyId)) {
      throw new Error("API key already exists");
    }

    this.records.set(
      record.keyId,
      cloneRecord(record)
    );
  }

  async revoke(
    keyId: string,
    revokedAt: number
  ): Promise<boolean> {
    if (!Number.isSafeInteger(revokedAt) || revokedAt < 0) {
      throw new Error("Invalid revocation timestamp");
    }

    const record = this.records.get(keyId);

    if (!record) {
      return false;
    }

    if (record.revokedAt !== null) {
      return false;
    }

    if (revokedAt < record.createdAt) {
      throw new Error(
        "Revocation cannot precede creation"
      );
    }

    this.records.set(keyId, {
      ...record,
      revokedAt,
    });

    return true;
  }

  async listByPrincipal(
    principalId: string
  ): Promise<DeveloperApiKeyMetadata[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.principalId === principalId
      )
      .map(toMetadata);
  }
}
