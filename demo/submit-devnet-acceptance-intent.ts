/**
 * AgentVault — Submits a single Model A payment intent for Task #3 acceptance.
 *
 * SAFETY GUARANTEES:
 * - Uses existing AgentVaultClient.submitModelAPaymentIntent().
 * - Reuses existing developer API credentials securely; never prints tokens.
 * - Dynamically checks Devnet on-chain clock and ensures expiry is strictly
 *   before Task #3's on-chain expiry (1795061262).
 * - Generates a fresh unique request ID.
 * - Submits INTENT only; never claims, signs, authorizes, or broadcasts payment.
 *
 * Usage:
 *   npx tsx demo/submit-devnet-acceptance-intent.ts [--dry-run]
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import dotenv from "dotenv";
import { AgentVaultClient } from "../sdk/src/index.js";
import { DEVNET_GENESIS_HASH } from "./devnet-acceptance-preflight.js";

// Acceptance parameters pinned to Devnet Task #3
export const DEVNET_ACCEPTANCE_VAULT = "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U";
export const DEVNET_ACCEPTANCE_AGENT_AUTHORITY = "AeP6wgJ1BktbP7q4MyEuKbuXXbQJgoLgMtgbGDi7hp8L";
export const DEVNET_ACCEPTANCE_TASK_ID = "3";
export const DEVNET_ACCEPTANCE_TASK_PDA = "83hhHmdgQG1vjYiUNtKCgyuQbC3ffWgEggp94iuvbKf1";
export const DEVNET_ACCEPTANCE_RECIPIENT = "DmSyacb7BBjtUYFB76uk4K3YyQbHVwb38tn4uj7JuEVT";
export const DEVNET_ACCEPTANCE_AMOUNT = "1000";
export const DEVNET_TASK_3_EXPIRY_UNIX = 1795061262; // 2026-11-19T04:07:42.000Z

export function resolveDeveloperToken(): string {
  const token =
    process.env.AGENTVAULT_DEVELOPER_API_KEY ||
    process.env.AGENTVAULT_DEVELOPER_API_TOKEN;
  if (token) return token;

  const cfgPath = join(homedir(), ".config/agentvault/api.env");
  if (existsSync(cfgPath)) {
    const envConfig = dotenv.parse(readFileSync(cfgPath, "utf8"));
    if (envConfig.AGENTVAULT_DEVELOPER_API_KEY) {
      return envConfig.AGENTVAULT_DEVELOPER_API_KEY;
    }
    if (envConfig.AGENTVAULT_DEVELOPER_API_TOKEN) {
      return envConfig.AGENTVAULT_DEVELOPER_API_TOKEN;
    }
  }
  throw new Error(
    "AGENTVAULT_DEVELOPER_API_KEY or AGENTVAULT_DEVELOPER_API_TOKEN not found in environment or ~/.config/agentvault/api.env"
  );
}

export function generateAcceptanceRequestId(): string {
  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const entropy = randomBytes(4).toString("hex");
  return `req_devnet_acc_${timestamp}_${entropy}`;
}

export async function submitAcceptancePaymentIntent(options?: {
  requestId?: string;
  apiUrl?: string;
  rpcUrl?: string;
  dryRun?: boolean;
}): Promise<{
  requestId: string;
  status: string;
  taskId: string;
  amountBaseUnits: string;
  recipient: string;
  expiresAtUnix: string;
}> {
  const rpcUrl = options?.rpcUrl ?? process.env.AGENTVAULT_RPC_URL ?? "https://api.devnet.solana.com";
  const apiUrl = options?.apiUrl ?? process.env.AGENTVAULT_API_URL ?? "http://127.0.0.1:8787";
  const token = resolveDeveloperToken();

  // 1. Verify cluster connection & Devnet genesis hash
  const connection = new Connection(rpcUrl, "confirmed");
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `Genesis hash mismatch: expected pinned Devnet ${DEVNET_GENESIS_HASH}, got ${genesisHash}`
    );
  }

  // 2. Read on-chain clock
  const clockInfo = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!clockInfo || clockInfo.data.length < 40) {
    throw new Error("Failed to read Devnet cluster clock");
  }
  const chainTime = Number(clockInfo.data.readBigInt64LE(32));

  // Set expiry: 2 hours from current cluster clock, strictly capped at Task #3 expiry
  const targetExpiry = Math.min(chainTime + 7200, DEVNET_TASK_3_EXPIRY_UNIX - 600);
  if (targetExpiry <= chainTime) {
    throw new Error(
      `Task #3 is too close to expiry or already expired (chainTime: ${chainTime}, taskExpiry: ${DEVNET_TASK_3_EXPIRY_UNIX})`
    );
  }

  const requestId = options?.requestId ?? generateAcceptanceRequestId();
  const expiresAtUnix = String(targetExpiry);

  const requestPayload = {
    requestId,
    agentAuthority: DEVNET_ACCEPTANCE_AGENT_AUTHORITY,
    taskId: DEVNET_ACCEPTANCE_TASK_ID,
    recipient: DEVNET_ACCEPTANCE_RECIPIENT,
    amountBaseUnits: DEVNET_ACCEPTANCE_AMOUNT,
    expiresAtUnix,
    reason: `Supervised Model A acceptance payment for Task #3 (${requestId})`,
  };

  if (options?.dryRun) {
    console.log("=== DRY RUN (Intent not submitted) ===");
    console.log(`Request ID:        ${requestPayload.requestId}`);
    console.log(`Vault:             ${DEVNET_ACCEPTANCE_VAULT}`);
    console.log(`Task ID:           ${requestPayload.taskId}`);
    console.log(`Recipient:         ${requestPayload.recipient}`);
    console.log(`Amount:            ${requestPayload.amountBaseUnits} base units`);
    console.log(`Cluster Clock:     ${new Date(chainTime * 1000).toISOString()}`);
    console.log(`Intent Expiry:     ${new Date(targetExpiry * 1000).toISOString()}`);
    console.log(`Task #3 Expiry:    ${new Date(DEVNET_TASK_3_EXPIRY_UNIX * 1000).toISOString()}`);
    return {
      ...requestPayload,
      status: "dry_run_validated",
    };
  }

  // 3. Submit intent via AgentVaultClient
  const client = new AgentVaultClient({
    baseUrl: apiUrl,
    token,
  });

  const response = await client.submitModelAPaymentIntent(requestPayload);

  return {
    requestId: response.requestId,
    status: response.status,
    taskId: DEVNET_ACCEPTANCE_TASK_ID,
    amountBaseUnits: DEVNET_ACCEPTANCE_AMOUNT,
    recipient: DEVNET_ACCEPTANCE_RECIPIENT,
    expiresAtUnix,
  };
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes("--dry-run");
  const result = await submitAcceptancePaymentIntent({ dryRun: isDryRun });

  console.log("====================================================");
  console.log("   AgentVault Model A Devnet Payment Intent         ");
  console.log("====================================================");
  console.log(`Status:            ${result.status.toUpperCase()}`);
  console.log(`Request ID:        ${result.requestId}`);
  console.log(`Task ID:           ${result.taskId}`);
  console.log(`Amount:            ${result.amountBaseUnits} base units`);
  console.log(`Recipient:         ${result.recipient}`);
  console.log(`Expires At:        ${new Date(Number(result.expiresAtUnix) * 1000).toISOString()}`);
  console.log("====================================================");
  if (!isDryRun) {
    console.log("\nNext step: Acknowledge delivery using demo/agent-inbox-poll-once.ts:");
    console.log(
      `  AGENTVAULT_ACK_REQUEST_ID=${result.requestId} npx tsx demo/agent-inbox-poll-once.ts\n`
    );
  }
}

if (process.argv[1]?.endsWith("submit-devnet-acceptance-intent.ts")) {
  main().catch((err) => {
    console.error("Submission error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
