import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const TOKEN_MIN_LENGTH = 32;

export type ApiRole = "owner" | "developer";

export type ApiCredentials = {
  ownerToken: string;
  developerToken: string;
};

export function requireApiToken(
  value: string | undefined,
  name = "API token"
): string {
  if (
    !value ||
    value.length < TOKEN_MIN_LENGTH ||
    value.trim() !== value
  ) {
    throw new Error(
      `${name} must contain at least ${TOKEN_MIN_LENGTH} characters`
    );
  }

  return value;
}

export function loadApiCredentials(
  env: NodeJS.ProcessEnv
): ApiCredentials {
  const ownerToken = requireApiToken(
    env.AGENTVAULT_OWNER_API_TOKEN,
    "AGENTVAULT_OWNER_API_TOKEN"
  );

  const developerToken = requireApiToken(
    env.AGENTVAULT_DEVELOPER_API_TOKEN,
    "AGENTVAULT_DEVELOPER_API_TOKEN"
  );

  if (ownerToken === developerToken) {
    throw new Error("Owner and developer API tokens must be different");
  }

  return { ownerToken, developerToken };
}

function matchesToken(
  provided: string,
  expected: string
): boolean {
  const providedDigest = createHash("sha256")
    .update(provided, "utf8")
    .digest();

  const expectedDigest = createHash("sha256")
    .update(expected, "utf8")
    .digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}

export function authenticateApiRequest(
  headers: IncomingHttpHeaders,
  credentials: ApiCredentials,
  rawHeaders?: readonly string[]
): ApiRole | null {
  // Reject duplicate Authorization headers, even when
  // Node normalizes or discards duplicate header values.
  if (rawHeaders) {
    let authorizationCount = 0;

    for (let i = 0; i < rawHeaders.length; i += 2) {
      if (rawHeaders[i].toLowerCase() === "authorization") {
        authorizationCount++;
      }
    }

    if (authorizationCount !== 1) {
      return null;
    }
  }

  const authorization = headers.authorization;

  if (typeof authorization !== "string") {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization);

  if (!match) {
    return null;
  }

  const token = match[1];

  const isOwner = matchesToken(token, credentials.ownerToken);
  const isDeveloper = matchesToken(token, credentials.developerToken);

  if (isOwner && !isDeveloper) return "owner";
  if (isDeveloper && !isOwner) return "developer";

  return null;
}

export function requiresApiAuthentication(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function isApiRouteAllowed(
  role: ApiRole,
  pathname: string
): boolean {
  const ownerRoutes = new Set([
    "/api/treasury",
    "/api/agents",
    "/api/workflows",
    "/api/activity",
  ]);

  if (/^\/api\/workflows\/[a-zA-Z0-9_-]{8,64}$/.test(pathname)) {
    return role === "owner";
  }

  if (role === "owner") {
    return ownerRoutes.has(pathname);
  }

  if (role === "developer") {
    return pathname === "/api/activity";
  }

  return false;
}