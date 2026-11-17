import type { IncomingMessage } from "node:http";
import { PublicKey } from "@solana/web3.js";

import { authenticateApiRequest, type ApiCredentials } from "./api-auth";

import { createLegacyPrincipal, type ApiPrincipal } from "./api-principal";

type ManagementAuthRequest = Pick<IncomingMessage, "headers" | "rawHeaders">;

function isCanonicalVault(value: string): boolean {
  if (typeof value !== "string") {
    return false;
  }

  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

export function authenticateManagementOwner(
  request: ManagementAuthRequest,
  credentials: ApiCredentials,
  runtimeVault: string
): ApiPrincipal | null {
  // Management authentication requires raw headers so
  // duplicate Authorization headers cannot be hidden
  // by HTTP header normalization.
  if (!Array.isArray(request.rawHeaders)) {
    return null;
  }

  // Never construct an owner principal for an invalid
  // or non-canonical vault address.
  if (!isCanonicalVault(runtimeVault)) {
    return null;
  }

  const role = authenticateApiRequest(
    request.headers,
    credentials,
    request.rawHeaders
  );

  if (role !== "owner") {
    return null;
  }

  // The owner identity is constructed internally,
  // never accepted from client-supplied request data.
  return createLegacyPrincipal(
    "owner",
    runtimeVault,
    credentials.developerVault
  );
}
