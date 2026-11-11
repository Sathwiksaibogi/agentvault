/**
 * AgentVault LOCAL DEV dashboard session boundary.
 *
 * A Solana owner wallet signs a fresh, vault-bound challenge. The browser
 * receives only an HttpOnly, short-lived opaque session cookie. A strictly
 * allowlisted read-only gateway calls the existing API with the owner token
 * held exclusively in this server process.
 *
 * Do not expose this as a public service without a separate production
 * deployment/security review (TLS, session storage, rate limiting, etc.).
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

const SESSION_AGE_MS = 15 * 60_000;
const CHALLENGE_AGE_MS = 90_000;
const COOKIE = "av_owner_session";
const MAX_PENDING = 128;
const MAX_SESSIONS = 128;
const READ_PATH = /^\/api\/(?:treasury|agents|activity|workflows(?:\/[a-zA-Z0-9_-]{8,64})?)$/;

type Challenge = { message: string; expiresAt: number };
type Session = { expiresAt: number };

export interface OwnerDashboardSessionOptions {
  apiHandler: RequestListener;
  ownerPublicKey: string;
  vaultPublicKey: string;
  ownerApiToken: string;
  /** Exact origin of the local Vite app. */
  frontendOrigin: string;
  /** Fixed loopback address of the existing read-only API. */
  upstreamOrigin: string;
  now?: () => number;
  upstreamFetch?: typeof fetch;
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers["content-type"] ?? ""))) {
    throw new Error("Invalid content type");
  }
  const bytes: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const buf = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += buf.length;
    if (size > 2048) throw new Error("Oversized body");
    bytes.push(buf);
  }
  return JSON.parse(Buffer.concat(bytes).toString("utf8")) as unknown;
}

