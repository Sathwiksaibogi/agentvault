import assert from "node:assert/strict";
import test from "node:test";

import {
  getApiKeyStatus,
  type DeveloperApiKeyRecord,
} from "./api-key-model";

const NOW = 1_800_000_000_000;

function makeRecord(
  overrides: Partial<DeveloperApiKeyRecord> = {}
): DeveloperApiKeyRecord {
  return {
    keyId: "key_001",
    principalId: "developer_001",
    tokenHash: "example-hash",
    vaults: ["11111111111111111111111111111111"],
    scopes: ["activity:read"],
    createdAt: NOW - 1000,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

test("new credential is active", () => {
  assert.equal(
    getApiKeyStatus(makeRecord(), NOW),
    "active"
  );
});

test("credential expires at expiration boundary", () => {
  assert.equal(
    getApiKeyStatus(
      makeRecord({ expiresAt: NOW }),
      NOW
    ),
    "expired"
  );
});

test("credential is active before expiration", () => {
  assert.equal(
    getApiKeyStatus(
      makeRecord({ expiresAt: NOW + 1000 }),
      NOW
    ),
    "active"
  );
});

test("revoked credential is rejected", () => {
  assert.equal(
    getApiKeyStatus(
      makeRecord({ revokedAt: NOW - 100 }),
      NOW
    ),
    "revoked"
  );
});

test("revocation takes precedence over expiration", () => {
  assert.equal(
    getApiKeyStatus(
      makeRecord({
        expiresAt: NOW - 1000,
        revokedAt: NOW - 500,
      }),
      NOW
    ),
    "revoked"
  );
});

test("future-created credentials fail closed", () => {
  assert.equal(
    getApiKeyStatus(
      makeRecord({ createdAt: NOW + 1000 }),
      NOW
    ),
    "revoked"
  );
});

test("invalid expiration metadata fails closed", () => {
  assert.equal(
    getApiKeyStatus(
      makeRecord({ expiresAt: NOW - 2000 }),
      NOW
    ),
    "revoked"
  );
});

test("invalid current time fails closed", () => {
  assert.equal(
    getApiKeyStatus(makeRecord(), Number.NaN),
    "revoked"
  );
});