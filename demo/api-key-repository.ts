import type { DeveloperApiKeyRecord } from "./api-key-model";

export type DeveloperApiKeyMetadata = Omit<DeveloperApiKeyRecord, "tokenHash">;

export interface DeveloperApiKeyRepository {
  /**
   * Find a credential by its public key identifier.
   *
   * Returns null if no matching record exists.
   * Storage errors must propagate so authentication
   * can fail closed.
   */
  findById(keyId: string): Promise<DeveloperApiKeyRecord | null>;

  /**
   * Insert a new credential.
   *
   * Must reject duplicate key identifiers.
   * Never overwrite an existing credential.
   */
  create(record: DeveloperApiKeyRecord): Promise<void>;

  /**
   * Revoke a credential permanently.
   *
   * Must not clear an existing revocation.
   * Must reject invalid timestamps.
   * Must enforce atomic updates.
   */
  revoke(keyId: string, revokedAt: number): Promise<boolean>;

  /**
   * Return credential metadata without the
   * stored token verifier.
   */
  listByPrincipal(principalId: string): Promise<DeveloperApiKeyMetadata[]>;

  /**
   * Revoke a credential only when it belongs
   * to the specified vault.
   *
   * Authorization and revocation must be atomic.
   * Returns false when the credential is absent,
   * outside the vault, or already revoked.
   */
  revokeForVault(
    keyId: string,
    vault: string,
    revokedAt: number
  ): Promise<boolean>;
}
