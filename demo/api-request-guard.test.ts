import test from "node:test";
import assert from "node:assert/strict";

import type { IncomingHttpHeaders } from "node:http";

import { authorizeApiRequest } from "./api-request-guard";
import type { ApiCredentials } from "./api-auth";

const VAULT_A = "11111111111111111111111111111111";
const VAULT_B = "SysvarC1ock11111111111111111111111111111111";

const credentials: ApiCredentials = {
  ownerToken: "a".repeat(64),
  developerToken: "b".repeat(64),
  developerVault: VAULT_A,
};

function request(
  token?: string,
  method = "GET"
): {
  method: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
} {
  if (!token) {
    return {
      method,
      headers: {},
      rawHeaders: [],
    };
  }

  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
    },
    rawHeaders: [
      "Authorization",
      `Bearer ${token}`,
    ],
  };
}

test("health endpoint remains public", () => {
  assert.deepEqual(
    authorizeApiRequest(request(), "/health", credentials, VAULT_A),
    { allowed: true }
  );
});

test("unauthenticated treasury access returns 401", () => {
  assert.deepEqual(
    authorizeApiRequest(request(), "/api/treasury", credentials, VAULT_A),
    {
      allowed: false,
      status: 401,
      error: "Unauthorized",
    }
  );
});

test("developer cannot access treasury", () => {
  assert.deepEqual(
    authorizeApiRequest(
      request(credentials.developerToken),
      "/api/treasury",
      credentials,
      VAULT_A
    ),
    {
      allowed: false,
      status: 403,
      error: "Forbidden",
    }
  );
});

test("developer can access permitted activity for assigned vault", () => {
  assert.deepEqual(
    authorizeApiRequest(
      request(credentials.developerToken),
      "/api/activity",
      credentials,
      VAULT_A
    ),
    { allowed: true }
  );
});

test("developer cannot access a different runtime vault", () => {
  assert.deepEqual(
    authorizeApiRequest(
      request(credentials.developerToken),
      "/api/activity",
      credentials,
      VAULT_B
    ),
    {
      allowed: false,
      status: 403,
      error: "Forbidden",
    }
  );
});

test("owner can access the current treasury", () => {
  assert.deepEqual(
    authorizeApiRequest(
      request(credentials.ownerToken),
      "/api/treasury",
      credentials,
      VAULT_A
    ),
    { allowed: true }
  );
});

test("unknown API endpoints are denied", () => {
  assert.deepEqual(
    authorizeApiRequest(
      request(credentials.ownerToken),
      "/api/unknown",
      credentials,
      VAULT_A
    ),
    {
      allowed: false,
      status: 403,
      error: "Forbidden",
    }
  );
});

test("duplicate Authorization headers are rejected", () => {
  const duplicate = request(credentials.ownerToken);

  duplicate.rawHeaders.push(
    "authorization",
    `Bearer ${credentials.developerToken}`
  );

  assert.deepEqual(
    authorizeApiRequest(
      duplicate,
      "/api/treasury",
      credentials,
      VAULT_A
    ),
    {
      allowed: false,
      status: 401,
      error: "Unauthorized",
    }
  );
});

test("non-GET methods remain rejected", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.deepEqual(
      authorizeApiRequest(
        request(credentials.ownerToken, method),
        "/api/treasury",
        credentials,
        VAULT_A
      ),
      {
        allowed: false,
        status: 405,
        error: "Method not allowed",
      }
    );
  }
});

test("malformed bearer credentials are rejected", () => {
  const malformed = request();

  malformed.headers.authorization = "Bearer invalid";
  malformed.rawHeaders = [
    "Authorization",
    "Bearer invalid",
  ];

  assert.deepEqual(
    authorizeApiRequest(
      malformed,
      "/api/treasury",
      credentials,
      VAULT_A
    ),
    {
      allowed: false,
      status: 401,
      error: "Unauthorized",
    }
  );
});