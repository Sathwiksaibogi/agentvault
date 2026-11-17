import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeveloperApiKeyMetadata,
  DeveloperApiKeyRepository,
} from "./api-key-repository";

import type { DeveloperApiKeyRecord } from "./api-key-model";

test("API key metadata excludes the stored verifier", () => {
  const record: DeveloperApiKeyRecord = {
    keyId: "a".repeat(24),
    principalId: "developer_001",
    tokenHash: "b".repeat(64),
    vaults: ["11111111111111111111111111111111"],
    scopes: ["activity:read"],
    createdAt: 1_800_000_000_000,
    expiresAt: null,
    revokedAt: null,
  };

  const { tokenHash: _tokenHash, ...metadata } = record;

  const result: DeveloperApiKeyMetadata = metadata;

  assert.equal(result.keyId, record.keyId);
  assert.equal(result.principalId, record.principalId);
  assert.equal("tokenHash" in result, false);
});

test("repository contract supports scoped credential operations", () => {
  const repository: DeveloperApiKeyRepository = {
    findById: async () => null,
    create: async () => {},
    revoke: async () => false,
    revokeForVault: async () => false,
    listByPrincipal: async () => [],
  };

  assert.equal(typeof repository.findById, "function");
  assert.equal(typeof repository.create, "function");
  assert.equal(typeof repository.revoke, "function");
  assert.equal(typeof repository.listByPrincipal, "function");
});