function cookieValue(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  const matches = header.split(";").map((s) => s.trim()).filter((s) => s.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createOwnerDashboardSessionHandler(options: OwnerDashboardSessionOptions): RequestListener {
  const {
    apiHandler,
    ownerPublicKey,
    vaultPublicKey,
    ownerApiToken,
    frontendOrigin,
    upstreamOrigin,
    now = Date.now,
    upstreamFetch = fetch,
  } = options;
  const ownerBytes = new PublicKey(ownerPublicKey).toBytes();
  if (new PublicKey(ownerBytes).toBase58() !== ownerPublicKey) throw new Error("Non-canonical owner");
  if (new PublicKey(vaultPublicKey).toBase58() !== vaultPublicKey) throw new Error("Non-canonical vault");
  if (frontendOrigin !== "http://127.0.0.1:5173" || upstreamOrigin !== "http://127.0.0.1:8787") {
    throw new Error("Dashboard session is restricted to the local development origins");
  }
  if (ownerApiToken.length < 32) throw new Error("Invalid owner token");

  const challenges = new Map<string, Challenge>();
  const sessions = new Map<string, Session>();

  function cleanup() {
    const timestamp = now();
    for (const [id, c] of challenges) if (c.expiresAt <= timestamp) challenges.delete(id);
    for (const [id, s] of sessions) if (s.expiresAt <= timestamp) sessions.delete(id);
  }

  function sessionFor(req: IncomingMessage): string | null {
    const token = cookieValue(req);
    if (!token) return null;
    const digest = hash(token);
    const entry = sessions.get(digest);
    if (!entry || entry.expiresAt <= now()) {
      sessions.delete(digest);
      return null;
    }
    return digest;
  }

  const strictCookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=${maxAge}`;

  return (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (!pathname.startsWith("/dashboard/")) {
      apiHandler(req, res);
      return;
    }
    cleanup();
    // Session gateway is deliberately GET-only, except for login/logout.
    if (pathname === "/dashboard/auth/challenge") {
      if (req.method !== "GET") return void json(res, 405, { error: "Method not allowed" });
      if (challenges.size >= MAX_PENDING) return void json(res, 429, { error: "Too many challenges" });
      const nonce = randomBytes(24).toString("hex");
      const expiresAt = now() + CHALLENGE_AGE_MS;
      const message = [
        "AgentVault Owner Dashboard Login v1",
        `Owner: ${ownerPublicKey}`,
        `Vault: ${vaultPublicKey}`,
        `Origin: ${frontendOrigin}`,
        `Nonce: ${nonce}`,
        `ExpiresAtMs: ${expiresAt}`,
        "Purpose: read-only local dashboard session; not a payment approval",
      ].join("\n");
      challenges.set(nonce, { message, expiresAt });
      return void json(res, 200, { nonce, message, ownerPublicKey, expiresAt });
    }

    if (pathname === "/dashboard/auth/session") {
      if (req.method !== "GET") return void json(res, 405, { error: "Method not allowed" });
      return void json(res, 200, { authenticated: sessionFor(req) !== null });
    }

    if (pathname === "/dashboard/auth/login" || pathname === "/dashboard/auth/logout") {
      if (req.method !== "POST") return void json(res, 405, { error: "Method not allowed" });
      // Same-origin browser request; reject external-site submissions.
      if (req.headers.origin !== frontendOrigin) return void json(res, 403, { error: "Forbidden origin" });
      if (pathname.endsWith("/logout")) {
        const key = sessionFor(req);
        if (key) sessions.delete(key);
        return void json(res, 200, { authenticated: false }, { "Set-Cookie": strictCookie("", 0) });
      }
      void (async () => {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          json(res, 400, { error: "Invalid login request" });
          return;
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          json(res, 400, { error: "Invalid login request" });
          return;
        }
        const { nonce, publicKey, signature } = body as Record<string, unknown>;
        if (typeof nonce !== "string" || !/^[a-f0-9]{48}$/.test(nonce) ||
            typeof publicKey !== "string" || publicKey !== ownerPublicKey ||
            typeof signature !== "string" || signature.length > 128) {
          json(res, 401, { error: "Invalid owner signature" });
          return;
        }
        const challenge = challenges.get(nonce);
        // Every verification attempt consumes the challenge, even on failure.
        challenges.delete(nonce);
        if (!challenge || challenge.expiresAt <= now()) {
          json(res, 401, { error: "Invalid owner signature" });
          return;
        }
        const sigBytes = Buffer.from(signature, "base64");
        if (sigBytes.length !== 64 || sigBytes.toString("base64") !== signature ||
            !nacl.sign.detached.verify(Buffer.from(challenge.message, "utf8"), sigBytes, ownerBytes)) {
          json(res, 401, { error: "Invalid owner signature" });
          return;
        }
        if (sessions.size >= MAX_SESSIONS) {
          json(res, 429, { error: "Too many sessions" });
          return;
        }
        const sessionToken = randomBytes(32).toString("hex");
        sessions.set(hash(sessionToken), { expiresAt: now() + SESSION_AGE_MS });
        json(res, 200, { authenticated: true }, { "Set-Cookie": strictCookie(sessionToken, SESSION_AGE_MS / 1000) });
      })().catch(() => {
        if (!res.headersSent) json(res, 500, { error: "Login unavailable" });
      });
      return;
    }

    if (pathname.startsWith("/dashboard/api/")) {
      if (req.method !== "GET") return void json(res, 405, { error: "Read-only endpoint" });
      if (!sessionFor(req)) return void json(res, 401, { error: "Owner session required" });
      const upstreamPath = pathname.slice("/dashboard".length);
      if (!READ_PATH.test(upstreamPath) || (req.url ?? "").includes("?")) {
        return void json(res, 404, { error: "Endpoint not found" });
      }
      void (async () => {
        try {
          const upstream = await upstreamFetch(upstreamOrigin + upstreamPath, {
            method: "GET",
            headers: { Authorization: `Bearer ${ownerApiToken}`, Accept: "application/json" },
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          });
          const raw = await upstream.text();
          if (raw.length > 1024 * 1024) throw new Error("Oversized response");
          const body = JSON.parse(raw) as unknown;
          json(res, upstream.status, body);
        } catch {
          json(res, 503, { error: "Dashboard data unavailable" });
        }
      })();
      return;
    }

    json(res, 404, { error: "Endpoint not found" });
  };
}
