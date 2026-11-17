/**
 * LOCAL DEVNET ONLY: wallet-authorized provisioning for one selected vault.
 *
 * The existing owner-vault login is deliberately read-only. Creating or
 * revoking API credentials requires a SECOND, action-specific Phantom
 * Ed25519 signature. No signature here approves or executes a payment.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { issueDeveloperApiKey } from "./api-key-issuance";
import {
  listManagedDeveloperApiKeys,
  revokeManagedDeveloperApiKey,
} from "./api-key-management";
import type { DeveloperApiKeyRepository } from "./api-key-repository";
import type { ApiPrincipal } from "./api-principal";

type Repository = Pick<
  DeveloperApiKeyRepository,
  "create" | "listByPrincipal" | "revokeForVault"
>;

type Scope = "payments:request" | "activity:read";
type Action =
  | { kind: "issue"; principalId: string; scope: Scope; expiresAt: number }
  | { kind: "revoke"; keyId: string };

type Challenge = {
  owner: string;
  vault: string;
  sessionDigest: string;
  expiresAt: number;
  message: string;
  action: Action;
};

export type SelectedVaultDeveloperKeySession = {
  owner: string;
  vault: string;
};

export type SelectedVaultDeveloperKeyOptions = {
  repository?: Repository;
  expectedGenesisHash: string;
  frontendOrigin: string;
  verifyOwner: (session: SelectedVaultDeveloperKeySession) => Promise<void>;
  now?: () => number;
};

const BASE = "/owner-vault/api/developer-keys";
const CHALLENGE_MS = 90_000;
const MAX_CHALLENGES = 128;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const KEY = /^[a-f0-9]{24}$/;
const NONCE = /^[a-f0-9]{48}$/;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(value));
}

async function readJson(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const contentType = req.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    throw new Error("Unsupported content type");
  }
  let count = 0;
  const chunks: Buffer[] = [];
  for await (const part of req) {
    const buf = Buffer.isBuffer(part) ? part : Buffer.from(part);
    count += buf.length;
    if (count > 2048) throw new Error("Request body too large");
    chunks.push(buf);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid JSON object");
  }
  return body as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, keys: string[]): boolean {
  const found = Object.keys(body).sort();
  return (
    found.length === keys.length &&
    keys.sort().every((key, i) => key === found[i])
  );
}

function canonicalSignature(signature: unknown): Uint8Array | null {
  if (
    typeof signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(signature)
  ) {
    return null;
  }
  const decoded = Buffer.from(signature, "base64");
  return decoded.length === 64 && decoded.toString("base64") === signature
    ? decoded
    : null;
}

function ownerPrincipal(
  session: SelectedVaultDeveloperKeySession
): ApiPrincipal {
  return {
    principalId: `wallet:${session.owner}`,
    role: "owner",
    vaults: [session.vault],
    scopes: [],
  };
}

function parseAction(
  body: Record<string, unknown>,
  now: number
): Action | null {
  if (body.action === "issue") {
    if (
      !exactKeys(body, ["action", "principalId", "scope", "expiresAt"]) ||
      typeof body.principalId !== "string" ||
      !ID.test(body.principalId) ||
      (body.scope !== "payments:request" && body.scope !== "activity:read") ||
      typeof body.expiresAt !== "number" ||
      !Number.isSafeInteger(body.expiresAt) ||
      body.expiresAt <= now + 60_000 ||
      body.expiresAt > now + ONE_DAY_MS
    ) {
      return null;
    }
    return {
      kind: "issue",
      principalId: body.principalId,
      scope: body.scope,
      expiresAt: body.expiresAt,
    };
  }
  if (body.action === "revoke") {
    if (
      !exactKeys(body, ["action", "keyId"]) ||
      typeof body.keyId !== "string" ||
      !KEY.test(body.keyId)
    ) {
      return null;
    }
    return { kind: "revoke", keyId: body.keyId };
  }
  return null;
}

function authorizationMessage(
  session: SelectedVaultDeveloperKeySession,
  sessionDigest: string,
  action: Action,
  nonce: string,
  expiresAt: number,
  genesis: string,
  origin: string
): string {
  return [
    "AgentVault Developer Credential Authorization v1",
    "Network: devnet",
    `Genesis: ${genesis}`,
    `Origin: ${origin}`,
    `Owner: ${session.owner}`,
    `Vault: ${session.vault}`,
    `Session: ${sessionDigest}`,
    `Action: ${action.kind === "issue" ? "ISSUE" : "REVOKE"}`,
    ...(action.kind === "issue"
      ? [
          `Application: ${action.principalId}`,
          `Scope: ${action.scope}`,
          `CredentialExpiresAtMs: ${action.expiresAt}`,
        ]
      : [`KeyId: ${action.keyId}`]),
    `Nonce: ${nonce}`,
    `ChallengeExpiresAtMs: ${expiresAt}`,
    "Purpose: authorize this API credential action only; not a payment approval or transaction",
  ].join("\n");
}

/** Call only from the existing authenticated selected-vault session handler. */
export function createSelectedVaultDeveloperKeyHandler(
  options: SelectedVaultDeveloperKeyOptions
) {
  const {
    repository,
    frontendOrigin,
    expectedGenesisHash,
    verifyOwner,
    now = Date.now,
  } = options;
  const challenges = new Map<string, Challenge>();

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    session: SelectedVaultDeveloperKeySession | null,
    sessionDigest: string | null
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const isList = path === BASE;
    const isChallenge = path === `${BASE}/challenge`;
    const isConfirm = path === `${BASE}/confirm`;

    if (!isList && !isChallenge && !isConfirm) {
      return void sendJson(res, 404, { error: "Endpoint not found" });
    }
    if (req.method !== (isList ? "GET" : "POST")) {
      return void sendJson(res, 405, { error: "Method not allowed" });
    }
    if (!repository) {
      return void sendJson(res, 503, {
        error: "Credential management unavailable",
      });
    }
    if (!session || !sessionDigest || !/^[a-f0-9]{64}$/.test(sessionDigest)) {
      return void sendJson(res, 401, { error: "Owner session required" });
    }
    if (!Number.isSafeInteger(now()) || now() < 0) {
      return void sendJson(res, 503, {
        error: "Credential service unavailable",
      });
    }

    if (!isList && (req.headers.origin !== frontendOrigin || url.search)) {
      return void sendJson(res, 403, { error: "Forbidden origin or query" });
    }

    if (isList) {
      const principalId = url.searchParams.get("principalId");
      if (
        [...url.searchParams.keys()].length !== 1 ||
        !principalId ||
        !ID.test(principalId)
      ) {
        return void sendJson(res, 400, { error: "Invalid principal ID" });
      }
      try {
        await verifyOwner(session);
        const keys = await listManagedDeveloperApiKeys({
          issuer: ownerPrincipal(session),
          principalId,
          vault: session.vault,
          repository,
        });
        return void sendJson(res, 200, { keys });
      } catch {
        return void sendJson(res, 503, {
          error: "Credential listing unavailable",
        });
      }
    }

    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return void sendJson(res, 400, { error: "Invalid request body" });
    }

    if (isChallenge) {
      const action = parseAction(body, now());
      if (!action)
        return void sendJson(res, 400, { error: "Invalid credential action" });
      for (const [nonce, ch] of challenges) {
        if (ch.expiresAt <= now()) challenges.delete(nonce);
      }
      if (challenges.size >= MAX_CHALLENGES) {
        return void sendJson(res, 429, {
          error: "Too many pending challenges",
        });
      }
      try {
        await verifyOwner(session);
        const nonce = randomBytes(24).toString("hex");
        const expiresAt = now() + CHALLENGE_MS;
        const message = authorizationMessage(
          session,
          sessionDigest,
          action,
          nonce,
          expiresAt,
          expectedGenesisHash,
          frontendOrigin
        );
        challenges.set(nonce, {
          owner: session.owner,
          vault: session.vault,
          sessionDigest,
          action,
          expiresAt,
          message,
        });
        return void sendJson(res, 200, { nonce, message, expiresAt });
      } catch {
        return void sendJson(res, 403, {
          error: "Vault authorization unavailable",
        });
      }
    }

    // Confirmation consumes a challenge on any attempted use. An invalid
    // signature or changed session can never be retried with the same nonce.
    if (
      !exactKeys(body, ["nonce", "signature"]) ||
      typeof body.nonce !== "string" ||
      !NONCE.test(body.nonce)
    ) {
      return void sendJson(res, 400, { error: "Invalid authorization" });
    }
    const ch = challenges.get(body.nonce);
    challenges.delete(body.nonce);
    const bytes = canonicalSignature(body.signature);
    if (
      !ch ||
      ch.expiresAt <= now() ||
      ch.owner !== session.owner ||
      ch.vault !== session.vault ||
      ch.sessionDigest !== sessionDigest ||
      !bytes ||
      !nacl.sign.detached.verify(
        Buffer.from(ch.message),
        bytes,
        new PublicKey(ch.owner).toBytes()
      )
    ) {
      return void sendJson(res, 401, { error: "Invalid owner authorization" });
    }
    try {
      await verifyOwner(session);
    } catch {
      return void sendJson(res, 403, {
        error: "Vault authorization unavailable",
      });
    }
    try {
      if (ch.action.kind === "issue") {
        const issued = await issueDeveloperApiKey({
          issuer: ownerPrincipal(session),
          principalId: ch.action.principalId,
          vault: session.vault,
          scopes: [ch.action.scope],
          expiresAt: ch.action.expiresAt,
          now: now(),
          repository,
        });
        // This is the only response containing the secret; never log it.
        return void sendJson(res, 201, {
          ...issued,
          vault: session.vault,
          scope: ch.action.scope,
        });
      }
      const revoked = await revokeManagedDeveloperApiKey({
        issuer: ownerPrincipal(session),
        keyId: ch.action.keyId,
        vault: session.vault,
        revokedAt: now(),
        repository,
      });
      return void sendJson(
        res,
        revoked ? 200 : 404,
        revoked ? { revoked: true } : { error: "Credential not found" }
      );
    } catch {
      return void sendJson(res, 503, {
        error: "Credential operation unavailable",
      });
    }
  };
}
