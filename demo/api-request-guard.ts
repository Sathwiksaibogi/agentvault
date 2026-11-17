import type { IncomingMessage } from "node:http";

import {
  authenticateApiRequest,
  requiresApiAuthentication,
  type ApiCredentials,
} from "./api-auth";

import {
  createLegacyPrincipal,
  hasVaultAccess,
  isPrincipalRouteAllowed,
} from "./api-principal";

export type ApiGuardResult =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 | 405; error: string };

export function authorizeApiRequest(
  request: Pick<
    IncomingMessage,
    "method" | "headers" | "rawHeaders"
  >,
  pathname: string,
  credentials: ApiCredentials,
  runtimeVault: string
): ApiGuardResult {
  // Preserve the existing read-only API contract.
  if (request.method !== "GET") {
    return {
      allowed: false,
      status: 405,
      error: "Method not allowed",
    };
  }

  if (!requiresApiAuthentication(pathname)) {
    return { allowed: true };
  }

  const role = authenticateApiRequest(
    request.headers,
    credentials,
    request.rawHeaders
  );

  if (!role) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized",
    };
  }

  const principal = createLegacyPrincipal(
  role,
  runtimeVault,
  credentials.developerVault
);

if (
  !isPrincipalRouteAllowed(principal, pathname) ||
  !hasVaultAccess(principal, runtimeVault)
) {
  return {
    allowed: false,
    status: 403,
    error: "Forbidden",
  };
}

  return { allowed: true };
}