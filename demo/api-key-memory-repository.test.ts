import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryDeveloperApiKeyRepository } from "./api-key-memory-repository";

import type { DeveloperApiKeyRecord } from "./api-key-model";

const NOW = 1_800_000_000_000;

function makeRecord(
  overrides: Partial<DeveloperApiKeyRecord> = {}
): DeveloperApiKeyRecord {
  return {
    keyId: "a".repeat(24),
    principalId: "developer_001",
    tokenHash: "b".repeat(64),
    vaults: ["11111111111111111111111111111111"],
    scopes: ["activity:read"],
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

test("creates and retrieves a credential", async () => {
  const repo = new InMemoryDeveloperApiKeyRepository();
  const record = makeRecord();

  await repo.create(record);

  assert.deepEqual(await repo.findById(record.keyId), record);
});

test("rejects duplicate credential identifiers", async () => {
  const repo = new InMemoryDeveloperApiKeyRepository();
  const record = makeRecord();

  await repo.create(record);

  await assert.rejects(repo.create(record), /already exists/);
});

test("revokes an existing credential", async () => {
  const repo = new InMemoryDeveloperApiKeyRepository();
  const record = makeRecord();

  await repo.create(record);

  assert.equal(await repo.revoke(record.keyId, NOW + 1000), true);

  const stored = await repo.findById(record.keyId);

  assert.equal(stored?.revokedAt, NOW + 1000);
});

test("revocation is irreversible", async () => {
  const repo = new InMemoryDeveloperApiKeyRepository();
  const record = makeRecord();

  await repo.create(record);

  assert.equal(await repo.revoke(record.keyId, NOW + 1000), true);

  assert.equal(await repo.revoke(record.keyId, NOW + 2000), false);

  assert.equal((await repo.findById(record.keyId))?.revokedAt, NOW + 1000);
});

test("rejects invalid revocation timestamps", async () => {
  const repo = new InMemoryDeveloperApiKeyRepository();
  const record = makeRecord();

  await repo.create(record);

  await assert.rejects(
    repo.revoke(record.keyId, Number.NaN),
    /Invalid revocation timestamp/
  );

  await assert.rejects(
    repo.revoke(record.keyId, NOW - 1),
    /Revocation cannot precede creation/
  );
});

test("unknown credentials cannot be revoked", async () => {
  const repo = new InMemoryDeveloperApiKeyRepository();

  assert.equal(await repo.revoke("unknown", NOW), false);
});

test("lists only metadata for the requested principal", async () => {
  const repo = new InMemoryDeveloperApiKeyRepository();

  await repo.create(makeRecord());

  await repo.create(
    makeRecord({
      keyId: "c".repeat(24),
      principalId: "developer_002",
    })
  );

  const records = await repo.listByPrincipal("developer_001");

  assert.equal(records.length, 1);
  assert.equal(records[0].principalId, "developer_001");
  assert.equal("tokenHash" in records[0], false);
});

test("stored credentials are isolated from caller mutations", async () => {
  const repo = new InMemoryDeveloperApiKeyRepository();
  const record = makeRecord();

  await repo.create(record);

  (record.vaults as string[]).push(
    "SysvarC1ock11111111111111111111111111111111"
  );

  const stored = await repo.findById(record.keyId);

  assert.equal(stored?.vaults.length, 1);

  (stored?.scopes as string[]).push("treasury:read");

  const retrievedAgain = await repo.findById(record.keyId);

  assert.deepEqual(retrievedAgain?.scopes, ["activity:read"]);
});

test("vault-scoped revocation rejects unauthorized vaults", async () => {
  const repo = new InMemoryDeveloperApiKeyRepository();

  const authorizedVault = "11111111111111111111111111111111";

  const unauthorizedVault = "SysvarC1ock11111111111111111111111111111111";

  const record = makeRecord({
    vaults: [authorizedVault],
  });

  await repo.create(record);

  // Another vault cannot revoke this credential.
  assert.equal(
    await repo.revokeForVault(record.keyId, unauthorizedVault, NOW + 1000),
    false
  );

  // Unauthorized attempts must not mutate the record.
  assert.equal((await repo.findById(record.keyId))?.revokedAt, null);

  // The assigned vault can revoke the credential.
  assert.equal(
    await repo.revokeForVault(record.keyId, authorizedVault, NOW + 1000),
    true
  );

  assert.equal((await repo.findById(record.keyId))?.revokedAt, NOW + 1000);

  // Revocation is irreversible.
  assert.equal(
    await repo.revokeForVault(record.keyId, authorizedVault, NOW + 2000),
    false
  );
});
