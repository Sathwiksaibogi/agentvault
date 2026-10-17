/**
 * AgentVault Milestone 10.8A: Localhost-only, signature-verified owner approvals.
 * This module NEVER signs, calls Gemini, or submits token payments.
 * Requires existing api-server.ts to remain bound to 127.0.0.1.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type * as anchor from "@anchor-lang/core";
import { Connection, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { ZodError } from "zod";

import type { Agentvault } from "../target/types/agentvault";
import { webAgents } from "../frontend/src/webAgents";
import { NETWORK, RUNTIME_DIR } from "./runtime-config";
import {
  signedWorkflowSchema,
  verifyWorkflowApproval,
  type ApprovalScope,
} from "./signed-workflow";
import { MAX_PAYMENT_AMOUNT } from "./workflow-policy";
import { getWebVaultDashboard } from "./web-vault-readonly";

const APPROVAL_DIR = join(RUNTIME_DIR, "web-approvals");
const MAX_REQUEST_BYTES = 6_144;
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

type Context = {
  connection: Connection;
  program: anchor.Program<Agentvault>;
  genesisHash: string;
};

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function parseLimitedJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new Error("Expected application/json");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw new Error("Workflow request is too large");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function verifiedChainTime(ctx: Context): Promise<number> {
  assert.equal(NETWORK, "devnet");
  assert.equal(webAgents.network, "devnet");
  assert.equal(ctx.program.programId.toBase58(), webAgents.programId);
  assert.equal(await ctx.connection.getGenesisHash(), ctx.genesisHash);

  const clock = await ctx.connection.getAccountInfo(
    SYSVAR_CLOCK_PUBKEY,
    "confirmed"
  );
  assert.ok(clock && clock.data.length >= 40, "Solana clock unavailable");
  const nowUnix = Number(clock.data.readBigInt64LE(32));
  assert.ok(Number.isSafeInteger(nowUnix));
  return nowUnix;
}

/** Returns true if this module handled the request. */
export async function handleWebWorkflowApi(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: Context
): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1:8787").pathname;

  if (path === "/api/web/workflow-context") {
    if (request.method !== "GET") {
      reply(response, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      const nowUnix = await verifiedChainTime(ctx);
      reply(response, 200, {
        network: "devnet",
        genesisHash: ctx.genesisHash,
        programId: webAgents.programId,
        vault: webAgents.vault,
        owner: webAgents.owner,
        mint: webAgents.mint,
        maxPaymentAmountBaseUnits: MAX_PAYMENT_AMOUNT,
        nowUnix,
      });
    } catch (error) {
      console.error("Workflow context failed:", error);
      reply(response, 503, { error: "Devnet workflow context unavailable" });
    }
    return true;
  }

  if (path !== "/api/web/approve-workflow") return false;
  if (request.method !== "POST") {
    reply(response, 405, { error: "Method not allowed" });
    return true;
  }
  if (NETWORK !== "devnet") {
    reply(response, 404, { error: "Devnet only" });
    return true;
  }

  // Only our local Vite origin may call this local-only API from a browser.
  // Never expose this handler publicly without production authentication,
  // storage and explicit origin policy.
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    reply(response, 403, { error: "Origin not allowed" });
    return true;
  }

  try {
    const signed = signedWorkflowSchema.parse(await parseLimitedJson(request));
    const nowUnix = await verifiedChainTime(ctx);

    const expected: ApprovalScope = {
      network: "devnet",
      genesisHash: ctx.genesisHash,
      programId: webAgents.programId,
      vault: webAgents.vault,
      owner: webAgents.owner,
      mint: webAgents.mint,
    };

    // Reuse EXACTLY the v1 message encoder and owner signature verification.
    const workflow = verifyWorkflowApproval(signed, expected, nowUnix);
    const config = webAgents.agents.find(
      (agent) => agent.id === workflow.assignedAgent
    );
    if (!config) throw new Error("Unknown Vault 2 agent");

    const expectedKind = config.id === "agent-a" ? "procurement" : "operations";
    if (
      workflow.kind !== expectedKind ||
      workflow.agentAuthority !== config.authority ||
      workflow.taskId !== Number(config.taskId) ||
      workflow.recipient !== config.recipient
    ) {
      throw new Error("Workflow does not match registered agent policy");
    }

    // Obtain a fresh on-chain view, not the 30-second dashboard cache.
    const dashboard = await getWebVaultDashboard(
      ctx.connection,
      ctx.program,
      ctx.genesisHash
    );
    const agent = dashboard.agents.find((item) => item.id === config.id);
    if (!agent || !agent.active || !agent.task.active) {
      throw new Error("Selected agent or task is inactive");
    }
    if (dashboard.treasury.paused) throw new Error("Vault is paused");
    if (
      agent.authority !== workflow.agentAuthority ||
      agent.task.recipient !== workflow.recipient ||
      agent.task.taskId !== workflow.taskId
    ) {
      throw new Error("On-chain task no longer matches the approval");
    }
    if (
      BigInt(workflow.amountBaseUnits) >
        BigInt(agent.task.remainingBaseUnits) ||
      BigInt(workflow.amountBaseUnits) >
        BigInt(dashboard.treasury.reservedBaseUnits)
    ) {
      throw new Error("Amount exceeds remaining on-chain task allocation");
    }
    if (
      workflow.expiresAtUnix > Number(agent.task.expiresAtUnix) ||
      workflow.expiresAtUnix > nowUnix + 60 * 60 ||
      workflow.expiresAtUnix <= nowUnix + 60
    ) {
      throw new Error(
        "Approval expiry must be 1–60 minutes from chain time and within task expiry"
      );
    }

    mkdirSync(APPROVAL_DIR, { recursive: true, mode: 0o700 });
    const pathToSave = join(APPROVAL_DIR, `${workflow.requestId}.json`);
    if (existsSync(pathToSave)) {
      reply(response, 409, { error: "Request ID has already been approved" });
      return true;
    }

    // Atomic create: a concurrent request cannot overwrite an approval.
    // No payment is executed. Do not treat local storage as a production DB.
    try {
      writeFileSync(
        pathToSave,
        JSON.stringify(
          {
            signedWorkflow: signed,
            verifiedAtUnix: nowUnix,
            taskNonceAtApproval: agent.task.nextNonce,
            status: "verified_saved_not_executed",
          },
          null,
          2
        ) + "\n",
        { flag: "wx", mode: 0o600 }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        reply(response, 409, { error: "Request ID already exists" });
        return true;
      }
      throw error;
    }

    reply(response, 201, {
      status: "verified_saved_not_executed",
      requestId: workflow.requestId,
      vault: workflow.vault,
      assignedAgent: workflow.assignedAgent,
      amountBaseUnits: workflow.amountBaseUnits,
      expiresAtUnix: workflow.expiresAtUnix,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      reply(response, 400, { error: "Invalid signed workflow schema" });
    } else if (error instanceof SyntaxError) {
      reply(response, 400, { error: "Invalid JSON" });
    } else if (
      error instanceof Error &&
      /too large|Expected application\/json/.test(error.message)
    ) {
      reply(response, 400, { error: error.message });
    } else if (
      error instanceof Error &&
      /scope mismatch|Invalid owner signature|Malformed owner signature|expired|Unknown Vault|does not match|inactive|paused|exceeds|expiry/.test(
        error.message
      )
    ) {
      reply(response, 422, { error: error.message });
    } else {
      console.error("Web approval failed:", error);
      reply(response, 503, { error: "Unable to verify or store approval" });
    }
  }
  return true;
}
