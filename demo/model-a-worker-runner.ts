/**
 * Standalone Model A Autonomous Worker Entrypoint.
 *
 * Reuses the existing ModelAWorker implementation to poll for eligible,
 * delivery-acknowledged payment intents with authenticated agent decisions.
 *
 * Safety defaults:
 * - Defaults to non-broadcasting mode (simulated/mock).
 * - Live Devnet broadcasting strictly requires AGENTVAULT_WORKER_MODE=live_devnet
 *   AND AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST=true.
 * - Handles SIGINT / SIGTERM for graceful shutdown.
 * - Uses existing API/inbox/journal durable storage.
 *
 * Usage:
 *   pnpm worker:model-a
 *   # or:
 *   npx tsx demo/model-a-worker-runner.ts
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { Agentvault } from "../target/types/agentvault";
import {
  ModelAWorker,
  encodeAgentPaymentDecision,
  type ModelAExecutionAdapter,
  type ModelAWorkerOptions,
} from "./model-a-worker";
import { isModelAPaymentIntentAcknowledged } from "./model-a-payment-intake";
import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";

export const PINNED_DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function loadOptionalAgentSigner(keyPath?: string): Keypair | undefined {
  if (!keyPath) return undefined;
  assert.ok(isAbsolute(keyPath), "Agent keypair path must be absolute");
  assert.ok(existsSync(keyPath), `Agent keypair file does not exist: ${keyPath}`);
  const st = statSync(keyPath);
  assert.ok((st.mode & 0o077) === 0, "Agent keypair file permissions must be 0600 (owner only)");
  const secret = JSON.parse(readFileSync(keyPath, "utf8")) as unknown;
  assert.ok(
    Array.isArray(secret) &&
      secret.length === 64 &&
      secret.every((n) => Number.isInteger(n) && n >= 0 && n <= 255),
    "Invalid agent keypair format (expected 64-byte array)"
  );
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function resolveWorkerConfig(): {
  runtimeDir: string;
  vault: string;
  mode: "simulated" | "preview" | "live_devnet";
  rpcUrl: string;
  pollIntervalMs: number;
  expectedGenesisHash?: string;
  agentSigner?: Keypair;
  targetRequest?: {
    requestId: string;
    taskPda: string;
    amountBaseUnits: string;
    maxExecutions?: number;
  };
} {
  const runtimeDir = process.env.AGENTVAULT_RUNTIME_DIR || RUNTIME_DIR;
  const mode = (process.env.AGENTVAULT_WORKER_MODE || "simulated") as
    | "simulated"
    | "preview"
    | "live_devnet";

  assert.ok(
    mode === "simulated" || mode === "preview" || mode === "live_devnet",
    `Invalid AGENTVAULT_WORKER_MODE: ${mode}. Must be simulated, preview, or live_devnet`
  );

  let vault = process.env.AGENTVAULT_VAULT || process.env.AGENTVAULT_DEVELOPER_VAULT;
  let expectedGenesisHash = process.env.AGENTVAULT_GENESIS_HASH;

  // Attempt to resolve vault from state.json if not set in environment
  const statePath = join(runtimeDir, "state.json");
  if (!vault && existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.vault) vault = state.vault;
      if (state.genesisHash && !expectedGenesisHash) expectedGenesisHash = state.genesisHash;
    } catch {
      /* ignore */
    }
  }

  // Fallback default devnet demo vault if none supplied
  if (!vault) {
    vault = "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U";
  }

  const rpcUrl = RPC_URL;
  const pollIntervalMs = Math.max(
    500,
    parseInt(process.env.AGENTVAULT_POLL_INTERVAL_MS || "2000", 10)
  );
  const agentSigner = loadOptionalAgentSigner(process.env.AGENTVAULT_AGENT_KEYPAIR_PATH);

  // Single-request acceptance mode configuration
  const targetRequestId =
    process.env.AGENTVAULT_TARGET_REQUEST_ID ||
    process.env.AGENTVAULT_ACCEPTANCE_REQUEST_ID;
  const targetTaskPda =
    process.env.AGENTVAULT_TARGET_TASK_PDA ||
    process.env.AGENTVAULT_ACCEPTANCE_TASK_PDA;
  const targetAmountBaseUnits =
    process.env.AGENTVAULT_TARGET_AMOUNT ||
    process.env.AGENTVAULT_ACCEPTANCE_AMOUNT;
  const maxExecutionsEnv = process.env.AGENTVAULT_MAX_EXECUTIONS;

  let targetRequest:
    | {
        requestId: string;
        taskPda: string;
        amountBaseUnits: string;
        maxExecutions?: number;
      }
    | undefined = undefined;

  if (targetRequestId || targetTaskPda || targetAmountBaseUnits) {
    assert.ok(
      targetRequestId && targetTaskPda && targetAmountBaseUnits,
      "Single-request acceptance mode requires AGENTVAULT_TARGET_REQUEST_ID, AGENTVAULT_TARGET_TASK_PDA, and AGENTVAULT_TARGET_AMOUNT"
    );
    assert.ok(
      /^[A-Za-z0-9_-]{8,64}$/.test(targetRequestId),
      `Invalid target request ID format: ${targetRequestId}`
    );
    // Validate target task PDA is a valid base58 Solana public key
    new PublicKey(targetTaskPda);
    assert.ok(
      /^\d+$/.test(targetAmountBaseUnits) && BigInt(targetAmountBaseUnits) > 0n,
      `Invalid target amount: ${targetAmountBaseUnits} (must be a positive integer)`
    );
    const maxExecutions = maxExecutionsEnv ? parseInt(maxExecutionsEnv, 10) : 1;
    assert.ok(
      Number.isInteger(maxExecutions) && maxExecutions >= 1,
      `Invalid AGENTVAULT_MAX_EXECUTIONS: ${maxExecutionsEnv}`
    );
    targetRequest = {
      requestId: targetRequestId,
      taskPda: targetTaskPda,
      amountBaseUnits: targetAmountBaseUnits,
      maxExecutions,
    };
  }

  return {
    runtimeDir,
    vault,
    mode,
    rpcUrl,
    pollIntervalMs,
    expectedGenesisHash,
    agentSigner,
    targetRequest,
  };
}

