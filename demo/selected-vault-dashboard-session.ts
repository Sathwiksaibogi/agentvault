/**
 * LOCAL DEVELOPMENT ONLY — Phantom owner login for a selected AgentVault vault.
 *
 * Unlike the legacy /dashboard gateway, this never forwards a global owner
 * API token or reads demo-only workflow/agent data. A wallet-signed session
 * scopes a single selected vault, reverified against the canonical on-chain
 * owner, treasury and pinned Devnet genesis before returning treasury data.
 *
 * This is not a production login service (in-memory sessions, no TLS or
 * distributed rate limiter). Never expose it to the public internet.
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  verifyOwnerVaultOnChain,
  type ConfirmedAccountReader,
  type VerifiedOwnerVault,
} from "./owner-vault-verifier";
import type { SelectedVaultAgentsResponse } from "./selected-vault-agent-reader";

const COOKIE_NAME = "av_selected_vault_session";
const MAX_CHALLENGES = 128;
const MAX_SESSIONS = 128;
const CHALLENGE_MS = 90_000;
const SESSION_MS = 15 * 60_000;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const AGENTVAULT_PROGRAM = "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d";

type Challenge = {
  owner: string;
  vault: string;
  expiresAt: number;
  message: string;
};
type Session = { owner: string; vault: string; expiresAt: number };

export interface SelectedVaultRpc extends ConfirmedAccountReader {
  getGenesisHash(): Promise<string>;
  getAccountInfo(address: PublicKey, commitment: "confirmed"):
    Promise<AccountInfo<Buffer> | null>;
}

export interface SelectedVaultSessionOptions {
  fallbackHandler: RequestListener;
  rpc: SelectedVaultRpc;
  network: "localnet" | "devnet";
  expectedGenesisHash: string;
  frontendOrigin: string;
  readScopedAgents?: (verified: VerifiedOwnerVault) => Promise<SelectedVaultAgentsResponse>;
  now?: () => number;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function canonicalPubkey(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return null;
  try {
    return new PublicKey(value).toBase58() === value ? value : null;
  } catch {
    return null;
  }
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(request.headers["content-type"] ?? ""))) {
    throw new Error("Invalid content type");
  }
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of request) {
    const buf = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += buf.length;
    if (length > 2048) throw new Error("Body too large");
    parts.push(buf);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid body");
  }
  return parsed as Record<string, unknown>;
}

function sessionCookie(request: IncomingMessage): string | null {
  if (typeof request.headers.cookie !== "string") return null;
  const parts = request.headers.cookie.split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${COOKIE_NAME}=`));
  if (parts.length !== 1) return null;
  const token = parts[0].slice(COOKIE_NAME.length + 1);
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

function cookie(value: string, ageSeconds: number): string {
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/owner-vault; Max-Age=${ageSeconds}`;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSelectedVaultSessionHandler(options: SelectedVaultSessionOptions): RequestListener {
  const {
    fallbackHandler,
    rpc,
    network,
    expectedGenesisHash,
    frontendOrigin,
    readScopedAgents,
    now = Date.now,
  } = options;
  if (frontendOrigin !== "http://127.0.0.1:5173") {
    throw new Error("Selected-vault login requires the local frontend origin");
  }
  if (typeof expectedGenesisHash !== "string" || !expectedGenesisHash) {
    throw new Error("Missing expected genesis hash");
  }
  const challenges = new Map<string, Challenge>();
  const sessions = new Map<string, Session>();

  async function requireDevnet(): Promise<void> {
    if (network !== "devnet" || (await rpc.getGenesisHash()) !== expectedGenesisHash) {
      throw new Error("Configured Devnet chain mismatch");
    }
  }

  function prune(): void {
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt <= now()) challenges.delete(id);
    }
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now()) sessions.delete(id);
    }
  }

  function currentSession(req: IncomingMessage): Session | null {
    const value = sessionCookie(req);
    if (!value) return null;
    const key = digest(value);
    const entry = sessions.get(key);
    if (!entry || entry.expiresAt <= now()) {
      sessions.delete(key);
      return null;
    }
    return entry;
  }

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (!path.startsWith("/owner-vault/")) {
      fallbackHandler(req, res);
      return;
    }
    prune();

    if (path === "/owner-vault/auth/challenge") {
      if (req.method !== "GET") return void sendJson(res, 405, { error: "Method not allowed" });
      if (Array.from(url.searchParams.keys()).length !== 2 ||
          !url.searchParams.has("owner") || !url.searchParams.has("vault")) {
        return void sendJson(res, 400, { error: "Invalid vault selection" });
      }
      const owner = canonicalPubkey(url.searchParams.get("owner"));
      const vault = canonicalPubkey(url.searchParams.get("vault"));
      if (!owner || !vault) return void sendJson(res, 400, { error: "Invalid vault selection" });
      if (challenges.size >= MAX_CHALLENGES) {
        return void sendJson(res, 429, { error: "Too many challenges" });
      }
      void (async () => {
        try {
          await requireDevnet();
          await verifyOwnerVaultOnChain({ rpc, ownerAddress: owner, vaultAddress: vault });
          const nonce = randomBytes(24).toString("hex");
          const expiresAt = now() + CHALLENGE_MS;
          const message = [
            "AgentVault Selected Vault Dashboard Login v1",
            "Network: devnet",
            `Genesis: ${expectedGenesisHash}`,
            `Program: ${AGENTVAULT_PROGRAM}`,
            `Owner: ${owner}`,
            `Vault: ${vault}`,
            `Origin: ${frontendOrigin}`,
            `Nonce: ${nonce}`,
            `ExpiresAtMs: ${expiresAt}`,
            "Purpose: read-only selected-vault session; not a payment approval",
          ].join("\n");
          challenges.set(nonce, { owner, vault, expiresAt, message });
          sendJson(res, 200, { ownerPublicKey: owner, vaultPublicKey: vault, nonce, message, expiresAt });
        } catch {
          sendJson(res, 403, { error: "Vault selection unavailable or unauthorized" });
        }
      })();
      return;
    }

    if (path === "/owner-vault/auth/session") {
      if (req.method !== "GET") return void sendJson(res, 405, { error: "Method not allowed" });
      if (url.search) return void sendJson(res, 400, { error: "Unexpected query" });
      const session = currentSession(req);
      return void sendJson(res, 200, session ?
        { authenticated: true, owner: session.owner, vault: session.vault } :
        { authenticated: false });
    }

    if (path === "/owner-vault/auth/login" || path === "/owner-vault/auth/logout") {
      if (req.method !== "POST") return void sendJson(res, 405, { error: "Method not allowed" });
      if (url.search) return void sendJson(res, 400, { error: "Unexpected query" });
      if (req.headers.origin !== frontendOrigin) return void sendJson(res, 403, { error: "Forbidden origin" });
      if (path.endsWith("/logout")) {
        const token = sessionCookie(req);
        if (token) sessions.delete(digest(token));
        return void sendJson(res, 200, { authenticated: false }, { "Set-Cookie": cookie("", 0) });
      }
      void (async () => {
        let body: Record<string, unknown>;
        try { body = await jsonBody(req); } catch {
          return void sendJson(res, 400, { error: "Invalid login request" });
        }
        const { nonce, publicKey, vault, signature } = body;
        if (typeof nonce !== "string" || !/^[a-f0-9]{48}$/.test(nonce) ||
            !canonicalPubkey(publicKey) || !canonicalPubkey(vault) ||
            typeof signature !== "string" || signature.length > 128) {
          return void sendJson(res, 401, { error: "Invalid owner signature" });
        }
        const challenge = challenges.get(nonce);
        challenges.delete(nonce); // replay fails even when verification fails
        if (!challenge || challenge.expiresAt <= now() ||
            publicKey !== challenge.owner || vault !== challenge.vault) {
          return void sendJson(res, 401, { error: "Invalid owner signature" });
        }
        const bytes = Buffer.from(signature, "base64");
        if (bytes.length !== 64 || bytes.toString("base64") !== signature ||
            !nacl.sign.detached.verify(Buffer.from(challenge.message), bytes, new PublicKey(challenge.owner).toBytes())) {
          return void sendJson(res, 401, { error: "Invalid owner signature" });
        }
        try {
          await requireDevnet();
          await verifyOwnerVaultOnChain({ rpc, ownerAddress: challenge.owner, vaultAddress: challenge.vault });
        } catch {
          return void sendJson(res, 403, { error: "Vault authorization unavailable" });
        }
        if (sessions.size >= MAX_SESSIONS) return void sendJson(res, 429, { error: "Too many sessions" });
        const prior = sessionCookie(req);
        if (prior) sessions.delete(digest(prior));
        const token = randomBytes(32).toString("hex");
        sessions.set(digest(token), { owner: challenge.owner, vault: challenge.vault, expiresAt: now() + SESSION_MS });
        sendJson(res, 200, { authenticated: true, owner: challenge.owner, vault: challenge.vault },
          { "Set-Cookie": cookie(token, SESSION_MS / 1000) });
      })().catch(() => {
        if (!res.headersSent) sendJson(res, 503, { error: "Login unavailable" });
      });
      return;
    }

    if (path.startsWith("/owner-vault/api/")) {
      if (req.method !== "GET") return void sendJson(res, 405, { error: "Read-only endpoint" });
      if (url.search || (path !== "/owner-vault/api/treasury" && path !== "/owner-vault/api/agents")) {
        return void sendJson(res, 404, { error: "Endpoint not found" });
      }
      const session = currentSession(req);
      if (!session) return void sendJson(res, 401, { error: "Owner session required" });
      void (async () => {
        try {
          await requireDevnet();
          const verified = await verifyOwnerVaultOnChain({
            rpc, ownerAddress: session.owner, vaultAddress: session.vault,
          });
          if (path === "/owner-vault/api/agents") {
            if (!readScopedAgents) throw new Error("Scoped agent reader unavailable");
            const data = await readScopedAgents(verified);
            if (data.network !== "devnet" || data.owner !== verified.owner ||
                data.vault !== verified.vault) {
              throw new Error("Scoped agent reader returned a different vault");
            }
            sendJson(res, 200, data);
            return;
          }
          const mintInfo = await rpc.getAccountInfo(new PublicKey(verified.mint), "confirmed");
          if (!mintInfo || mintInfo.executable || !mintInfo.owner.equals(TOKEN_PROGRAM) ||
              mintInfo.data.length !== 82 || mintInfo.data[45] !== 1) {
            throw new Error("Invalid selected-vault mint");
          }
          const balance = BigInt(verified.treasuryBalanceBaseUnits);
          const reserved = BigInt(verified.totalReservedBaseUnits);
          const treasury = {
            network: "devnet",
            vault: verified.vault,
            owner: verified.owner,
            tokenMint: verified.mint,
            treasury: verified.treasury,
            vaultId: verified.vaultId,
            decimals: mintInfo.data[44],
            paused: verified.paused,
            balanceBaseUnits: balance.toString(),
            reservedBaseUnits: reserved.toString(),
            availableBaseUnits: (balance - reserved).toString(),
          };
          sendJson(res, 200, treasury);
        } catch {
          sendJson(res, 503, { error: "Selected vault data unavailable" });
        }
      })();
      return;
    }

    sendJson(res, 404, { error: "Endpoint not found" });
  };
}
