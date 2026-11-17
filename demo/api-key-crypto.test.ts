import assert from "node:assert/strict";
import test from "node:test";

import {
  generateDeveloperApiKey,
  hashDeveloperApiKey,
  verifyDeveloperApiKey,
  extractDeveloperApiKeyId,
} from "./api-key-crypto";

import type { DeveloperApiKeyRecord } from "./api-key-model";

const NOW = 1_800_000_000_000;

function makeRecord(
  token: string,
  overrides: Partial<DeveloperApiKeyRecord> = {}
): DeveloperApiKeyRecord {
  return {
    keyId: extractDeveloperApiKeyId(token)!,
    principalId: "developer_001",
    tokenHash: hashDeveloperApiKey(token),
    vaults: ["11111111111111111111111111111111"],
    scopes: ["activity:read"],
    createdAt: NOW - 1000,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}


test("generates correctly formatted unique API keys", () => {
  const first = generateDeveloperApiKey();
  const second = generateDeveloperApiKey();

  assert.match(first, /^avk_[a-f0-9]{24}_[a-f0-9]{64}$/);
  assert.match(second, /^avk_[a-f0-9]{24}_[a-f0-9]{64}$/);
  assert.notEqual(first, second);

  assert.notEqual(
    extractDeveloperApiKeyId(first),
    extractDeveloperApiKeyId(second)
  );
});

test("extracts the public key identifier", () => {
  const token = generateDeveloperApiKey();
  const keyId = extractDeveloperApiKeyId(token);

  assert.ok(keyId);
  assert.equal(keyId.length, 24);
});

test("rejects a credential with a mismatched key identifier", () => {
  const token = generateDeveloperApiKey();
  const record = makeRecord(token, {
    keyId: "0".repeat(24),
  });

  assert.equal(
    verifyDeveloperApiKey(token, record, NOW),
    false
  );
});

test("rejects malformed key identifiers", () => {
  assert.equal(
    extractDeveloperApiKeyId("avk_invalid_secret"),
    null
  );
});


test("valid API key matches its stored verifier", () => {
  const token = generateDeveloperApiKey();
  const record = makeRecord(token);

  assert.equal(
    verifyDeveloperApiKey(token, record, NOW),
    true
  );
});

test("incorrect API key is rejected", () => {
  const token = generateDeveloperApiKey();
  const other = generateDeveloperApiKey();

  assert.equal(
    verifyDeveloperApiKey(other, makeRecord(token), NOW),
    false
  );
});

test("expired API key is rejected", () => {
  const token = generateDeveloperApiKey();

  assert.equal(
    verifyDeveloperApiKey(
      token,
      makeRecord(token, { expiresAt: NOW }),
      NOW
    ),
    false
  );
});

test("revoked API key is rejected", () => {
  const token = generateDeveloperApiKey();

  assert.equal(
    verifyDeveloperApiKey(
      token,
      makeRecord(token, { revokedAt: NOW - 100 }),
      NOW
    ),
    false
  );
});

test("malformed API key is rejected", () => {
  const token = generateDeveloperApiKey();

  assert.equal(
    verifyDeveloperApiKey("invalid-key", makeRecord(token), NOW),
    false
  );
});

test("malformed stored hash is rejected", () => {
  const token = generateDeveloperApiKey();

  assert.equal(
    verifyDeveloperApiKey(
      token,
      makeRecord(token, { tokenHash: "invalid" }),
      NOW
    ),
    false
  );
});