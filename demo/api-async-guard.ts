
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
  type ApiPrincipal,
} from "./api-principal";

import {
  resolveDeveloperApiKey,
  type DeveloperApiKeyLookup,
} from "./api-key-resolver";

import type { ApiGuardResult } from "./api-request-guard";

export type AsyncApiGuardConfig = {
  credentials: ApiCredentials;
  runtimeVault: string;
  lookupDeveloperKey?: DeveloperApiKeyLookup;
  now?: () => number;
};

type ApiRequest = Pick<
  IncomingMessage,
  "method" | "headers" | "rawHeaders"
>;

function extractBearerToken(
  request: ApiRequest
): string | null {
  let authorizationCount = 0;

  for (
    let index = 0;
    index < request.rawHeaders.length;
    index += 2
  ) {
    if (
      request.rawHeaders[index].toLowerCase() ===
      "authorization"
    ) {
      authorizationCount++;
    }
  }

  if (authorizationCount !== 1) {
    return null;
  }

  const authorization = request.headers.authorization;

  if (typeof authorization !== "string") {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization);

  return match?.[1] ?? null;
}

export async function authorizeApiRequestAsync(
  request: ApiRequest,
  pathname: string,
  config: AsyncApiGuardConfig
): Promise<ApiGuardResult> {
  // Preserve the read-only HTTP API contract.
  if (request.method !== "GET") {
    return {
      allowed: false,
      status: 405,
      error: "Method not allowed",
    };
  }

  // Public endpoints do not require authentication.
  if (!requiresApiAuthentication(pathname)) {
    return { allowed: true };
  }

  const token = extractBearerToken(request);

  if (!token) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized",
    };
  }

  let principal: ApiPrincipal | null = null;

  // Check exact legacy credential matches first.
  // This preserves compatibility with legacy tokens
  // that happen to begin with "avk_".
  const role = authenticateApiRequest(
    request.headers,
    config.credentials,
    request.rawHeaders
  );

  if (role) {
    principal = createLegacyPrincipal(
      role,
      config.runtimeVault,
      config.credentials.developerVault
    );
  } else if (token.startsWith("avk_")) {
    // New developer API-key authentication.
    if (!config.lookupDeveloperKey) {
      return {
        allowed: false,
        status: 401,
        error: "Unauthorized",
      };
    }

    try {
      principal = await resolveDeveloperApiKey(
        token,
        config.lookupDeveloperKey,
        config.now?.() ?? Date.now()
      );
    } catch {
      // Credential lookup failures must fail closed.
      return {
        allowed: false,
        status: 401,
        error: "Unauthorized",
      };
    }
  }

  // Reject credentials that did not authenticate.
  if (!principal) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized",
    };
  }

  // Enforce both route permissions and vault access.
  if (
    !isPrincipalRouteAllowed(principal, pathname) ||
    !hasVaultAccess(principal, config.runtimeVault)
  ) {
    return {
      allowed: false,
      status: 403,
      error: "Forbidden",
    };
  }

  return { allowed: true };
}
