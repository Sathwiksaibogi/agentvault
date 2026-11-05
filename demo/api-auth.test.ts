import test from "node:test";
import assert from "node:assert/strict";

import {
  isAuthorizedApiRequest,
  requireApiToken,
  requiresApiAuthentication,
} from "./api-auth";

const token = "a".repeat(64);

test("accepts a valid configured token", () => {
  assert.equal(requireApiToken(token), token);
});

test("rejects missing or weak token configuration", () => {
  assert.throws(() => requireApiToken(undefined));
  assert.throws(() => requireApiToken(""));
  assert.throws(() => requireApiToken("short"));
  assert.throws(() => requireApiToken(` ${token}`));
});

test("accepts the correct bearer token", () => {
  assert.equal(
    isAuthorizedApiRequest(
      { authorization: `Bearer ${token}` },
      token
    ),
    true
  );
});

test("rejects requests without authorization", () => {
  assert.equal(isAuthorizedApiRequest({}, token), false);
});

test("rejects an incorrect token", () => {
  assert.equal(
    isAuthorizedApiRequest(
      { authorization: `Bearer ${"b".repeat(64)}` },
      token
    ),
    false
  );
});

test("rejects malformed authorization headers", () => {
  for (const authorization of [
    token,
    `Basic ${token}`,
    `bearer ${token}`,
    `Bearer  ${token}`,
    `Bearer ${token} extra`,
    "Bearer ",
  ]) {
    assert.equal(
      isAuthorizedApiRequest({ authorization }, token),
      false
    );
  }
});

test("rejects non-string authorization headers", () => {
  assert.equal(
    isAuthorizedApiRequest(
      {
        authorization: [token, token],
      } as unknown as import("node:http").IncomingHttpHeaders,
      token
    ),
    false
  );
});

test("protects all API paths but not health", () => {
  assert.equal(requiresApiAuthentication("/health"), false);
  assert.equal(requiresApiAuthentication("/"), false);

  for (const pathname of [
    "/api",
    "/api/treasury",
    "/api/agents",
    "/api/workflows",
    "/api/workflows/request-123",
    "/api/activity",
    "/api/future-endpoint",
  ]) {
    assert.equal(requiresApiAuthentication(pathname), true);
  }

  assert.equal(
    requiresApiAuthentication("/api-public"),
    false
  );
});