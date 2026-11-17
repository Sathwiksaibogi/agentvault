import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryDeveloperApiKeyRepository } from "./api-key-memory-repository";
import {
  extractDeveloperApiKeyId,
  hashDeveloperApiKey,
} from "./api-key-crypto";
import { issueDeveloperApiKey } from "./api-key-issuance";

import type { ApiPrincipal } from "./api-principal";

const VAULT = "11111111111111111111111111111111";
const NOW = 1_800_000_000_000;

const owner: ApiPrincipal = {
  principalId: "owner-1",
  role: "owner",
  vaults: [VAULT],
  scopes: ["treasury:read", "agents:read", "workflows:read", "activity:read"],
};

test("owner can issue a developer key without storing plaintext", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  const result = await issueDeveloperApiKey({
    issuer: owner,
    principalId: "developer-1",
    vault: VAULT,
    scopes: ["activity:read"],
    expiresAt: NOW + 86_400_000,
    now: NOW,
    repository,
  });

  const keyId = extractDeveloperApiKeyId(result.token);

  assert.ok(keyId);
  assert.equal(result.keyId, keyId);

  const stored = await repository.findById(keyId);

  assert.ok(stored);
  assert.equal(stored.principalId, "developer-1");
  assert.deepEqual(stored.vaults, [VAULT]);
  assert.deepEqual(stored.scopes, ["activity:read"]);
  assert.equal(stored.tokenHash, hashDeveloperApiKey(result.token));
  assert.notEqual(stored.tokenHash, result.token);
  assert.equal(stored.createdAt, NOW);
  assert.equal(stored.expiresAt, NOW + 86_400_000);
  assert.equal(stored.revokedAt, null);
});

test("developer principals cannot issue API keys", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  const developer: ApiPrincipal = {
    principalId: "developer-1",
    role: "developer",
    vaults: [VAULT],
    scopes: ["activity:read"],
  };

  await assert.rejects(
    issueDeveloperApiKey({
      issuer: developer,
      principalId: "developer-2",
      vault: VAULT,
      scopes: ["activity:read"],
      expiresAt: null,
      now: NOW,
      repository,
    })
  );

  assert.deepEqual(await repository.listByPrincipal("developer-2"), []);
});

test("owner cannot issue keys for an unauthorized vault", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  await assert.rejects(
    issueDeveloperApiKey({
      issuer: owner,
      principalId: "developer-1",
      vault: "SysvarRent111111111111111111111111111111111",
      scopes: ["activity:read"],
      expiresAt: null,
      now: NOW,
      repository,
    }),
    /not authorized/
  );

  assert.deepEqual(await repository.listByPrincipal("developer-1"), []);
});

test("owner cannot issue keys with elevated scopes", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  await assert.rejects(
    issueDeveloperApiKey({
      issuer: owner,
      principalId: "developer-1",
      vault: VAULT,
      scopes: ["treasury:read"],
      expiresAt: null,
      now: NOW,
      repository,
    }),
    /Invalid developer API-key scopes/
  );

  assert.deepEqual(await repository.listByPrincipal("developer-1"), []);
});

test("issuance rejects invalid developer principal IDs", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  for (const principalId of ["", " ", " developer-1 "]) {
    await assert.rejects(
      issueDeveloperApiKey({
        issuer: owner,
        principalId,
        vault: VAULT,
        scopes: ["activity:read"],
        expiresAt: null,
        now: NOW,
        repository,
      }),
      /Invalid developer principal ID/
    );
  }

  assert.deepEqual(await repository.listByPrincipal("developer-1"), []);
});

test("issuance rejects invalid timestamps", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  for (const expiresAt of [NOW, NOW - 1, NaN, Infinity]) {
    await assert.rejects(
      issueDeveloperApiKey({
        issuer: owner,
        principalId: "developer-1",
        vault: VAULT,
        scopes: ["activity:read"],
        expiresAt,
        now: NOW,
        repository,
      }),
      /Invalid expiration timestamp/
    );
  }

  assert.deepEqual(await repository.listByPrincipal("developer-1"), []);
});

test("issuance never returns a token when persistence fails", async () => {
  const repository = {
    create: async () => {
      throw new Error("Database unavailable");
    },
  };

  await assert.rejects(
    issueDeveloperApiKey({
      issuer: owner,
      principalId: "developer-1",
      vault: VAULT,
      scopes: ["activity:read"],
      expiresAt: null,
      now: NOW,
      repository,
    }),
    /Database unavailable/
  );
});

test("issuance rejects missing expiration values at runtime", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  await assert.rejects(
    issueDeveloperApiKey({
      issuer: owner,
      principalId: "developer-1",
      vault: VAULT,
      scopes: ["activity:read"],
      expiresAt: undefined as unknown as number,
      now: NOW,
      repository,
    }),
    /Invalid expiration timestamp/
  );

  assert.deepEqual(await repository.listByPrincipal("developer-1"), []);
});