export async function createConfiguredWorker(
  configOverride?: Partial<ReturnType<typeof resolveWorkerConfig>> & {
    connection?: Connection;
    program?: anchor.Program<Agentvault>;
  }
): Promise<{ worker: ModelAWorker; connection: Connection; stop: () => Promise<void> }> {
  const cfg = { ...resolveWorkerConfig(), ...configOverride };
  const connection =
    configOverride?.connection ?? new Connection(cfg.rpcUrl, "confirmed");

  // Pin expected Devnet genesis hash independently of RPC. Fail closed on error or mismatch.
  const expectedGenesis = cfg.expectedGenesisHash ?? PINNED_DEVNET_GENESIS_HASH;
  if (expectedGenesis !== PINNED_DEVNET_GENESIS_HASH) {
    throw new Error(
      `Genesis hash configuration error: expected pinned ${PINNED_DEVNET_GENESIS_HASH}, got ${expectedGenesis}`
    );
  }

  let actualGenesis: string;
  try {
    actualGenesis = await connection.getGenesisHash();
  } catch (err) {
    throw new Error(
      `RPC connection failure while verifying genesis hash: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (actualGenesis !== PINNED_DEVNET_GENESIS_HASH) {
    throw new Error(
      `Connected RPC genesis hash mismatch: expected ${PINNED_DEVNET_GENESIS_HASH}, got ${actualGenesis}. Worker refuses to connect to an untrusted ledger.`
    );
  }

  const idlPath = join(process.cwd(), "target/idl/agentvault.json");
  assert.ok(existsSync(idlPath), `Anchor IDL not found at ${idlPath}`);
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as Agentvault;
  const program =
    configOverride?.program ??
    new anchor.Program<Agentvault>(idl, { connection });

  const adapter: ModelAExecutionAdapter = {
    mode: cfg.mode,
  };

  const worker = new ModelAWorker({
    runtimeDir: cfg.runtimeDir,
    network: "devnet",
    expectedGenesisHash: actualGenesis,
    vault: cfg.vault,
    rpc: connection as unknown as ModelAWorkerRpc,
    program,
    adapter,
    agentSigner: cfg.agentSigner,
    pollIntervalMs: cfg.pollIntervalMs,
    targetRequest: cfg.targetRequest,
    requireCryptographicSignature: true,
    readAck: ({ vault, requestId }) => {
      const result = isModelAPaymentIntentAcknowledged(cfg.runtimeDir, "devnet", vault, requestId);
      return { acknowledged: result.acknowledged, acknowledgedAtUnix: result.record?.acknowledgedAtUnix };
    },
    authorizePayment: async (intent, context) => {
      // Look for persisted agent authorization decision
      const decisionPath = join(
        cfg.runtimeDir,
        "agent-decisions",
        `${intent.request.requestId}.json`
      );
      if (!existsSync(decisionPath)) {
        return {
          decision: "REJECT",
          reason: "No authenticated agent decision found for this request",
        };
      }
      let decision: any;
      try {
        decision = JSON.parse(readFileSync(decisionPath, "utf8"));
      } catch {
        return { decision: "REJECT", reason: "Failed to read agent decision record" };
      }
      if (!decision || typeof decision !== "object") {
        return { decision: "REJECT", reason: "Invalid agent decision record format" };
      }
      if (decision.decision !== "PAY") {
        return {
          decision: "REJECT",
          reason: decision.reason || "Agent decided not to pay",
        };
      }

      // Mandatory cryptographic signature requirement: Unsigned JSON or Gemini output alone is PROHIBITED
      if (!decision.signature || typeof decision.signature !== "string") {
        return {
          decision: "REJECT",
          reason:
            "Agent decision missing mandatory cryptographic signature; unsigned JSON or AI output alone cannot authorize payment",
        };
      }

      // Check exact term binding
      if (decision.requestId !== intent.request.requestId) {
        return { decision: "REJECT", reason: "Agent decision request ID mismatch" };
      }
      if (decision.vault !== intent.vault) {
        return { decision: "REJECT", reason: "Agent decision vault mismatch" };
      }
      if (decision.agentAuthority !== intent.request.agentAuthority) {
        return { decision: "REJECT", reason: "Agent decision agent authority mismatch" };
      }
      const expectedTaskPda = context?.taskPda.toBase58();
      if (expectedTaskPda && decision.taskPda !== expectedTaskPda) {
        return { decision: "REJECT", reason: "Agent decision task PDA mismatch" };
      }
      if (decision.recipient !== intent.request.recipient) {
        return { decision: "REJECT", reason: "Agent decision recipient mismatch" };
      }
      if (String(decision.amountBaseUnits) !== String(intent.request.amountBaseUnits)) {
        return { decision: "REJECT", reason: "Agent decision amount mismatch" };
      }
      if (
        decision.expiresAtUnix !== undefined &&
        String(decision.expiresAtUnix) !== String(intent.request.expiresAtUnix)
      ) {
        return { decision: "REJECT", reason: "Agent decision expiry mismatch" };
      }

      // Verify Ed25519 cryptographic signature with tweetnacl
      try {
        const sigBytes = Buffer.from(decision.signature, "base64");
        if (sigBytes.length !== 64) {
          return { decision: "REJECT", reason: "Invalid agent signature byte length" };
        }
        const authorityPubkey = new PublicKey(intent.request.agentAuthority);
        const encV2 = encodeAgentPaymentDecision({
          requestId: decision.requestId,
          vault: decision.vault,
          agentAuthority: decision.agentAuthority,
          taskPda: decision.taskPda,
          recipient: decision.recipient,
          amountBaseUnits: String(decision.amountBaseUnits),
          expiresAtUnix: decision.expiresAtUnix,
        });
        const encV1 = encodeAgentPaymentDecision({
          requestId: decision.requestId,
          vault: decision.vault,
          agentAuthority: decision.agentAuthority,
          taskPda: decision.taskPda,
          recipient: decision.recipient,
          amountBaseUnits: String(decision.amountBaseUnits),
        });
        const validV2 =
          decision.expiresAtUnix !== undefined
            ? nacl.sign.detached.verify(encV2, sigBytes, authorityPubkey.toBytes())
            : false;
        const validV1 = nacl.sign.detached.verify(encV1, sigBytes, authorityPubkey.toBytes());
        if (!validV2 && !validV1) {
          return {
            decision: "REJECT",
            reason: "Cryptographic agent authorization signature verification failed",
          };
        }
      } catch (err) {
        return {
          decision: "REJECT",
          reason: `Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      return decision;
    },
  });

  return {
    worker,
    connection,
    stop: async () => await worker.stopGracefully(),
  };
}

