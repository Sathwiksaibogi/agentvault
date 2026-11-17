import { PublicKey } from "@solana/web3.js";

import type { ApiPrincipal } from "./api-principal";
import type {
  DeveloperApiKeyMetadata,
  DeveloperApiKeyRepository,
} from "./api-key-repository";

export type ListManagedDeveloperApiKeysInput = {
  issuer: ApiPrincipal;
  principalId: string;
  vault: string;
  repository: Pick<DeveloperApiKeyRepository, "listByPrincipal">;
};

function isCanonicalVault(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function assertAuthorizedOwner(issuer: ApiPrincipal, vault: string): void {
  if (!issuer || issuer.role !== "owner") {
    throw new Error("Only owners can manage developer API keys");
  }

  if (
    !isCanonicalVault(vault) ||
    !Array.isArray(issuer.vaults) ||
    !issuer.vaults.includes(vault)
  ) {
    throw new Error("Issuer is not authorized for this vault");
  }
}

function assertValidPrincipalId(principalId: string): void {
  if (
    typeof principalId !== "string" ||
    principalId.length === 0 ||
    principalId.length > 128 ||
    principalId.trim() !== principalId
  ) {
    throw new Error("Invalid developer principal ID");
  }
}

export async function listManagedDeveloperApiKeys(
  input: ListManagedDeveloperApiKeysInput
): Promise<DeveloperApiKeyMetadata[]> {
  const { issuer, principalId, vault, repository } = input;

  // Authorization must happen before querying storage.
  assertAuthorizedOwner(issuer, vault);
  assertValidPrincipalId(principalId);

  const records = await repository.listByPrincipal(principalId);

  // A managed credential must belong to exactly one vault.
  // Exclude multi-vault credentials from this operation.
  return records
    .filter(
      (record) =>
        record.principalId === principalId &&
        Array.isArray(record.vaults) &&
        record.vaults.length === 1 &&
        record.vaults[0] === vault &&
        Array.isArray(record.scopes) &&
        record.scopes.length === 1 &&
        (record.scopes[0] === "activity:read" ||
          record.scopes[0] === "payments:request")
    )
    .map((record) => ({
      keyId: record.keyId,
      principalId: record.principalId,
      vaults: [vault],
      scopes: [...record.scopes],
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      revokedAt: record.revokedAt,
    }));
}

export type RevokeManagedDeveloperApiKeyInput = {
  issuer: ApiPrincipal;
  keyId: string;
  vault: string;
  revokedAt: number;
  repository: Pick<DeveloperApiKeyRepository, "revokeForVault">;
};

export async function revokeManagedDeveloperApiKey(
  input: RevokeManagedDeveloperApiKeyInput
): Promise<boolean> {
  const { issuer, keyId, vault, revokedAt, repository } = input;

  // Never access storage before authenticating the owner
  // and validating the target vault.
  assertAuthorizedOwner(issuer, vault);

  // API key IDs are generated as 24 lowercase hex characters.
  if (typeof keyId !== "string" || !/^[0-9a-f]{24}$/.test(keyId)) {
    throw new Error("Invalid developer API-key identifier");
  }

  if (!Number.isSafeInteger(revokedAt) || revokedAt < 0) {
    throw new Error("Invalid revocation timestamp");
  }

  // The repository atomically enforces:
  // - exact vault membership
  // - single-vault credential policy
  // - irreversible revocation
  // - revocation timestamp >= creation timestamp
  //
  // Do not replace this with findById() + revoke().
  return repository.revokeForVault(keyId, vault, revokedAt);
}
