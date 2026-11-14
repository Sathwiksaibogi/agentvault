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
import {
  existsSync,
  fsyncSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { BorshAccountsCoder } from "@anchor-lang/core";
import BN from "bn.js";
import nacl from "tweetnacl";
import { createSelectedVaultDeveloperKeyHandler } from "./owner-vault-developer-keys";
import type { DeveloperApiKeyRepository } from "./api-key-repository";
import {
  verifyOwnerVaultOnChain,
  type ConfirmedAccountReader,
  type VerifiedOwnerVault,
} from "./owner-vault-verifier";
import type { SelectedVaultAgentsResponse } from "./selected-vault-agent-reader";
import {
  paymentApprovalV2Schema,
  verifyPaymentApprovalV2,
  type PaymentApprovalV2,
} from "./payment-approval-v2";
import {
  verifyWorkflowApprovalV2,
  type WorkflowApprovalV2,
} from "./signed-workflow-v2";

const idlPath = join(process.cwd(), "target/idl/agentvault.json");
const agentVaultIdl = JSON.parse(readFileSync(idlPath, "utf8"));
const accountsCoder = new BorshAccountsCoder(agentVaultIdl);

const COOKIE_NAME = "av_selected_vault_session";
const MAX_CHALLENGES = 128;
const MAX_SESSIONS = 128;
const CHALLENGE_MS = 90_000;
const SESSION_MS = 15 * 60_000;
const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
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
  getAccountInfo(
    address: PublicKey,
    commitment: "confirmed"
  ): Promise<AccountInfo<Buffer> | null>;
}

export interface SelectedVaultActivityResponse {
  network: "devnet";
  vault: string;
  activity: Array<{
    signature: string;
    slot: number;
    blockTimeUnix: number | null;
    agentId: string;
    workflow: string;
    taskId: number;
    taskPda: string;
    succeeded: boolean;
    explorerUrl: string;
  }>;
}

export interface SelectedVaultApprovalsResponse {
  network: "devnet";
  vault: string;
  approvals: Array<{
    requestId: string;
    authorizationModel: "model-b";
    status:
      | "approved_pending_execution"
      | "executed"
      | "pending_owner_approval";
    agentAuthority: string;
    taskId?: string;
    recipient: string;
    amountBaseUnits: string;
    nonce: string;
    expiresAtUnix: string;
    createdAtUnix?: number;
  }>;
}

export interface SelectedVaultSessionOptions {
  fallbackHandler: RequestListener;
  rpc: SelectedVaultRpc;
  network: "localnet" | "devnet";
  expectedGenesisHash: string;
  frontendOrigin: string;
  runtimeDir?: string;
  developerKeyRepository?: Pick<
    DeveloperApiKeyRepository,
    "create" | "listByPrincipal" | "revokeForVault"
  >;
  readScopedAgents?: (
    verified: VerifiedOwnerVault
  ) => Promise<SelectedVaultAgentsResponse>;
  readScopedActivity?: (
    verified: VerifiedOwnerVault
  ) => Promise<SelectedVaultActivityResponse>;
  readScopedApprovals?: (
    verified: VerifiedOwnerVault
  ) => Promise<SelectedVaultApprovalsResponse>;
  readScopedPendingApprovals?: (
    verified: VerifiedOwnerVault
  ) => Promise<ModelBPendingRequest[]>;
  saveScopedPendingApproval?: (
    verified: VerifiedOwnerVault,
    request: ModelBPendingRequest
  ) => Promise<void>;
  saveScopedApproval?: (
    verified: VerifiedOwnerVault,
    approvalData: {
      paymentApproval: PaymentApprovalV2;
      signatureBase64: string;
      signedWorkflow?: unknown;
    }
  ) => Promise<{ requestId: string }>;
  now?: () => number;
}

export type ModelBPendingRequest = {
  requestId: string;
  vault: string;
  agentAuthority: string;
  taskId: string;
  recipient: string;
  amountBaseUnits: string;
  expiresAtUnix: string;
  nonce?: string;
  status: "pending_owner_approval";
  description?: string;
  createdAtUnix?: number;
};

