import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryDeveloperApiKeyRepository } from "./api-key-memory-repository";
import {
  listManagedDeveloperApiKeys,
  revokeManagedDeveloperApiKey,
} from "./api-key-management";

import type { ApiPrincipal } from "./api-principal";

const VAULT_A = "11111111111111111111111111111111";
const VAULT_B = "SysvarC1ock11111111111111111111111111111111";
const NOW = 1_800_000_000_000;

const owner: ApiPrincipal = {
  principalId: "legacy-owner",
  role: "owner",
  vaults: [VAULT_A],
  scopes: ["treasury:read", "agents:read", "workflows:read", "activity:read"],
};

const developer: ApiPrincipal = {
  principalId: "developer_001",
  role: "developer",
  vaults: [VAULT_A],
  scopes: ["activity:read"],
};

test("owner lists only credentials assigned to its vault", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  await repository.create({
    keyId: "a".repeat(24),
    principalId: "developer_001",
    tokenHash: "b".repeat(64),
    vaults: [VAULT_A],
    scopes: ["activity:read"],
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
  });

  await repository.create({
    keyId: "c".repeat(24),
    principalId: "developer_001",
    tokenHash: "d".repeat(64),
    vaults: [VAULT_B],
    scopes: ["activity:read"],
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
  });

  const results = await listManagedDeveloperApiKeys({
    issuer: owner,
    principalId: "developer_001",
    vault: VAULT_A,
    repository,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].keyId, "a".repeat(24));

  // Management responses must never expose secrets.
  assert.equal("tokenHash" in results[0], false);
  assert.equal("token" in results[0], false);
});

test("developer cannot list managed credentials", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  await assert.rejects(
    listManagedDeveloperApiKeys({
      issuer: developer,
      principalId: "developer_001",
      vault: VAULT_A,
      repository,
    }),
    /Only owners/
  );
});

test("owner cannot list credentials for an unauthorized vault", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  await assert.rejects(
    listManagedDeveloperApiKeys({
      issuer: owner,
      principalId: "developer_001",
      vault: VAULT_B,
      repository,
    }),
    /not authorized/
  );
});

test("listing rejects invalid developer principal IDs before storage access", async () => {
  let repositoryCalled = false;

  const repository = {
    listByPrincipal: async () => {
      repositoryCalled = true;
      return [];
    },
  };

  for (const principalId of [
    "",
    " ",
    " developer_001",
    "developer_001 ",
    "a".repeat(129),
  ]) {
    await assert.rejects(
      listManagedDeveloperApiKeys({
        issuer: owner,
        principalId,
        vault: VAULT_A,
        repository,
      }),
      /Invalid developer principal ID/
    );
  }

  assert.equal(repositoryCalled, false);
});

test("listing excludes credentials assigned to multiple vaults", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  await repository.create({
    keyId: "e".repeat(24),
    principalId: "developer_001",
    tokenHash: "f".repeat(64),
    vaults: [VAULT_A, VAULT_B],
    scopes: ["activity:read"],
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
  });

  const results = await listManagedDeveloperApiKeys({
    issuer: owner,
    principalId: "developer_001",
    vault: VAULT_A,
    repository,
  });

  assert.deepEqual(results, []);
});

test("listing rejects malformed vault addresses before storage access", async () => {
  let repositoryCalled = false;

  const repository = {
    listByPrincipal: async () => {
      repositoryCalled = true;
      return [];
    },
  };

  await assert.rejects(
    listManagedDeveloperApiKeys({
      issuer: owner,
      principalId: "developer_001",
      vault: "invalid-vault-address",
      repository,
    }),
    /not authorized/
  );

  assert.equal(repositoryCalled, false);
});

test("listing propagates repository failures without returning credentials", async () => {
  const repository = {
    listByPrincipal: async (): Promise<never> => {
      throw new Error("Database unavailable");
    },
  };

  await assert.rejects(
    listManagedDeveloperApiKeys({
      issuer: owner,
      principalId: "developer_001",
      vault: VAULT_A,
      repository,
    }),
    /Database unavailable/
  );
});