export async function runAcceptancePreview(
  configOverride?: Partial<ReturnType<typeof resolveWorkerConfig>>
): Promise<void> {
  const cfg = { ...resolveWorkerConfig(), ...configOverride };
  console.log("====================================================");
  console.log("       AgentVault Model A Acceptance Preview        ");
  console.log("====================================================");
  console.log("Mode:              READ-ONLY PREVIEW (Zero private keys)");
  console.log(
    `Intended Mode:     ${cfg.mode} (Live: ${
      cfg.mode === "live_devnet" &&
      process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST === "true"
    })`
  );
  console.log(`Network:           ${NETWORK}`);
  console.log(
    `Target Request:    ${
      cfg.targetRequest ? cfg.targetRequest.requestId : "ALL ELIGIBLE"
    }`
  );
  if (cfg.targetRequest) {
    console.log(`Target Task PDA:   ${cfg.targetRequest.taskPda}`);
    console.log(`Target Amount:     ${cfg.targetRequest.amountBaseUnits} base units`);
    console.log(`Max Executions:    ${cfg.targetRequest.maxExecutions ?? 1}`);
  }
  console.log(`Runtime Directory: ${cfg.runtimeDir}`);
  console.log("----------------------------------------------------");

  // 1. Connect & verify pinned genesis hash
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const actualGenesis = await connection.getGenesisHash().catch((e) => {
    throw new Error(`RPC connection error: ${e.message}`);
  });
  assert.equal(
    actualGenesis,
    PINNED_DEVNET_GENESIS_HASH,
    `Genesis hash mismatch: expected ${PINNED_DEVNET_GENESIS_HASH}, got ${actualGenesis}`
  );
  console.log(`Devnet Genesis:    ${actualGenesis} (VERIFIED)`);

  // 2. Locate target intent in inbox
  const inboxDir = join(cfg.runtimeDir, "payment-intent-inbox");
  let targetIntent: any = null;
  if (existsSync(inboxDir)) {
    const files = readdirSync(inboxDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const item = JSON.parse(readFileSync(join(inboxDir, f), "utf8"));
        if (cfg.targetRequest) {
          if (item.request?.requestId === cfg.targetRequest.requestId) {
            targetIntent = item;
            break;
          }
        } else if (item.vault === cfg.vault) {
          targetIntent = item;
          break;
        }
      } catch {}
    }
  }

  if (!targetIntent) {
    console.log(`Intent Status:     NOT FOUND in inbox (${inboxDir})`);
    console.log("Acceptance Status: WAITING FOR INBOX INTENT");
    console.log("====================================================");
    return;
  }

  const req = targetIntent.request;
  console.log(`Request ID:        ${req.requestId}`);
  console.log(`Amount:            ${req.amountBaseUnits} base units`);
  console.log(`Recipient:         ${req.recipient}`);
  console.log(`Agent Authority:   ${req.agentAuthority}`);
  console.log(
    `Intent Expiry:     ${new Date(Number(req.expiresAtUnix) * 1000).toISOString()}`
  );

  // 3. Check delivery acknowledgment
  const ack = isModelAPaymentIntentAcknowledged(
    cfg.runtimeDir,
    "devnet",
    cfg.vault,
    req.requestId
  );
  console.log(
    `Delivery Status:   ${
      ack.acknowledged ? "ACKNOWLEDGED" : "PENDING (NOT ACKNOWLEDGED)"
    }`
  );

  // 4. Check agent decision & cryptographic signature
  const decisionPath = join(
    cfg.runtimeDir,
    "agent-decisions",
    `${req.requestId}.json`
  );
  let authValid = false;
  let authNotice = "NOT FOUND";
  if (existsSync(decisionPath)) {
    try {
      const decision = JSON.parse(readFileSync(decisionPath, "utf8"));
      if (decision.decision === "PAY" && decision.signature) {
        const sigBytes = Buffer.from(decision.signature, "base64");
        const authorityPubkey = new PublicKey(req.agentAuthority);
        const encV2 = encodeAgentPaymentDecision({
          requestId: decision.requestId,
          vault: decision.vault,
          agentAuthority: decision.agentAuthority,
          taskPda: decision.taskPda,
          recipient: decision.recipient,
          amountBaseUnits: String(decision.amountBaseUnits),
          expiresAtUnix: decision.expiresAtUnix,
        });
        const encV1 = encodeAgentPaymentDecision({
          requestId: decision.requestId,
          vault: decision.vault,
          agentAuthority: decision.agentAuthority,
          taskPda: decision.taskPda,
          recipient: decision.recipient,
          amountBaseUnits: String(decision.amountBaseUnits),
        });
        const validV2 =
          decision.expiresAtUnix !== undefined
            ? nacl.sign.detached.verify(encV2, sigBytes, authorityPubkey.toBytes())
            : false;
        const validV1 = nacl.sign.detached.verify(
          encV1,
          sigBytes,
          authorityPubkey.toBytes()
        );
        if (validV2 || validV1) {
          authValid = true;
          authNotice = "CRYPTOGRAPHICALLY VERIFIED (Ed25519)";
        } else {
          authNotice = "INVALID SIGNATURE";
        }
      } else if (!decision.signature) {
        authNotice =
          "UNSIGNED (REJECTED: advisory AI or unsigned JSON cannot authorize)";
      } else {
        authNotice = `REJECTED (${decision.reason || "Decision not PAY"})`;
      }
    } catch {
      authNotice = "PARSE ERROR";
    }
  }
  console.log(`Agent Decision:    ${authNotice}`);

  // 5. On-Chain State Checks
  const idlPath = join(process.cwd(), "target/idl/agentvault.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as Agentvault;
  const program = new anchor.Program<Agentvault>(idl, { connection });

  const targetTaskPdaStr = cfg.targetRequest?.taskPda;
  let onChainTaskOk = false;
  if (targetTaskPdaStr) {
    try {
      const taskAcc = await program.account.task.fetch(
        new PublicKey(targetTaskPdaStr)
      );
      const clockInfo = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
      const chainTime = Number(clockInfo!.data.readBigInt64LE(32));
      const taskExpiresAt = Number(taskAcc.expiresAt);
      const expired = chainTime >= taskExpiresAt;
      console.log(`On-Chain Task:     ${targetTaskPdaStr}`);
      console.log(`  Task Recipient:  ${taskAcc.recipient.toBase58()}`);
      console.log(`  Task Budget:     ${taskAcc.budget.toString()} base units`);
      console.log(`  Task Spent:      ${taskAcc.spent.toString()} base units`);
      console.log(`  Next Nonce:      ${taskAcc.nextNonce.toString()}`);
      console.log(
        `  Expires At:      ${new Date(taskExpiresAt * 1000).toISOString()}`
      );
      console.log(
        `  Task Status:     ${
          taskAcc.active ? (expired ? "EXPIRED" : "ACTIVE") : "INACTIVE"
        }`
      );
      onChainTaskOk =
        taskAcc.active &&
        !expired &&
        taskAcc.recipient.toBase58() === req.recipient;
    } catch (err) {
      console.log(
        `On-Chain Task:     ERROR FETCHING (${(err as Error).message})`
      );
    }
  }

  console.log("----------------------------------------------------");
  const ready =
    ack.acknowledged && authValid && (targetTaskPdaStr ? onChainTaskOk : true);
  console.log(
    `Acceptance Status: ${
      ready
        ? "READY FOR SUPERVISED ACCEPTANCE"
        : "BLOCKED — PRE-CONDITIONS NOT MET"
    }`
  );
  console.log("====================================================");
}

