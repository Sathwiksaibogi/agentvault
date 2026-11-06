import assert from "node:assert/strict";
import { test } from "node:test";

import { authenticateManagementOwner } from "./api-management-auth";

import type { ApiCredentials } from "./api-auth";

const VAULT = "11111111111111111111111111111111";

const credentials: ApiCredentials = {
  ownerToken: "a".repeat(64),
  developerToken: "b".repeat(64),
  developerVault: VAULT,
};

function request(token: string) {
  return {
    headers: {
      authorization: `Bearer ${token}`,
    },
    rawHeaders: ["Authorization", `Bearer ${token}`],
  };
}

test("valid owner credential resolves to trusted owner principal", () => {
  const principal = authenticateManagementOwner(
    request(credentials.ownerToken),
    credentials,
    VAULT
  );

  assert.ok(principal);
  assert.equal(principal.role, "owner");
  assert.equal(principal.principalId, "legacy-owner");
  assert.deepEqual(principal.vaults, [VAULT]);
});

test("developer credential cannot authenticate as management owner", () => {
  assert.equal(
    authenticateManagementOwner(
      request(credentials.developerToken),
      credentials,
      VAULT
    ),
    null
  );
});

test("invalid credentials cannot authenticate as management owner", () => {
  assert.equal(
    authenticateManagementOwner(request("c".repeat(64)), credentials, VAULT),
    null
  );
});

test("duplicate Authorization headers are rejected", () => {
  const req = request(credentials.ownerToken);

  req.rawHeaders.push("authorization", `Bearer ${credentials.ownerToken}`);

  assert.equal(authenticateManagementOwner(req, credentials, VAULT), null);
});

test("missing raw headers fail closed", () => {
  const req = {
    headers: {
      authorization: `Bearer ${credentials.ownerToken}`,
    },
  };

  assert.equal(
    authenticateManagementOwner(
      req as Parameters<typeof authenticateManagementOwner>[0],
      credentials,
      VAULT
    ),
    null
  );
});

test("invalid runtime vaults cannot receive owner authority", () => {
  for (const vault of ["", "invalid-vault", "not-a-public-key"]) {
    assert.equal(
      authenticateManagementOwner(
        request(credentials.ownerToken),
        credentials,
        vault
      ),
      null
    );
  }
});

test("malformed bearer credentials are rejected", () => {
  for (const authorization of [
    `Basic ${credentials.ownerToken}`,
    `bearer ${credentials.ownerToken}`,
    `Bearer  ${credentials.ownerToken}`,
    `Bearer ${credentials.ownerToken} extra`,
  ]) {
    assert.equal(
      authenticateManagementOwner(
        {
          headers: { authorization },
          rawHeaders: ["Authorization", authorization],
        },
        credentials,
        VAULT
      ),
      null
    );
  }
});

test("developer API keys cannot authenticate as management owners", () => {
  const developerApiKey = `avk_${"a".repeat(24)}_${"b".repeat(64)}`;

  assert.equal(
    authenticateManagementOwner(request(developerApiKey), credentials, VAULT),
    null
  );
});

test("authenticated owner receives only the runtime vault", () => {
  const anotherVault = "SysvarRent111111111111111111111111111111111";

  const principal = authenticateManagementOwner(
    request(credentials.ownerToken),
    credentials,
    anotherVault
  );

  assert.ok(principal);
  assert.deepEqual(principal.vaults, [anotherVault]);
  assert.equal(principal.role, "owner");
});
