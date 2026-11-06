
import assert from "node:assert/strict";
import test from "node:test";

import {
  generateDeveloperApiKey,
  extractDeveloperApiKeyId,
  hashDeveloperApiKey,
} from "./api-key-crypto";

import {
  resolveDeveloperApiKey,
  type DeveloperApiKeyLookup,
} from "./api-key-resolver";

import type { DeveloperApiKeyRecord } from "./api-key-model";

const NOW = 1_800_000_000_000;
const VAULT = "11111111111111111111111111111111";

const token = generateDeveloperApiKey();
const keyId = extractDeveloperApiKeyId(token)!;

function makeRecord(
  overrides: Partial<DeveloperApiKeyRecord> = {}
): DeveloperApiKeyRecord {
  return {
    keyId,
    principalId: "developer_001",
    tokenHash: hashDeveloperApiKey(token),
    vaults: [VAULT],
    scopes: ["activity:read"],
    createdAt: NOW - 1000,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function lookupRecord(
  record: DeveloperApiKeyRecord | null
): DeveloperApiKeyLookup {
  return async (requestedId) =>
    requestedId === keyId ? record : null;
}

test("valid key resolves to scoped developer principal", async () => {
  const principal = await resolveDeveloperApiKey(
    token,
    lookupRecord(makeRecord()),
    NOW
  );

  assert.deepEqual(principal, {
    principalId: "developer_001",
    role: "developer",
    vaults: [VAULT],
    scopes: ["activity:read"],
  });
});

test("unknown key is rejected", async () => {
  assert.equal(
    await resolveDeveloperApiKey(token, lookupRecord(null), NOW),
    null
  );
});

test("expired key is rejected", async () => {
  assert.equal(
    await resolveDeveloperApiKey(
      token,
      lookupRecord(makeRecord({ expiresAt: NOW })),
      NOW
    ),
    null
  );
});

test("revoked key is rejected", async () => {
  assert.equal(
    await resolveDeveloperApiKey(
      token,
      lookupRecord(makeRecord({ revokedAt: NOW - 100 })),
      NOW
    ),
    null
  );
});

test("incorrect key secret is rejected", async () => {
  const other = generateDeveloperApiKey();
  const otherSecret = other.split("_")[2];
  const forged = `avk_${keyId}_${otherSecret}`;

  assert.equal(
    await resolveDeveloperApiKey(
      forged,
      lookupRecord(makeRecord()),
      NOW
    ),
    null
  );
});

test("owner-level scopes are rejected", async () => {
  assert.equal(
    await resolveDeveloperApiKey(
      token,
      lookupRecord(
        makeRecord({
          scopes: ["treasury:read", "activity:read"],
        })
      ),
      NOW
    ),
    null
  );
});

test("missing vault grants are rejected", async () => {
  assert.equal(
    await resolveDeveloperApiKey(
      token,
      lookupRecord(makeRecord({ vaults: [] })),
      NOW
    ),
    null
  );
});

test("malformed keys never trigger lookup", async () => {
  let lookupCalled = false;

  const result = await resolveDeveloperApiKey(
    "invalid",
    async () => {
      lookupCalled = true;
      return makeRecord();
    },
    NOW
  );

  assert.equal(result, null);
  assert.equal(lookupCalled, false);
});

test("invalid vault addresses are rejected", async () => {
  assert.equal(
    await resolveDeveloperApiKey(
      token,
      lookupRecord(
        makeRecord({ vaults: ["not-a-vault"] })
      ),
      NOW
    ),
    null
  );
});

test("empty principal identity is rejected", async () => {
  assert.equal(
    await resolveDeveloperApiKey(
      token,
      lookupRecord(
        makeRecord({ principalId: "" })
      ),
      NOW
    ),
    null
  );
});

test("lookup returning a different key ID is rejected", async () => {
  const result = await resolveDeveloperApiKey(
    token,
    async () =>
      makeRecord({
        keyId: "f".repeat(24),
      }),
    NOW
  );

  assert.equal(result, null);
});