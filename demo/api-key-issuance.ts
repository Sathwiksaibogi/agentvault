import { PublicKey } from "@solana/web3.js";

import {
  extractDeveloperApiKeyId,
  generateDeveloperApiKey,
  hashDeveloperApiKey,
} from "./api-key-crypto";

import type { ApiPrincipal, ApiScope } from "./api-principal";

import type { DeveloperApiKeyRepository } from "./api-key-repository";

export type IssueDeveloperApiKeyInput = {
  issuer: ApiPrincipal;
  principalId: string;
  vault: string;
  scopes: readonly ApiScope[];
  expiresAt: number | null;
  now: number;
  repository: Pick<DeveloperApiKeyRepository, "create">;
};

export type IssuedDeveloperApiKey = {
  keyId: string;
  token: string;
};

function isCanonicalVaultAddress(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

export async function issueDeveloperApiKey(
  input: IssueDeveloperApiKeyInput
): Promise<IssuedDeveloperApiKey> {
  const { issuer, principalId, vault, scopes, expiresAt, now, repository } =
    input;

  // This service accepts only a trusted, authenticated
  // owner principal supplied by the caller.
  if (issuer.role !== "owner") {
    throw new Error("Only owners can issue developer API keys");
  }

  if (!isCanonicalVaultAddress(vault) || !issuer.vaults.includes(vault)) {
    throw new Error("Issuer is not authorized for this vault");
  }

  if (
    typeof principalId !== "string" ||
    principalId.trim().length === 0 ||
    principalId !== principalId.trim() ||
    principalId.length > 128
  ) {
    throw new Error("Invalid developer principal ID");
  }

  if (
    !Array.isArray(scopes) ||
    scopes.length !== 1 ||
    scopes[0] !== "activity:read"
  ) {
    throw new Error("Invalid developer API-key scopes");
  }

  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Invalid creation timestamp");
  }

  if (
    expiresAt !== null &&
    (typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now)
  ) {
    throw new Error("Invalid expiration timestamp");
  }

  const token = generateDeveloperApiKey();
  const keyId = extractDeveloperApiKeyId(token);

  if (!keyId) {
    throw new Error("Failed to generate API-key identifier");
  }

  // Never persist the plaintext token.
  await repository.create({
    keyId,
    principalId,
    tokenHash: hashDeveloperApiKey(token),
    vaults: [vault],
    scopes: ["activity:read"],
    createdAt: now,
    expiresAt,
    revokedAt: null,
  });

  // Return the secret only after persistence succeeds.
  return {
    keyId,
    token,
  };
}
