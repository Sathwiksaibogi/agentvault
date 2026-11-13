import {
  extractDeveloperApiKeyId,
  verifyDeveloperApiKey,
} from "./api-key-crypto";

import { PublicKey } from "@solana/web3.js";

import type { DeveloperApiKeyRecord } from "./api-key-model";
import type { ApiPrincipal, ApiScope } from "./api-principal";

export type DeveloperApiKeyLookup = (
  keyId: string
) => Promise<DeveloperApiKeyRecord | null>;

export async function resolveDeveloperApiKey(
  token: string,
  lookup: DeveloperApiKeyLookup,
  now: number = Date.now()
): Promise<ApiPrincipal | null> {
  const keyId = extractDeveloperApiKeyId(token);

  if (!keyId) {
    return null;
  }

  const record = await lookup(keyId);

  if (!record) {
    return null;
  }

  if (!verifyDeveloperApiKey(token, record, now)) {
    return null;
  }

  // Fail closed if a stored credential contains
  // permissions outside the current developer contract.
  const allowedScopes: readonly ApiScope[] = [
    "activity:read",
    "payments:request",
  ];

  if (
    record.scopes.length !== 1 ||
    record.scopes.some((scope) => !allowedScopes.includes(scope))
  ) {
    return null;
  }

  if (
    !record.principalId ||
    record.vaults.length === 0 ||
    record.vaults.some((vault) => !isCanonicalVaultAddress(vault))
  ) {
    return null;
  }

  return {
    principalId: record.principalId,
    role: "developer",
    vaults: [...record.vaults],
    scopes: [...record.scopes],
  };
}

function isCanonicalVaultAddress(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}