test("owner can revoke a credential assigned to its vault", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();

  const keyId = "a".repeat(24);

  await repository.create({
    keyId,
    principalId: "developer_001",
    tokenHash: "b".repeat(64),
    vaults: [VAULT_A],
    scopes: ["activity:read"],
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
  });

  const revoked = await revokeManagedDeveloperApiKey({
    issuer: owner,
    keyId,
    vault: VAULT_A,
    revokedAt: NOW + 1000,
    repository,
  });

  assert.equal(revoked, true);

  const stored = await repository.findById(keyId);
  assert.equal(stored?.revokedAt, NOW + 1000);

  // Revocation must be irreversible.
  const repeated = await revokeManagedDeveloperApiKey({
    issuer: owner,
    keyId,
    vault: VAULT_A,
    revokedAt: NOW + 2000,
    repository,
  });

  assert.equal(repeated, false);
  assert.equal((await repository.findById(keyId))?.revokedAt, NOW + 1000);
});

test("developer cannot revoke managed credentials", async () => {
  let repositoryCalled = false;

  const repository = {
    revokeForVault: async () => {
      repositoryCalled = true;
      return true;
    },
  };

  await assert.rejects(
    revokeManagedDeveloperApiKey({
      issuer: developer,
      keyId: "a".repeat(24),
      vault: VAULT_A,
      revokedAt: NOW,
      repository,
    }),
    /Only owners/
  );

  assert.equal(repositoryCalled, false);
});

test("owner cannot revoke credentials outside its vault", async () => {
  let repositoryCalled = false;

  const repository = {
    revokeForVault: async () => {
      repositoryCalled = true;
      return true;
    },
  };

  await assert.rejects(
    revokeManagedDeveloperApiKey({
      issuer: owner,
      keyId: "a".repeat(24),
      vault: VAULT_B,
      revokedAt: NOW,
      repository,
    }),
    /not authorized/
  );

  assert.equal(repositoryCalled, false);
});

test("revocation rejects malformed key IDs before storage access", async () => {
  let repositoryCalled = false;

  const repository = {
    revokeForVault: async () => {
      repositoryCalled = true;
      return true;
    },
  };

  for (const keyId of [
    "",
    "invalid-key",
    "a".repeat(23),
    "a".repeat(25),
    "A".repeat(24),
    "a".repeat(24) + " ",
  ]) {
    await assert.rejects(
      revokeManagedDeveloperApiKey({
        issuer: owner,
        keyId,
        vault: VAULT_A,
        revokedAt: NOW,
        repository,
      }),
      /Invalid developer API-key identifier/
    );
  }

  assert.equal(repositoryCalled, false);
});

test("revocation rejects invalid timestamps before storage access", async () => {
  let repositoryCalled = false;

  const repository = {
    revokeForVault: async () => {
      repositoryCalled = true;
      return true;
    },
  };

  for (const revokedAt of [
    -1,
    NaN,
    Infinity,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      revokeManagedDeveloperApiKey({
        issuer: owner,
        keyId: "a".repeat(24),
        vault: VAULT_A,
        revokedAt,
        repository,
      }),
      /Invalid revocation timestamp/
    );
  }

  assert.equal(repositoryCalled, false);
});

test("revocation rejects malformed vaults before storage access", async () => {
  let repositoryCalled = false;

  const repository = {
    revokeForVault: async () => {
      repositoryCalled = true;
      return true;
    },
  };

  await assert.rejects(
    revokeManagedDeveloperApiKey({
      issuer: owner,
      keyId: "a".repeat(24),
      vault: "invalid-vault",
      revokedAt: NOW,
      repository,
    }),
    /not authorized/
  );

  assert.equal(repositoryCalled, false);
});

test("revocation propagates repository failures", async () => {
  const repository = {
    revokeForVault: async (): Promise<never> => {
      throw new Error("Database unavailable");
    },
  };

  await assert.rejects(
    revokeManagedDeveloperApiKey({
      issuer: owner,
      keyId: "a".repeat(24),
      vault: VAULT_A,
      revokedAt: NOW,
      repository,
    }),
    /Database unavailable/
  );
});

test("listing excludes records belonging to another developer principal", async () => {
  const repository = {
    listByPrincipal: async () => [
      {
        keyId: "a".repeat(24),
        principalId: "another_developer",
        vaults: [VAULT_A],
        scopes: ["activity:read" as const],
        createdAt: NOW,
        expiresAt: null,
        revokedAt: null,
      },
    ],
  };

  const results = await listManagedDeveloperApiKeys({
    issuer: owner,
    principalId: "developer_001",
    vault: VAULT_A,
    repository,
  });

  assert.deepEqual(results, []);
});