async function findPendingModelBRequest(args: {
  verified: VerifiedOwnerVault;
  requestId: string;
  runtimeDir?: string;
  readScopedPendingApprovals?: (
    v: VerifiedOwnerVault
  ) => Promise<ModelBPendingRequest[]>;
  readScopedApprovals?: (
    v: VerifiedOwnerVault
  ) => Promise<SelectedVaultApprovalsResponse>;
}): Promise<ModelBPendingRequest | null> {
  if (args.readScopedPendingApprovals) {
    const list = await args.readScopedPendingApprovals(args.verified);
    const found = list.find((p) => p.requestId === args.requestId);
    if (found) return found;
  }
  if (args.readScopedApprovals) {
    const resp = await args.readScopedApprovals(args.verified);
    const found = resp.approvals.find(
      (a) =>
        a.requestId === args.requestId &&
        a.status === "pending_owner_approval"
    );
    if (found) {
      return {
        requestId: found.requestId,
        vault: args.verified.vault,
        agentAuthority: found.agentAuthority,
        taskId: found.taskId ?? "1",
        recipient: found.recipient,
        amountBaseUnits: found.amountBaseUnits,
        expiresAtUnix: found.expiresAtUnix,
        status: "pending_owner_approval",
      };
    }
  }
  if (args.runtimeDir) {
    const pendingDir = join(args.runtimeDir, "model-b-pending");
    const pendingPath = join(pendingDir, `${args.requestId}.json`);
    if (existsSync(pendingPath)) {
      try {
        const raw = JSON.parse(readFileSync(pendingPath, "utf8"));
        if (raw.vault === args.verified.vault)
          return raw as ModelBPendingRequest;
      } catch {
        /* ignore corrupt */
      }
    }
    const altPath = join(
      args.runtimeDir,
      "approvals",
      `${args.requestId}.pending.json`
    );
    if (existsSync(altPath)) {
      try {
        const raw = JSON.parse(readFileSync(altPath, "utf8"));
        if (raw.vault === args.verified.vault)
          return raw as ModelBPendingRequest;
      } catch {
        /* ignore corrupt */
      }
    }
  }
  return null;
}

async function getVerifiedTaskOnChain(args: {
  rpc: SelectedVaultRpc;
  taskPda: PublicKey;
  vaultKey: PublicKey;
  agentPda: PublicKey;
  verified: VerifiedOwnerVault;
  readScopedAgents?: (
    v: VerifiedOwnerVault
  ) => Promise<SelectedVaultAgentsResponse>;
}): Promise<{
  recipient: PublicKey;
  budget: bigint;
  spent: bigint;
  nextNonce: bigint;
  expiresAtUnix: bigint;
  active: boolean;
}> {
  const info = await args.rpc.getAccountInfo(args.taskPda, "confirmed");
  if (info && info.data) {
    // 1. Verify account owner is the AgentVault program
    const programKey = new PublicKey(AGENTVAULT_PROGRAM);
    if (info.owner && !info.owner.equals(programKey)) {
      throw new Error("Task account is not owned by the AgentVault program");
    }

    // 2. Determine and verify discriminator via Anchor IDL
    const approvedTaskDisc = accountsCoder.accountDiscriminator("ApprovedTask");
    const legacyTaskDisc = accountsCoder.accountDiscriminator("Task");

    let accountType: "ApprovedTask" | "Task";
    const disc = info.data.subarray(0, 8);
    if (disc.equals(approvedTaskDisc)) {
      accountType = "ApprovedTask";
    } else if (disc.equals(legacyTaskDisc)) {
      accountType = "Task";
    } else {
      throw new Error("Invalid or unrecognized task account discriminator");
    }

    // 3. Decode account data using Anchor BorshAccountsCoder
    let decoded: any;
    try {
      decoded = accountsCoder.decode(accountType, info.data);
    } catch (err) {
      throw new Error(
        `Failed to decode ${accountType} account data: ${(err as Error).message}`
      );
    }

    // 4. Verify decoded fields: vault, agent, active status
    if (!decoded.vault.equals(args.vaultKey)) {
      throw new Error("Task account vault mismatch on-chain");
    }
    if (!decoded.agent.equals(args.agentPda)) {
      throw new Error("Task account agent mismatch on-chain");
    }
    if (!decoded.active) {
      throw new Error("Task account is inactive or revoked on-chain");
    }

    return {
      recipient: decoded.recipient,
      budget: BigInt(decoded.budget.toString()),
      spent: BigInt(decoded.spent.toString()),
      nextNonce: BigInt(decoded.next_nonce.toString()),
      expiresAtUnix: BigInt(decoded.expires_at.toString()),
      active: decoded.active,
    };
  }

  // Fallback to scoped agent inventory if RPC account not found
  if (args.readScopedAgents) {
    const inv = await args.readScopedAgents(args.verified);
    for (const agent of inv.agents) {
      for (const task of agent.tasks) {
        if (task.taskPda === args.taskPda.toBase58()) {
          return {
            recipient: new PublicKey(task.recipient),
            budget: BigInt(task.budgetBaseUnits),
            spent: BigInt(task.spentBaseUnits),
            nextNonce: BigInt(task.nextNonce),
            expiresAtUnix: BigInt(task.expiresAtUnix),
            active: task.active,
          };
        }
      }
    }
  }

  throw new Error("Task account not found or invalid on-chain");
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
  if (typeof value !== "string" || value.length < 32 || value.length > 44)
    return null;
  try {
    return new PublicKey(value).toBase58() === value ? value : null;
  } catch {
    return null;
  }
}

