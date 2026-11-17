/**
 * DEVNET / LOCAL DEVELOPMENT ONLY — read-only agent discovery.
 * A delivered intent is NOT an execution claim, agent approval or payment.
 * Single-host filesystem scan is deliberately bounded; production requires a
 * transactionally indexed, per-agent PostgreSQL queue and explicit delivery states.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  acknowledgeModelAPaymentIntent,
  validateModelAPaymentIntent,
  type StoredModelAPaymentIntent,
} from "./model-a-payment-intake";

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 4096;
const MAX_RESULTS = 25;
const MAX_CHALLENGES = 128;
const CHALLENGE_TTL_MS = 60_000;
const BASE = "/api/model-a/agent-inbox";
const HEX_SHA256_FILE = /^[0-9a-f]{64}\.json$/;
const NONCE_RE = /^[A-Za-z0-9_-]{32}$/;

type Scope = { vault: string; agentAuthority: string };
type Challenge = Scope & { message: string; expiresAt: number };

export type AgentInboxItem = StoredModelAPaymentIntent;

function canonicalKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) {
    throw new Error("Invalid public key");
  }
  const key = new PublicKey(value);
  if (key.toBase58() !== value) throw new Error("Noncanonical public key");
  return value;
}

function objectWithKeys(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid request body");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) {
    throw new Error("Unexpected request fields");
  }
  return record;
}

/** Discover only this exact signed authority's unexpired requests in its exact vault. */
export function discoverAgentInbox(args: {
  runtimeDir: string;
  vault: string;
  agentAuthority: string;
  nowUnix: number;
}): AgentInboxItem[] {
  const { runtimeDir, nowUnix } = args;
  const vault = canonicalKey(args.vault);
  const agentAuthority = canonicalKey(args.agentAuthority);
  if (!Number.isSafeInteger(nowUnix) || nowUnix < 0)
    throw new Error("Invalid clock");
  const dir = join(runtimeDir, "payment-intent-inbox");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (names.length > MAX_FILES) throw new Error("Inbox scan limit exceeded");
  const found: AgentInboxItem[] = [];
  for (const name of names) {
    if (!HEX_SHA256_FILE.test(name)) throw new Error("Unexpected inbox entry");
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 1 ||
      stat.size > MAX_FILE_BYTES
    ) {
      throw new Error("Invalid inbox file");
    }
    const record = JSON.parse(
      readFileSync(path, "utf8")
    ) as StoredModelAPaymentIntent;
    if (
      !record ||
      record.version !== 1 ||
      record.kind !== "model-a-payment-intent" ||
      record.status !== "received" ||
      record.network !== "devnet" ||
      typeof record.vault !== "string" ||
      typeof record.principalId !== "string" ||
      !Number.isSafeInteger(record.createdAtUnix) ||
      !record.request
    )
      throw new Error("Corrupt inbox record");
    // Enforce on-disk binding even for records addressed to another vault.
    const canonical = validateModelAPaymentIntent(
      record.request,
      record.createdAtUnix
    );
    if (JSON.stringify(canonical) !== JSON.stringify(record.request))
      throw new Error("Noncanonical inbox record");
    const expectedName =
      createHash("sha256")
        .update(JSON.stringify(["devnet", record.vault, canonical.requestId]))
        .digest("hex") + ".json";
    if (expectedName !== name) throw new Error("Inbox filename mismatch");
    if (record.vault !== vault || canonical.agentAuthority !== agentAuthority)
      continue;
    if (BigInt(canonical.expiresAtUnix) <= BigInt(nowUnix)) continue;
    found.push(record);
  }
  found.sort(
    (a, b) =>
      a.createdAtUnix - b.createdAtUnix ||
      a.request.requestId.localeCompare(b.request.requestId)
  );
  // Fail closed instead of silently hiding some actionable messages.
  if (found.length > MAX_RESULTS) throw new Error("Inbox page limit exceeded");
  return found;
}