export async function runStandaloneWorker(): Promise<void> {
  if (process.argv.includes("--preview")) {
    await runAcceptancePreview();
    return;
  }

  const config = resolveWorkerConfig();

  console.log("====================================================");
  console.log("       AgentVault Model A Autonomous Worker         ");
  console.log("====================================================");
  console.log(`Network:           ${NETWORK}`);
  console.log(
    `Execution Mode:    ${config.mode} (non-broadcasting default: ${
      config.mode !== "live_devnet"
    })`
  );
  console.log(`Vault:             ${config.vault}`);
  console.log(
    `Target Request:    ${
      config.targetRequest
        ? `${config.targetRequest.requestId} (Task: ${config.targetRequest.taskPda}, Amount: ${config.targetRequest.amountBaseUnits})`
        : "ALL ELIGIBLE"
    }`
  );
  console.log(`Runtime Directory: ${config.runtimeDir}`);
  console.log(`Polling Interval:  ${config.pollIntervalMs} ms`);
  console.log(
    `Live Broadcast:    ${
      process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST === "true"
        ? "ENABLED (LIVE DEVNET)"
        : "DISABLED (SAFE)"
    }`
  );
  console.log("====================================================");

  const { worker, stop } = await createConfiguredWorker(config);

  let isStopping = false;
  const shutdown = async (signal: string) => {
    if (isStopping) return;
    isStopping = true;
    console.log(`\n[Worker] Received ${signal}. Shutting down gracefully...`);
    try {
      await stop();
      console.log(
        "[Worker] In-flight processing completed safely. Polling stopped cleanly. Goodbye."
      );
    } catch (err) {
      console.error("[Worker] Error during shutdown:", err);
    }
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  console.log(
    "[Worker] Polling loop started. Watching for acknowledged payment intents...\n"
  );
  worker.start();
}

if (process.argv[1] && process.argv[1].endsWith("model-a-worker-runner.ts")) {
  runStandaloneWorker().catch((err) => {
    console.error(
      "[Worker] Fatal startup error:",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  });
}
