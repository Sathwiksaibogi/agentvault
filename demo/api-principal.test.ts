import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyPrincipal, isPrincipalRouteAllowed,ApiScope,hasVaultAccess } from "./api-principal";

const RUNTIME_VAULT =
  "11111111111111111111111111111111";

const DEVELOPER_VAULT =
  "SysvarC1ock11111111111111111111111111111111";

test("legacy owner principal has only runtime vault access", () => {
  const principal = createLegacyPrincipal(
    "owner",
    RUNTIME_VAULT,
    DEVELOPER_VAULT
  );

  assert.equal(principal.principalId, "legacy-owner");
  assert.equal(principal.role, "owner");
  assert.deepEqual(principal.vaults, [RUNTIME_VAULT]);

  assert.deepEqual(principal.scopes, [
    "treasury:read",
    "agents:read",
    "workflows:read",
    "activity:read",
  ]);
});

test("legacy developer principal has limited permissions", () => {
  const principal = createLegacyPrincipal(
    "developer",
    RUNTIME_VAULT,
    DEVELOPER_VAULT
  );

  assert.equal(principal.principalId, "legacy-developer");
  assert.equal(principal.role, "developer");

  assert.deepEqual(principal.vaults, [DEVELOPER_VAULT]);
  assert.deepEqual(principal.scopes, ["activity:read"]);
});

test("legacy developer is not automatically assigned runtime vault", () => {
  const principal = createLegacyPrincipal(
    "developer",
    RUNTIME_VAULT,
    DEVELOPER_VAULT
  );

  assert.ok(!principal.vaults.includes(RUNTIME_VAULT));
  assert.ok(!principal.scopes.includes("treasury:read"));
});

test("owner principal requires explicit scopes", () => {
  const principal = createLegacyPrincipal(
    "owner",
    RUNTIME_VAULT,
    DEVELOPER_VAULT
  );

  const restricted = {
    ...principal,
    scopes: ["activity:read"] as const,
  };

  assert.equal(
    isPrincipalRouteAllowed(restricted, "/api/treasury"),
    false
  );

  assert.equal(
    isPrincipalRouteAllowed(restricted, "/api/activity"),
    true
  );
});

test("developer cannot access owner routes with broad scopes", () => {
  const principal = createLegacyPrincipal(
    "developer",
    RUNTIME_VAULT,
    DEVELOPER_VAULT
  );

  const overprivileged = {
    ...principal,
    scopes: [
      "treasury:read",
      "agents:read",
      "workflows:read",
      "activity:read",
    ] as ApiScope[],
  };

  assert.equal(
    isPrincipalRouteAllowed(overprivileged, "/api/treasury"),
    false
  );

  assert.equal(
    isPrincipalRouteAllowed(overprivileged, "/api/workflows"),
    false
  );

  assert.equal(
    isPrincipalRouteAllowed(overprivileged, "/api/activity"),
    true
  );
});

test("vault membership is checked independently of role", () => {
  const principal = createLegacyPrincipal(
    "owner",
    RUNTIME_VAULT,
    DEVELOPER_VAULT
  );

  assert.equal(hasVaultAccess(principal, RUNTIME_VAULT), true);
  assert.equal(hasVaultAccess(principal, DEVELOPER_VAULT), false);
});

test("unknown routes are denied even with all scopes", () => {
  const principal = createLegacyPrincipal(
    "owner",
    RUNTIME_VAULT,
    DEVELOPER_VAULT
  );

  assert.equal(
    isPrincipalRouteAllowed(principal, "/api/unknown"),
    false
  );
});