async function jsonBody(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      String(request.headers["content-type"] ?? "")
    )
  ) {
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
  const parts = request.headers.cookie
    .split(";")
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

export function createSelectedVaultSessionHandler(
  options: SelectedVaultSessionOptions
): RequestListener {
  const {
    fallbackHandler,
    rpc,
    network,
    expectedGenesisHash,
    frontendOrigin,
    runtimeDir,
    developerKeyRepository,
    readScopedAgents,
    readScopedActivity,
    readScopedApprovals,
    readScopedPendingApprovals,
    saveScopedPendingApproval,
    saveScopedApproval,
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
    if (
      network !== "devnet" ||
      (await rpc.getGenesisHash()) !== expectedGenesisHash
    ) {
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

  // A signed READ-ONLY login alone cannot authorize key issuance/revocation.
  // These routes demand a separate signature of the exact credential action.
  const developerKeyHandler = createSelectedVaultDeveloperKeyHandler({
    repository: developerKeyRepository,
    frontendOrigin,
    expectedGenesisHash,
    now,
    verifyOwner: async ({ owner, vault }) => {
      await requireDevnet();
      await verifyOwnerVaultOnChain({
        rpc,
        ownerAddress: owner,
        vaultAddress: vault,
      });
    },
  });

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (!path.startsWith("/owner-vault/")) {
      fallbackHandler(req, res);
      return;
    }
    prune();

    if (path === "/owner-vault/auth/challenge") {
      if (req.method !== "GET")
        return void sendJson(res, 405, { error: "Method not allowed" });
      if (
        Array.from(url.searchParams.keys()).length !== 2 ||
        !url.searchParams.has("owner") ||
        !url.searchParams.has("vault")
      ) {
        return void sendJson(res, 400, { error: "Invalid vault selection" });
      }
      const owner = canonicalPubkey(url.searchParams.get("owner"));
      const vault = canonicalPubkey(url.searchParams.get("vault"));
      if (!owner || !vault)
        return void sendJson(res, 400, { error: "Invalid vault selection" });
      if (challenges.size >= MAX_CHALLENGES) {
        return void sendJson(res, 429, { error: "Too many challenges" });
      }
      void (async () => {
        try {
          await requireDevnet();
          await verifyOwnerVaultOnChain({
            rpc,
            ownerAddress: owner,
            vaultAddress: vault,
          });
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
          sendJson(res, 200, {
            ownerPublicKey: owner,
            vaultPublicKey: vault,
            nonce,
            message,
            expiresAt,
          });
        } catch {
          sendJson(res, 403, {
            error: "Vault selection unavailable or unauthorized",
          });
        }
      })();
      return;
    }

    if (path === "/owner-vault/auth/session") {
      if (req.method !== "GET")
        return void sendJson(res, 405, { error: "Method not allowed" });
      if (url.search)
        return void sendJson(res, 400, { error: "Unexpected query" });
      const session = currentSession(req);
      return void sendJson(
        res,
        200,
        session
          ? { authenticated: true, owner: session.owner, vault: session.vault }
          : { authenticated: false }
      );
    }

    if (
      path === "/owner-vault/auth/login" ||
      path === "/owner-vault/auth/logout"
    ) {
      if (req.method !== "POST")
        return void sendJson(res, 405, { error: "Method not allowed" });
      if (url.search)
        return void sendJson(res, 400, { error: "Unexpected query" });
      if (req.headers.origin !== frontendOrigin)
        return void sendJson(res, 403, { error: "Forbidden origin" });
      if (path.endsWith("/logout")) {
        const token = sessionCookie(req);
        if (token) sessions.delete(digest(token));
        return void sendJson(
          res,
          200,
          { authenticated: false },
          { "Set-Cookie": cookie("", 0) }
        );
      }
      void (async () => {
        let body: Record<string, unknown>;
        try {
          body = await jsonBody(req);
        } catch {
          return void sendJson(res, 400, { error: "Invalid login request" });
        }
        const { nonce, publicKey, vault, signature } = body;
        if (
          typeof nonce !== "string" ||
          !/^[a-f0-9]{48}$/.test(nonce) ||
          !canonicalPubkey(publicKey) ||
          !canonicalPubkey(vault) ||
          typeof signature !== "string" ||
          signature.length > 128
        ) {
          return void sendJson(res, 401, { error: "Invalid owner signature" });
        }
        const challenge = challenges.get(nonce);
        challenges.delete(nonce); // replay fails even when verification fails
        if (
          !challenge ||
          challenge.expiresAt <= now() ||
          publicKey !== challenge.owner ||
          vault !== challenge.vault
        ) {
          return void sendJson(res, 401, { error: "Invalid owner signature" });
        }
        const bytes = Buffer.from(signature, "base64");
        if (
          bytes.length !== 64 ||
          bytes.toString("base64") !== signature ||
          !nacl.sign.detached.verify(
            Buffer.from(challenge.message),
            bytes,
            new PublicKey(challenge.owner).toBytes()
          )
        ) {
          return void sendJson(res, 401, { error: "Invalid owner signature" });
        }
        try {
          await requireDevnet();
          await verifyOwnerVaultOnChain({
            rpc,
            ownerAddress: challenge.owner,
            vaultAddress: challenge.vault,
          });
        } catch {
          return void sendJson(res, 403, {
            error: "Vault authorization unavailable",
          });
        }
        if (sessions.size >= MAX_SESSIONS)
          return void sendJson(res, 429, { error: "Too many sessions" });
        const prior = sessionCookie(req);
        if (prior) sessions.delete(digest(prior));
        const token = randomBytes(32).toString("hex");
        sessions.set(digest(token), {
          owner: challenge.owner,
          vault: challenge.vault,
          expiresAt: now() + SESSION_MS,
        });
        sendJson(
          res,
          200,
          {
            authenticated: true,
            owner: challenge.owner,
            vault: challenge.vault,
          },
          { "Set-Cookie": cookie(token, SESSION_MS / 1000) }
        );
      })().catch(() => {
        if (!res.headersSent)
          sendJson(res, 503, { error: "Login unavailable" });
      });
      return;
    }

    if (
      path === "/owner-vault/api/developer-keys" ||
      path.startsWith("/owner-vault/api/developer-keys/")
    ) {
      const session = currentSession(req);
      const token = session ? sessionCookie(req) : null;
      void developerKeyHandler(
        req,
        res,
        session,
        token ? digest(token) : null
      ).catch(() => {
        if (!res.headersSent) {
          sendJson(res, 503, { error: "Credential service unavailable" });
        }
      });
      return;
    }

    if (path === "/owner-vault/api/pending-requests" && req.method === "POST") {
      const session = currentSession(req);
      if (!session) {
        return void sendJson(res, 401, { error: "Owner session required" });
      }
      void (async () => {
        let body: Record<string, unknown>;
        try {
          body = await jsonBody(req);
        } catch {
          return void sendJson(res, 400, { error: "Invalid JSON body" });
        }
        try {
          await requireDevnet();
          const verified = await verifyOwnerVaultOnChain({
            rpc,
            ownerAddress: session.owner,
            vaultAddress: session.vault,
          });
          const requestId = String(body.requestId ?? "");
          if (!/^[a-zA-Z0-9_-]{8,64}$/.test(requestId)) {
            return void sendJson(res, 400, { error: "Invalid request ID" });
          }

          const taskId = body.taskId ? String(body.taskId) : "";
          if (!taskId || !/^(0|[1-9][0-9]*)$/.test(taskId)) {
            return void sendJson(res, 400, {
              error:
                "Missing or invalid taskId; default task IDs are strictly prohibited",
            });
          }

          // Ensure pending requests originate from an authenticated, trusted workflow
          let verifiedWorkflow: WorkflowApprovalV2 | null = null;
          if (body.signedWorkflow) {
            try {
              verifiedWorkflow = verifyWorkflowApprovalV2(
                body.signedWorkflow,
                {
                  network: "devnet",
                  genesisHash: expectedGenesisHash,
                  programId: AGENTVAULT_PROGRAM,
                  vault: verified.vault,
                  owner: verified.owner,
                  mint: verified.mint,
                },
                Math.floor(now() / 1000)
              );
            } catch (wfErr) {
              return void sendJson(res, 400, {
                error: `Workflow verification failed: ${(wfErr as Error).message}`,
              });
            }
            if (verifiedWorkflow.requestId !== requestId) {
              return void sendJson(res, 400, {
                error: "Workflow request ID mismatch",
              });
            }
            if (String(verifiedWorkflow.taskId) !== taskId) {
              return void sendJson(res, 400, {
                error: "Workflow task ID mismatch",
              });
            }
          } else if (runtimeDir) {
            const diskWfPath = join(runtimeDir, "approvals", `${requestId}.json`);
            if (existsSync(diskWfPath)) {
              try {
                const rawWf = JSON.parse(readFileSync(diskWfPath, "utf8"));
                verifiedWorkflow = verifyWorkflowApprovalV2(
                  rawWf,
                  {
                    network: "devnet",
                    genesisHash: expectedGenesisHash,
                    programId: AGENTVAULT_PROGRAM,
                    vault: verified.vault,
                    owner: verified.owner,
                    mint: verified.mint,
                  },
                  Math.floor(now() / 1000)
                );
              } catch (wfErr) {
                return void sendJson(res, 400, {
                  error: `Stored workflow verification failed: ${(wfErr as Error).message}`,
                });
              }
            }
          }

          if (!verifiedWorkflow && !saveScopedPendingApproval) {
            return void sendJson(res, 400, {
              error:
                "Pending request must originate from an authenticated, trusted workflow",
            });
          }

          const recipient = verifiedWorkflow
            ? verifiedWorkflow.recipient
            : String(body.recipient ?? "");
          const amountBaseUnits = verifiedWorkflow
            ? String(verifiedWorkflow.amountBaseUnits)
            : String(body.amountBaseUnits ?? "");
          const expiresAtUnix = verifiedWorkflow
            ? String(verifiedWorkflow.expiresAtUnix)
            : String(body.expiresAtUnix ?? "");
          const agentAuthority = verifiedWorkflow
            ? verifiedWorkflow.agentAuthority
            : String(body.agentAuthority ?? "");

          if (
            !recipient ||
            !amountBaseUnits ||
            !expiresAtUnix ||
            !agentAuthority
          ) {
            return void sendJson(res, 400, {
              error: "Missing required payment parameters",
            });
          }

          const pendingRequest: ModelBPendingRequest = {
            requestId,
            vault: verified.vault,
            agentAuthority,
            taskId,
            recipient,
            amountBaseUnits,
            expiresAtUnix,
            nonce: body.nonce ? String(body.nonce) : undefined,
            status: "pending_owner_approval",
            description:
              verifiedWorkflow?.description ??
              (body.description ? String(body.description) : undefined),
            createdAtUnix: Math.floor(now() / 1000),
          };

          // Immutability and idempotency check
          const existing = await findPendingModelBRequest({
            verified,
            requestId,
            runtimeDir,
            readScopedPendingApprovals,
            readScopedApprovals,
          });
          if (existing) {
            const isIdentical =
              existing.vault === pendingRequest.vault &&
              existing.agentAuthority === pendingRequest.agentAuthority &&
              existing.taskId === pendingRequest.taskId &&
              existing.recipient === pendingRequest.recipient &&
              existing.amountBaseUnits === pendingRequest.amountBaseUnits &&
              existing.expiresAtUnix === pendingRequest.expiresAtUnix &&
              (existing.nonce ?? "") === (pendingRequest.nonce ?? "");
            if (isIdentical) {
              return void sendJson(res, 200, {
                ok: true,
                requestId,
                status: "pending_owner_approval",
                idempotent: true,
              });
            } else {
              return void sendJson(res, 409, {
                error: `Pending request ${requestId} already exists with different immutable terms`,
              });
            }
          }

          if (saveScopedPendingApproval) {
            await saveScopedPendingApproval(verified, pendingRequest);
          } else if (runtimeDir) {
            const pendingDir = join(runtimeDir, "model-b-pending");
            mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
            writeFileSync(
              join(pendingDir, `${requestId}.json`),
              JSON.stringify(pendingRequest, null, 2) + "\n"
            );
          }
          sendJson(res, 201, {
            ok: true,
            requestId,
            status: "pending_owner_approval",
          });
        } catch (err) {
          sendJson(res, 500, {
            error:
              err instanceof Error
                ? err.message
                : "Failed to record pending request",
          });
        }
      })();
      return;
    }

    if (path === "/owner-vault/api/approvals" && req.method === "POST") {
      const session = currentSession(req);
      if (!session) {
        return void sendJson(res, 401, { error: "Owner session required" });
      }
      void (async () => {
        let body: Record<string, unknown>;
        try {
          body = await jsonBody(req);
        } catch {
          return void sendJson(res, 400, { error: "Invalid JSON body" });
        }
        try {
          await requireDevnet();
          const verified = await verifyOwnerVaultOnChain({
            rpc,
            ownerAddress: session.owner,
            vaultAddress: session.vault,
          });

          const paymentInput = body.paymentApproval;
          const signatureBase64 = String(body.signatureBase64 ?? "");
          if (!paymentInput || !signatureBase64) {
            return void sendJson(res, 400, {
              error: "Missing paymentApproval or signature",
            });
          }

          const paymentApproval = paymentApprovalV2Schema.parse(paymentInput);

          // 1. Verify network, genesis hash, program, vault, owner, mint and pause state
          if (paymentApproval.genesisHash !== expectedGenesisHash) {
            return void sendJson(res, 400, {
              error: "Genesis hash mismatch",
            });
          }
          if (paymentApproval.programId !== AGENTVAULT_PROGRAM) {
            return void sendJson(res, 400, {
              error: "Program ID mismatch",
            });
          }
          if (
            paymentApproval.owner !== session.owner ||
            paymentApproval.vault !== session.vault ||
            paymentApproval.vault !== verified.vault
          ) {
            return void sendJson(res, 403, {
              error: "Approval does not match session owner or vault",
            });
          }
          if (paymentApproval.mint !== verified.mint) {
            return void sendJson(res, 400, {
              error: "Token mint mismatch",
            });
          }
          if (verified.paused) {
            return void sendJson(res, 400, {
              error: "Vault is paused on-chain",
            });
          }

          // 2. Bind each owner approval to a real pending Model B request
          const pending = await findPendingModelBRequest({
            verified,
            requestId: paymentApproval.requestId,
            runtimeDir,
            readScopedPendingApprovals,
            readScopedApprovals,
          });
          if (!pending) {
            return void sendJson(res, 404, {
              error: `No pending Model B request found for request ID ${paymentApproval.requestId}`,
            });
          }
          if (
            paymentApproval.recipient !== pending.recipient ||
            paymentApproval.amountBaseUnits !== pending.amountBaseUnits ||
            paymentApproval.agentAuthority !== pending.agentAuthority
          ) {
            return void sendJson(res, 400, {
              error:
                "Approval parameters do not match pending Model B request",
            });
          }

          if (!pending.taskId || !/^(0|[1-9][0-9]*)$/.test(pending.taskId)) {
            return void sendJson(res, 400, {
              error:
                "Pending Model B request has missing or invalid task ID; default task IDs are strictly prohibited",
            });
          }

          if (
            pending.nonce !== undefined &&
            paymentApproval.nonce !== pending.nonce
          ) {
            return void sendJson(res, 400, {
              error: `Nonce mismatch: approval specified ${paymentApproval.nonce}, but pending request specified ${pending.nonce}`,
            });
          }

          if (
            BigInt(paymentApproval.expiresAtUnix) >
            BigInt(pending.expiresAtUnix)
          ) {
            return void sendJson(res, 400, {
              error: "Approval expiry exceeds pending request expiry",
            });
          }

          // 3. Derive and verify expected Agent PDA
          const authorityKey = new PublicKey(paymentApproval.agentAuthority);
          const vaultKey = new PublicKey(verified.vault);
          const programKey = new PublicKey(AGENTVAULT_PROGRAM);
          const [expectedAgentPda] = PublicKey.findProgramAddressSync(
            [
              Buffer.from("agent"),
              vaultKey.toBuffer(),
              authorityKey.toBuffer(),
            ],
            programKey
          );
          if (paymentApproval.agent !== expectedAgentPda.toBase58()) {
            return void sendJson(res, 400, {
              error: "Agent PDA mismatch",
            });
          }

          // 4. Derive expected Task PDA and verify live on-chain task state
          const taskIdNumber = BigInt(pending.taskId);
          const taskIdBytes = Buffer.alloc(8);
          taskIdBytes.writeBigUInt64LE(taskIdNumber);
          const [expectedApprovedTaskPda] = PublicKey.findProgramAddressSync(
            [
              Buffer.from("approved-task"),
              expectedAgentPda.toBuffer(),
              taskIdBytes,
            ],
            programKey
          );
          const [expectedLegacyTaskPda] = PublicKey.findProgramAddressSync(
            [
              Buffer.from("task"),
              expectedAgentPda.toBuffer(),
              taskIdBytes,
            ],
            programKey
          );
          const taskKey = new PublicKey(paymentApproval.task);
          if (
            !taskKey.equals(expectedApprovedTaskPda) &&
            !taskKey.equals(expectedLegacyTaskPda)
          ) {
            return void sendJson(res, 400, {
              error: "Task PDA mismatch for agent and task ID",
            });
          }

          const taskState = await getVerifiedTaskOnChain({
            rpc,
            taskPda: taskKey,
            vaultKey,
            agentPda: expectedAgentPda,
            verified,
            readScopedAgents,
          });

          if (!taskState.active) {
            return void sendJson(res, 400, {
              error: "Task is inactive or revoked on-chain",
            });
          }
          if (
            !taskState.recipient.equals(
              new PublicKey(paymentApproval.recipient)
            )
          ) {
            return void sendJson(res, 400, {
              error: "Recipient does not match on-chain task allowlist",
            });
          }

          // CRITICAL: Derive the nonce from verified current task state instead of hardcoding zero
          if (paymentApproval.nonce !== taskState.nextNonce.toString()) {
            return void sendJson(res, 400, {
              error: `Nonce mismatch: approval specified ${paymentApproval.nonce}, but on-chain task nextNonce is ${taskState.nextNonce}`,
            });
          }

          const amount = BigInt(paymentApproval.amountBaseUnits);
          if (amount <= BigInt(0)) {
            return void sendJson(res, 400, {
              error: "Payment amount must be positive",
            });
          }
          if (amount > taskState.budget - taskState.spent) {
            return void sendJson(res, 400, {
              error: "Payment amount exceeds remaining task budget",
            });
          }
          if (amount > BigInt(verified.totalReservedBaseUnits)) {
            return void sendJson(res, 400, {
              error: "Payment amount exceeds vault reserved balance",
            });
          }

          const expiry = BigInt(paymentApproval.expiresAtUnix);
          const nowUnix = BigInt(Math.floor(now() / 1000));
          if (expiry <= nowUnix) {
            return void sendJson(res, 400, {
              error: "Payment approval has already expired",
            });
          }
          if (expiry > taskState.expiresAtUnix) {
            return void sendJson(res, 400, {
              error: "Payment approval expiry exceeds task expiry",
            });
          }

          // 5. Preserve existing signature verification
          const valid = verifyPaymentApprovalV2(
            paymentApproval,
            signatureBase64,
            new PublicKey(session.owner)
          );
          if (!valid) {
            return void sendJson(res, 400, {
              error: "Invalid owner signature for PaymentApprovalV2",
            });
          }

          if (saveScopedApproval) {
            await saveScopedApproval(verified, {
              paymentApproval,
              signatureBase64,
              signedWorkflow: body.signedWorkflow,
            });
          } else if (runtimeDir) {
            const approvalsDir = join(runtimeDir, "approvals");
            mkdirSync(approvalsDir, { recursive: true, mode: 0o700 });
            const paymentPath = join(
              approvalsDir,
              `${paymentApproval.requestId}.payment.json`
            );
            const payload = {
              version: 2,
              authorizationModel: "model-b",
              paymentApproval,
              signatureBase64,
            };
            const fd = openSync(paymentPath, "wx", 0o600);
            try {
              writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n");
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }

            // Clean up pending file if present in model-b-pending/
            const pendingFile = join(
              runtimeDir,
              "model-b-pending",
              `${paymentApproval.requestId}.json`
            );
            if (existsSync(pendingFile)) {
              try {
                unlinkSync(pendingFile);
              } catch {
                /* ignore */
              }
            }
          }

          sendJson(res, 200, {
            ok: true,
            requestId: paymentApproval.requestId,
            status: "approved_pending_execution",
            notice:
              "PaymentApprovalV2 verified and stored. Live execution coordinator remains disabled.",
          });
        } catch (error) {
          const msg =
            error instanceof Error ? error.message : "Approval failed";
          if (
            msg.includes("already exists") ||
            (error as NodeJS.ErrnoException).code === "EEXIST"
          ) {
            return void sendJson(res, 409, {
              error: "Approval already exists for this request ID",
            });
          }
          sendJson(res, 400, { error: msg });
        }
      })();
      return;
    }

    if (path.startsWith("/owner-vault/api/")) {
      if (req.method !== "GET")
        return void sendJson(res, 405, { error: "Read-only endpoint" });
      if (
        url.search ||
        (path !== "/owner-vault/api/treasury" &&
          path !== "/owner-vault/api/agents" &&
          path !== "/owner-vault/api/activity" &&
          path !== "/owner-vault/api/approvals")
      ) {
        return void sendJson(res, 404, { error: "Endpoint not found" });
      }
      const session = currentSession(req);
      if (!session)
        return void sendJson(res, 401, { error: "Owner session required" });
      void (async () => {
        try {
          await requireDevnet();
          const verified = await verifyOwnerVaultOnChain({
            rpc,
            ownerAddress: session.owner,
            vaultAddress: session.vault,
          });
          if (path === "/owner-vault/api/approvals") {
            if (readScopedApprovals) {
              const data = await readScopedApprovals(verified);
              sendJson(res, 200, data);
              return;
            }
            const approvals: SelectedVaultApprovalsResponse["approvals"] = [];
            if (runtimeDir) {
              const approvalsDir = join(runtimeDir, "approvals");
              if (existsSync(approvalsDir)) {
                for (const file of readdirSync(approvalsDir)) {
                  if (!file.endsWith(".payment.json")) continue;
                  try {
                    const raw = JSON.parse(
                      readFileSync(join(approvalsDir, file), "utf8")
                    );
                    if (
                      raw.paymentApproval &&
                      raw.paymentApproval.vault === verified.vault
                    ) {
                      approvals.push({
                        requestId: raw.paymentApproval.requestId,
                        authorizationModel: "model-b",
                        status: "approved_pending_execution",
                        agentAuthority: raw.paymentApproval.agentAuthority,
                        recipient: raw.paymentApproval.recipient,
                        amountBaseUnits: raw.paymentApproval.amountBaseUnits,
                        nonce: raw.paymentApproval.nonce,
                        expiresAtUnix: raw.paymentApproval.expiresAtUnix,
                      });
                    }
                  } catch {
                    /* skip corrupt */
                  }
                }
              }
              const pendingDir = join(runtimeDir, "model-b-pending");
              if (existsSync(pendingDir)) {
                for (const file of readdirSync(pendingDir)) {
                  if (!file.endsWith(".json")) continue;
                  try {
                    const raw = JSON.parse(
                      readFileSync(join(pendingDir, file), "utf8")
                    );
                    if (raw.vault === verified.vault) {
                      approvals.push({
                        requestId: raw.requestId,
                        authorizationModel: "model-b",
                        status: "pending_owner_approval",
                        agentAuthority: raw.agentAuthority,
                        recipient: raw.recipient,
                        amountBaseUnits: raw.amountBaseUnits,
                        nonce: raw.nonce ?? "0",
                        expiresAtUnix: raw.expiresAtUnix,
                        createdAtUnix: raw.createdAtUnix,
                      });
                    }
                  } catch {
                    /* skip corrupt */
                  }
                }
              }
            }
            if (readScopedPendingApprovals) {
              const pendingList = await readScopedPendingApprovals(verified);
              for (const p of pendingList) {
                if (p.vault === verified.vault) {
                  approvals.push({
                    requestId: p.requestId,
                    authorizationModel: "model-b",
                    status: "pending_owner_approval",
                    agentAuthority: p.agentAuthority,
                    recipient: p.recipient,
                    amountBaseUnits: p.amountBaseUnits,
                    nonce: p.nonce ?? "0",
                    expiresAtUnix: p.expiresAtUnix,
                    createdAtUnix: p.createdAtUnix,
                  });
                }
              }
            }
            sendJson(res, 200, {
              network: "devnet",
              vault: verified.vault,
              approvals,
            });
            return;
          }
          if (path === "/owner-vault/api/activity") {
            if (!readScopedActivity)
              throw new Error("Scoped activity reader unavailable");
            const data = await readScopedActivity(verified);
            if (data.network !== "devnet" || data.vault !== verified.vault) {
              throw new Error(
                "Scoped activity reader returned a different vault"
              );
            }
            sendJson(res, 200, data);
            return;
          }
          if (path === "/owner-vault/api/agents") {
            if (!readScopedAgents)
              throw new Error("Scoped agent reader unavailable");
            const data = await readScopedAgents(verified);
            if (
              data.network !== "devnet" ||
              data.owner !== verified.owner ||
              data.vault !== verified.vault
            ) {
              throw new Error("Scoped agent reader returned a different vault");
            }
            sendJson(res, 200, data);
            return;
          }
          const mintInfo = await rpc.getAccountInfo(
            new PublicKey(verified.mint),
            "confirmed"
          );
          if (
            !mintInfo ||
            mintInfo.executable ||
            !mintInfo.owner.equals(TOKEN_PROGRAM) ||
            mintInfo.data.length !== 82 ||
            mintInfo.data[45] !== 1
          ) {
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
