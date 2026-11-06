import type { ApiScope } from "./api-principal";

export type DeveloperApiKeyRecord = {
  keyId: string;
  principalId: string;
  tokenHash: string;
  vaults: readonly string[];
  scopes: readonly ApiScope[];
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
};

export type ApiKeyStatus =
  | "active"
  | "expired"
  | "revoked";

export function getApiKeyStatus(
  record: DeveloperApiKeyRecord,
  now: number
): ApiKeyStatus {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt > now ||
    (
      record.expiresAt !== null &&
      (
        !Number.isSafeInteger(record.expiresAt) ||
        record.expiresAt <= record.createdAt
      )
    ) ||
    (
      record.revokedAt !== null &&
      !Number.isSafeInteger(record.revokedAt)
    )
  ) {
    return "revoked";
  }

  if (record.revokedAt !== null) {
    return "revoked";
  }

  if (
    record.expiresAt !== null &&
    now >= record.expiresAt
  ) {
    return "expired";
  }

  return "active";
}