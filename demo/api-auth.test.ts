import test from "node:test";
import assert from "node:assert/strict";

import {
  authenticateApiRequest,
  isApiRouteAllowed,
  loadApiCredentials,
  requireApiToken,
  requiresApiAuthentication,
  isVaultAccessAllowed,
  type ApiCredentials,
} from "./api-auth";

const credentials: ApiCredentials = {
  ownerToken: "a".repeat(64),
  developerToken: "b".repeat(64),
  developerVault: "11111111111111111111111111111111",
};

function headers(token: string) {
  return { authorization: `Bearer ${token}` };
}

test("validates both configured credentials", () => {
  assert.equal(requireApiToken(credentials.ownerToken), credentials.ownerToken);

  assert.deepEqual(
    loadApiCredentials({
      AGENTVAULT_OWNER_API_TOKEN: credentials.ownerToken,
      AGENTVAULT_DEVELOPER_API_TOKEN: credentials.developerToken,
      AGENTVAULT_DEVELOPER_VAULT: credentials.developerVault,
    }),
    credentials
  );
});

test("fails closed when credentials are missing or weak", () => {
  assert.throws(() => loadApiCredentials({}));

  assert.throws(() =>
    loadApiCredentials({
      AGENTVAULT_OWNER_API_TOKEN: "short",
      AGENTVAULT_DEVELOPER_API_TOKEN: credentials.developerToken,
    })
  );

  assert.throws(() =>
    loadApiCredentials({
      AGENTVAULT_OWNER_API_TOKEN: credentials.ownerToken,
    })
  );
});

test("rejects identical owner and developer credentials", () => {
  assert.throws(() =>
    loadApiCredentials({
      AGENTVAULT_OWNER_API_TOKEN: credentials.ownerToken,
      AGENTVAULT_DEVELOPER_API_TOKEN: credentials.ownerToken,
    })
  );
});

test("identifies the owner role", () => {
  assert.equal(
    authenticateApiRequest(
      headers(credentials.ownerToken),
      credentials
    ),
    "owner"
  );
});

test("identifies the developer role", () => {
  assert.equal(
    authenticateApiRequest(
      headers(credentials.developerToken),
      credentials
    ),
    "developer"
  );
});

test("rejects missing, invalid and malformed authorization", () => {
  assert.equal(authenticateApiRequest({}, credentials), null);

  for (const authorization of [
    "Bearer " + "c".repeat(64),
    "Basic " + credentials.ownerToken,
    "bearer " + credentials.ownerToken,
    "Bearer  " + credentials.ownerToken,
    "Bearer " + credentials.ownerToken + " extra",
  ]) {
    assert.equal(
      authenticateApiRequest({ authorization }, credentials),
      null
    );
  }
});

test("rejects duplicate Authorization headers", () => {
  assert.equal(
    authenticateApiRequest(
      headers(credentials.ownerToken),
      credentials,
      [
        "Authorization",
        `Bearer ${credentials.ownerToken}`,
        "authorization",
        `Bearer ${credentials.developerToken}`,
      ]
    ),
    null
  );
});

test("rejects malformed authorization header values", () => {
  assert.equal(
    authenticateApiRequest(
      {
        authorization: [credentials.ownerToken],
      } as unknown as import("node:http").IncomingHttpHeaders,
      credentials
    ),
    null
  );
});

test("owner can access known protected endpoints", () => {
  for (const path of [
    "/api/treasury",
    "/api/agents",
    "/api/workflows",
    "/api/workflows/request-123",
    "/api/activity",
  ]) {
    assert.equal(isApiRouteAllowed("owner", path), true);
  }
});

test("developer has only explicitly permitted access", () => {
  assert.equal(isApiRouteAllowed("developer", "/api/activity"), true);

  for (const path of [
    "/api/treasury",
    "/api/agents",
    "/api/workflows",
    "/api/workflows/request-123",
  ]) {
    assert.equal(isApiRouteAllowed("developer", path), false);
  }
});

test("unknown routes are denied by default", () => {
  for (const role of ["owner", "developer"] as const) {
    assert.equal(isApiRouteAllowed(role, "/api/future-endpoint"), false);
    assert.equal(isApiRouteAllowed(role, "/api"), false);
  }
});

test("health remains outside API authentication", () => {
  assert.equal(requiresApiAuthentication("/health"), false);
  assert.equal(requiresApiAuthentication("/api/activity"), true);
  assert.equal(requiresApiAuthentication("/api/treasury"), true);
});

test("developer can access only their assigned vault", () => {
  assert.equal(
    isVaultAccessAllowed(
      "developer",
      credentials,
      credentials.developerVault
    ),
    true
  );

  assert.equal(
    isVaultAccessAllowed(
      "developer",
      credentials,
      "SysvarC1ock11111111111111111111111111111111"
    ),
    false
  );
});

test("owner retains access to the current runtime vault", () => {
  assert.equal(
    isVaultAccessAllowed(
      "owner",
      credentials,
      credentials.developerVault
    ),
    true
  );
});

test("missing developer vault configuration fails closed", () => {
  assert.throws(() =>
    loadApiCredentials({
      AGENTVAULT_OWNER_API_TOKEN: credentials.ownerToken,
      AGENTVAULT_DEVELOPER_API_TOKEN: credentials.developerToken,
    })
  );
});

test("invalid developer vault configuration fails closed", () => {
  assert.throws(() =>
    loadApiCredentials({
      AGENTVAULT_OWNER_API_TOKEN: credentials.ownerToken,
      AGENTVAULT_DEVELOPER_API_TOKEN: credentials.developerToken,
      AGENTVAULT_DEVELOPER_VAULT: "invalid-vault",
    })
  );
});

test("developer cannot bypass owner-only endpoint permissions", () => {
  assert.equal(
    isApiRouteAllowed("developer", "/api/treasury"),
    false
  );

  assert.equal(
    isApiRouteAllowed("developer", "/api/workflows"),
    false
  );
});