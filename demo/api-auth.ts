import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const TOKEN_MIN_LENGTH = 32;

export function requireApiToken(value: string | undefined): string {
  if (!value || value.length < TOKEN_MIN_LENGTH || value.trim() !== value) {
    throw new Error(
      "AGENTVAULT_API_TOKEN must be configured with at least 32 characters"
    );
  }

  return value;
}

export function isAuthorizedApiRequest(
  headers: IncomingHttpHeaders,
  expectedToken: string
): boolean {
  const authorization = headers.authorization;

  if (typeof authorization !== "string") {
    return false;
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization);

  if (!match) {
    return false;
  }

  const providedToken = match[1];

  // Hash both values to fixed-size buffers before comparison.
  // This avoids length-dependent timingSafeEqual errors.
  const providedDigest = createHash("sha256")
    .update(providedToken, "utf8")
    .digest();

  const expectedDigest = createHash("sha256")
    .update(expectedToken, "utf8")
    .digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}

export function requiresApiAuthentication(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}