export type ModelAAgentInboxHttpOptions = {
  fallbackHandler: RequestListener;
  runtimeDir: string;
  network: "devnet" | "localnet";
  expectedGenesisHash: string;
  getGenesisHash: () => Promise<string>;
  /** Must re-read actual on-chain program-owned, active vault+agent accounts. */
  verifyAgent: (scope: Scope) => Promise<void>;
  acknowledgeItem?: (args: {
    vault: string;
    agentAuthority: string;
    requestId: string;
    nowUnix: number;
  }) => Promise<{ acknowledgedAtUnix: number; duplicate: boolean }>;
  now?: () => number;
};

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    throw new Error("Invalid content type");
  }
  let length = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buf.length;
    if (length > 1024) throw new Error("Body too large");
    parts.push(buf);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

function messageFor(scope: Scope, nonce: string, expiresAt: number): string {
  return [
    "AgentVault Agent Inbox v1",
    "Network: devnet",
    `Vault: ${scope.vault}`,
    `Agent authority: ${scope.agentAuthority}`,
    `Action: POLL ${BASE}/poll`,
    `Nonce: ${nonce}`,
    `Expires at (ms): ${expiresAt}`,
  ].join("\n");
}

export function createModelAAgentInboxHttpHandler(
  options: ModelAAgentInboxHttpOptions
): RequestListener {
  const {
    fallbackHandler,
    network,
    runtimeDir,
    expectedGenesisHash,
    getGenesisHash,
    verifyAgent,
    acknowledgeItem,
    now = Date.now,
  } = options;
  const challenges = new Map<string, Challenge>();
  const challengePath = `${BASE}/challenge`;
  const pollPath = `${BASE}/poll`;
  const ackPath = `${BASE}/ack`;
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (
      url.pathname !== challengePath &&
      url.pathname !== pollPath &&
      url.pathname !== ackPath
    ) {
      if (url.pathname.startsWith(`${BASE}/`))
        return void respond(res, 404, { error: "Endpoint not found" });
      return void fallbackHandler(req, res);
    }
    if (req.method !== "POST")
      return void respond(res, 405, { error: "Method not allowed" });
    if (
      url.search ||
      req.headers.origin ||
      req.headers.cookie ||
      req.headers.authorization
    ) {
      return void respond(res, 400, {
        error: "Unsupported browser or query authentication",
      });
    }
    if (network !== "devnet" || !expectedGenesisHash) {
      return void respond(res, 503, { error: "Agent inbox unavailable" });
    }
    void (async () => {
      let body: unknown;
      try {
        body = await jsonBody(req);
      } catch {
        return void respond(res, 400, { error: "Invalid request" });
      }
      if (url.pathname === challengePath) {
        let scope: Scope;
        try {
          const fields = objectWithKeys(body, ["vault", "agentAuthority"]);
          scope = {
            vault: canonicalKey(fields.vault),
            agentAuthority: canonicalKey(fields.agentAuthority),
          };
        } catch {
          return void respond(res, 400, { error: "Invalid agent scope" });
        }
        try {
          if ((await getGenesisHash()) !== expectedGenesisHash)
            throw new Error("Wrong cluster");
        } catch {
          return void respond(res, 503, {
            error: "Devnet verification unavailable",
          });
        }
        for (const [key, value] of challenges)
          if (value.expiresAt <= now()) challenges.delete(key);
        if (challenges.size >= MAX_CHALLENGES)
          return void respond(res, 429, { error: "Too many challenges" });
        const nonce = randomBytes(24).toString("base64url");
        const expiresAt = now() + CHALLENGE_TTL_MS;
        const message = messageFor(scope, nonce, expiresAt);
        challenges.set(nonce, { ...scope, expiresAt, message });
        return void respond(res, 200, {
          nonce,
          message,
          expiresAtUnix: Math.floor(expiresAt / 1000),
        });
      }

      const isAck = url.pathname === ackPath;
      let nonce: string, signature: string, requestId: string | undefined;
      try {
        if (isAck) {
          const fields = objectWithKeys(body, [
            "nonce",
            "signature",
            "requestId",
          ]);
          if (
            typeof fields.nonce !== "string" ||
            !NONCE_RE.test(fields.nonce) ||
            typeof fields.signature !== "string" ||
            typeof fields.requestId !== "string" ||
            !/^[A-Za-z0-9_-]{8,64}$/.test(fields.requestId)
          ) {
            throw new Error("Invalid challenge response");
          }
          nonce = fields.nonce;
          signature = fields.signature;
          requestId = fields.requestId;
        } else {
          const fields = objectWithKeys(body, ["nonce", "signature"]);
          if (
            typeof fields.nonce !== "string" ||
            !NONCE_RE.test(fields.nonce) ||
            typeof fields.signature !== "string"
          ) {
            throw new Error("Invalid challenge response");
          }
          nonce = fields.nonce;
          signature = fields.signature;
        }
      } catch {
        return void respond(res, 400, { error: "Invalid challenge response" });
      }

      // Consume before validating the signature; unsuccessful attempts are not retryable.
      const challenge = challenges.get(nonce);
      challenges.delete(nonce);
      if (!challenge || challenge.expiresAt <= now())
        return void respond(res, 401, { error: "Challenge expired or used" });
      let validSignature = false;
      try {
        const sig = bs58.decode(signature);
        validSignature =
          sig.length === 64 &&
          nacl.sign.detached.verify(
            new TextEncoder().encode(challenge.message),
            sig,
            new PublicKey(challenge.agentAuthority).toBytes()
          );
      } catch {
        /* invalid base58/signature */
      }
      if (!validSignature)
        return void respond(res, 401, { error: "Invalid agent signature" });
      try {
        if ((await getGenesisHash()) !== expectedGenesisHash)
          throw new Error("Wrong cluster");
      } catch {
        return void respond(res, 503, {
          error: "Devnet verification unavailable",
        });
      }
      try {
        await verifyAgent({
          vault: challenge.vault,
          agentAuthority: challenge.agentAuthority,
        });
      } catch {
        return void respond(res, 403, { error: "Agent policy not satisfied" });
      }

      if (isAck && requestId) {
        try {
          const serverNowUnix = Math.floor(now() / 1000);
          const ackResult = acknowledgeItem
            ? await acknowledgeItem({
                vault: challenge.vault,
                agentAuthority: challenge.agentAuthority,
                requestId,
                nowUnix: serverNowUnix,
              })
            : acknowledgeModelAPaymentIntent({
                runtimeDir,
                vault: challenge.vault,
                agentAuthority: challenge.agentAuthority,
                requestId,
                nowUnix: serverNowUnix,
              });
          return void respond(res, 200, {
            network: "devnet",
            vault: challenge.vault,
            agentAuthority: challenge.agentAuthority,
            requestId,
            acknowledgedAtUnix: ackResult.acknowledgedAtUnix,
            duplicate: ackResult.duplicate,
            notice:
              "Durable delivery receipt only: not approved, authorized for execution or paid",
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : "";
          if (
            msg.includes("Payment intent not found") ||
            msg.includes("does not match agent")
          ) {
            return void respond(res, 404, {
              error: "Payment intent not found",
            });
          }
          if (msg.includes("Payment intent expired")) {
            return void respond(res, 410, { error: "Payment intent expired" });
          }
          return void respond(res, 503, {
            error: "Acknowledgment unavailable",
          });
        }
      }

      try {
        const items = discoverAgentInbox({
          runtimeDir,
          vault: challenge.vault,
          agentAuthority: challenge.agentAuthority,
          nowUnix: Math.floor(now() / 1000),
        });
        return void respond(res, 200, {
          network: "devnet",
          vault: challenge.vault,
          agentAuthority: challenge.agentAuthority,
          items,
          notice:
            "Discovery only: not queued, approved, authorized for execution or paid",
        });
      } catch {
        return void respond(res, 503, { error: "Agent inbox unavailable" });
      }
    })().catch(() => {
      if (!res.headersSent)
        respond(res, 503, { error: "Agent inbox unavailable" });
    });
  };
}
