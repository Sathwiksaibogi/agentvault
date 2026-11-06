
import assert from "node:assert/strict";
import test from "node:test";

import { authorizeApiRequestAsync } from "./api-async-guard";

import {
  extractDeveloperApiKeyId,
  generateDeveloperApiKey,
  hashDeveloperApiKey,
} from "./api-key-crypto";

import type { DeveloperApiKeyRecord } from "./api-key-model";

const VAULT_A = "11111111111111111111111111111111";
const VAULT_B = "SysvarC1ock11111111111111111111111111111111";

const NOW = 1_800_000_000_000;

const credentials = {
  ownerToken: "a".repeat(64),
  developerToken: "b".repeat(64),
  developerVault: VAULT_A,
};

const token = generateDeveloperApiKey();
const keyId = extractDeveloperApiKeyId(token)!;

function makeRecord(
  overrides: Partial<DeveloperApiKeyRecord> = {}
): DeveloperApiKeyRecord {
  return {
    keyId,
    principalId: "developer_001",
    tokenHash: hashDeveloperApiKey(token),
    vaults: [VAULT_A],
    scopes: ["activity:read"],
    createdAt: NOW - 1000,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function makeRequest(
  bearer?: string,
  method = "GET"
) {
  return {
    method,
    headers: bearer
      ? { authorization: `Bearer ${bearer}` }
      : {},
    rawHeaders: bearer
      ? ["Authorization", `Bearer ${bearer}`]
      : [],
  };
}

function makeConfig(
  record: DeveloperApiKeyRecord | null,
  runtimeVault = VAULT_A
) {
  return {
    credentials,
    runtimeVault,
    lookupDeveloperKey: async (requestedId: string) =>
      requestedId === keyId ? record : null,
    now: () => NOW,
  };
}

test("valid developer key can read assigned-vault activity", async () => {
  assert.deepEqual(
    await authorizeApiRequestAsync(
      makeRequest(token),
      "/api/activity",
      makeConfig(makeRecord())
    ),
    { allowed: true }
  );
});

test("developer key cannot access owner-only treasury", async () => {
  assert.deepEqual(
    await authorizeApiRequestAsync(
      makeRequest(token),
      "/api/treasury",
      makeConfig(makeRecord())
    ),
    {
      allowed: false,
      status: 403,
      error: "Forbidden",
    }
  );
});

test("developer key cannot access another vault", async () => {
  assert.equal(
    (
      await authorizeApiRequestAsync(
        makeRequest(token),
        "/api/activity",
        makeConfig(makeRecord(), VAULT_B)
      )
    ).allowed,
    false
  );
});

test("expired developer key is rejected", async () => {
  assert.deepEqual(
    await authorizeApiRequestAsync(
      makeRequest(token),
      "/api/activity",
      makeConfig(makeRecord({ expiresAt: NOW }))
    ),
    {
      allowed: false,
      status: 401,
      error: "Unauthorized",
    }
  );
});

test("revoked developer key is rejected", async () => {
  assert.equal(
    (
      await authorizeApiRequestAsync(
        makeRequest(token),
        "/api/activity",
        makeConfig(makeRecord({ revokedAt: NOW - 100 }))
      )
    ).allowed,
    false
  );
});

test("credential lookup failures fail closed", async () => {
  const result = await authorizeApiRequestAsync(
    makeRequest(token),
    "/api/activity",
    {
      credentials,
      runtimeVault: VAULT_A,
      lookupDeveloperKey: async () => {
        throw new Error("Database unavailable");
      },
      now: () => NOW,
    }
  );

  assert.deepEqual(result, {
    allowed: false,
    status: 401,
    error: "Unauthorized",
  });
});

test("legacy owner credentials retain existing access", async () => {
  assert.deepEqual(
    await authorizeApiRequestAsync(
      makeRequest(credentials.ownerToken),
      "/api/treasury",
      makeConfig(null)
    ),
    { allowed: true }
  );
});

test("legacy developer credentials retain existing access", async () => {
  assert.deepEqual(
    await authorizeApiRequestAsync(
      makeRequest(credentials.developerToken),
      "/api/activity",
      makeConfig(null)
    ),
    { allowed: true }
  );
});

test("missing credentials are rejected", async () => {
  assert.equal(
    (
      await authorizeApiRequestAsync(
        makeRequest(),
        "/api/activity",
        makeConfig(makeRecord())
      )
    ).allowed,
    false
  );
});

test("duplicate Authorization headers are rejected", async () => {
  const request = makeRequest(token);

  request.rawHeaders.push(
    "Authorization",
    `Bearer ${credentials.ownerToken}`
  );

  assert.equal(
    (
      await authorizeApiRequestAsync(
        request,
        "/api/activity",
        makeConfig(makeRecord())
      )
    ).allowed,
    false
  );
});

test("non-GET methods remain rejected", async () => {
  assert.deepEqual(
    await authorizeApiRequestAsync(
      makeRequest(token, "POST"),
      "/api/activity",
      makeConfig(makeRecord())
    ),
    {
      allowed: false,
      status: 405,
      error: "Method not allowed",
    }
  );
});

test("invalid API key never falls back to legacy credentials", async () => {
  const result = await authorizeApiRequestAsync(
    makeRequest("avk_invalid"),
    "/api/activity",
    makeConfig(makeRecord())
  );

  assert.deepEqual(result, {
    allowed: false,
    status: 401,
    error: "Unauthorized",
  });
});


test("legacy credentials beginning with avk_ remain valid", async () => {
  const prefixedOwnerToken = `avk_${"a".repeat(64)}`;

  const result = await authorizeApiRequestAsync(
    makeRequest(prefixedOwnerToken),
    "/api/treasury",
    {
      ...makeConfig(null),
      credentials: {
        ...credentials,
        ownerToken: prefixedOwnerToken,
      },
    }
  );

  assert.deepEqual(result, { allowed: true });
});
