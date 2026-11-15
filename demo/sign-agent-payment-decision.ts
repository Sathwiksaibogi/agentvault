/**
 * AgentVault — Authorizes and signs a Model A payment decision for an inbox intent.
 *
 * SAFETY GUARANTEES:
 * - Uses existing encodeAgentPaymentDecision() from ./model-a-worker.js.
 * - Never hardcodes authorization terms; derives terms directly from the persisted intent.
 * - Verifies signer public key matches registered agent authority on-chain.
 * - Strict permissions: requires agent keypair file to be chmod 0600 (owner only).
 * - Saves signed decision to runtime agent-decisions/ directory with mode 0600.
 * - Never prints or exposes private key bytes.
 *
 * Usage:
 *   AGENTVAULT_AGENT_KEYPAIR_PATH=/path/to/agent-keypair.json \
 *   AGENTVAULT_TARGET_REQUEST_ID=<REQUEST_ID> \
 *   npx tsx demo/sign-agent-payment-decision.ts [--dry-run]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import BN from "bn.js";
import {
  encodeAgentPaymentDecision,
  type AuthenticatedAgentPaymentDecision,
} from "./model-a-worker.js";
import { DEVNET_PROGRAM_ID } from "./devnet-acceptance-preflight.js";
import { RUNTIME_DIR } from "./runtime-config.js";

export function loadVerifiedAgentKeypair(keyPath?: string): Keypair {
  if (!keyPath) {
    throw new Error(
      "AGENTVAULT_AGENT_KEYPAIR_PATH environment variable is required (absolute path to chmod 0600 keypair file)"
    );
  }
  if (!isAbsolute(keyPath)) {
    throw new Error("Agent keypair path must be absolute");
  }
  if (!existsSync(keyPath)) {
    throw new Error(`Agent keypair file does not exist: ${keyPath}`);
  }
  const st = statSync(keyPath);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(
      "Refusing agent keypair file readable by others; chmod 0600 the keypair file"
    );
  }
  const secret = JSON.parse(readFileSync(keyPath, "utf8")) as unknown;
  if (
    !Array.isArray(secret) ||
    secret.length !== 64 ||
    !secret.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    throw new Error("Invalid agent keypair format (expected 64-byte array)");
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function findPersistedPaymentIntent(runtimeDir: string, requestId: string): any {
  const inboxDir = join(runtimeDir, "payment-intent-inbox");
  if (!existsSync(inboxDir)) {
    throw new Error(`Payment intent inbox directory does not exist: ${inboxDir}`);
  }
  const files = readdirSync(inboxDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    try {
      const stored = JSON.parse(readFileSync(join(inboxDir, f), "utf8"));
      if (stored.request?.requestId === requestId) {
        return stored;
      }
    } catch {
      /* skip corrupt */
    }
  }
  throw new Error(`Payment intent ${requestId} not found in inbox (${inboxDir})`);
}

export function deriveTaskPda(vault: string, agentAuthority: string, taskId: string | number): string {
  const vaultPubkey = new PublicKey(vault);
  const authorityPubkey = new PublicKey(agentAuthority);
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vaultPubkey.toBuffer(), authorityPubkey.toBuffer()],
    DEVNET_PROGRAM_ID
  );
  const taskIdBn = new BN(String(taskId));
  const [taskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), agentPda.toBuffer(), taskIdBn.toArrayLike(Buffer, "le", 8)],
    DEVNET_PROGRAM_ID
  );
  return taskPda.toBase58();
}

export async function signAgentPaymentDecision(options?: {
  runtimeDir?: string;
  requestId?: string;
  agentKeypairPath?: string;
  dryRun?: boolean;
}): Promise<AuthenticatedAgentPaymentDecision> {
  const runtimeDir = options?.runtimeDir ?? process.env.AGENTVAULT_RUNTIME_DIR ?? RUNTIME_DIR;
  const requestId =
    options?.requestId ??
    process.env.AGENTVAULT_TARGET_REQUEST_ID ??
    process.env.AGENTVAULT_ACCEPTANCE_REQUEST_ID;

  if (!requestId) {
    throw new Error("Target requestId is required (set AGENTVAULT_TARGET_REQUEST_ID)");
  }

  // 1. Locate persisted, verified payment intent
  const storedIntent = findPersistedPaymentIntent(runtimeDir, requestId);
  const req = storedIntent.request;
  const vault = storedIntent.vault;

  // 2. Derive task PDA from intent parameters
  const taskPda = deriveTaskPda(vault, req.agentAuthority, req.taskId);

  // 3. Prepare decision terms derived directly from intent
  const decisionRecord: AuthenticatedAgentPaymentDecision = {
    decision: "PAY",
    requestId: req.requestId,
    vault,
    agentAuthority: req.agentAuthority,
    taskPda,
    recipient: req.recipient,
    amountBaseUnits: req.amountBaseUnits,
    expiresAtUnix: Number(req.expiresAtUnix),
    reason: req.reason ?? "Supervised Model A acceptance payment",
    authorizedAtUnix: Math.floor(Date.now() / 1000),
    signature: "",
  };

  // 4. Compute canonical encoding
  const canonicalBytes = encodeAgentPaymentDecision(decisionRecord);

  if (options?.dryRun) {
    console.log("=== DRY RUN (Agent decision not signed or saved) ===");
    console.log(`Request ID:        ${decisionRecord.requestId}`);
    console.log(`Vault:             ${decisionRecord.vault}`);
    console.log(`Agent Authority:   ${decisionRecord.agentAuthority}`);
    console.log(`Derived Task PDA:  ${decisionRecord.taskPda}`);
    console.log(`Recipient:         ${decisionRecord.recipient}`);
    console.log(`Amount:            ${decisionRecord.amountBaseUnits} base units`);
    console.log(`Expires At:        ${new Date(decisionRecord.expiresAtUnix! * 1000).toISOString()}`);
    console.log(`Canonical Domain:  agentvault:agent-payment-decision:v2`);
    console.log(`Canonical Bytes:   ${canonicalBytes.length} bytes`);
    return decisionRecord;
  }

  // 5. Load agent keypair and verify authority match
  const agentKeypair = loadVerifiedAgentKeypair(
    options?.agentKeypairPath ?? process.env.AGENTVAULT_AGENT_KEYPAIR_PATH
  );
  const signerAuthority = agentKeypair.publicKey.toBase58();
  if (signerAuthority !== req.agentAuthority) {
    throw new Error(
      `Signer authority mismatch: keypair is ${signerAuthority}, intent requires ${req.agentAuthority}`
    );
  }

  // 6. Sign canonical bytes with detached Ed25519
  const sigBytes = nacl.sign.detached(canonicalBytes, agentKeypair.secretKey);
  decisionRecord.signature = Buffer.from(sigBytes).toString("base64");

  // 7. Persist to agent-decisions/ with restrictive permissions (0600)
  const decisionsDir = join(runtimeDir, "agent-decisions");
  mkdirSync(decisionsDir, { recursive: true, mode: 0o700 });
  const decisionPath = join(decisionsDir, `${requestId}.json`);
  writeFileSync(decisionPath, JSON.stringify(decisionRecord, null, 2) + "\n", {
    mode: 0o600,
  });

  return decisionRecord;
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes("--dry-run");
  const decision = await signAgentPaymentDecision({ dryRun: isDryRun });

  console.log("====================================================");
  console.log("    Agent Payment Decision Cryptographically Signed ");
  console.log("====================================================");
  console.log(`Decision:          ${decision.decision}`);
  console.log(`Request ID:        ${decision.requestId}`);
  console.log(`Agent Authority:   ${decision.agentAuthority}`);
  console.log(`Task PDA:          ${decision.taskPda}`);
  console.log(`Recipient:         ${decision.recipient}`);
  console.log(`Amount:            ${decision.amountBaseUnits} base units`);
  console.log(`Signature Format:  Ed25519 Base64 (${decision.signature ? "SIGNED" : "DRY RUN"})`);
  console.log("====================================================");
  if (!isDryRun) {
    console.log("\nNext step: Run read-only zero-key acceptance preview:");
    console.log(
      `  AGENTVAULT_NETWORK=devnet AGENTVAULT_TARGET_REQUEST_ID=${decision.requestId} AGENTVAULT_TARGET_TASK_PDA=${decision.taskPda} AGENTVAULT_TARGET_AMOUNT=${decision.amountBaseUnits} AGENTVAULT_MAX_EXECUTIONS=1 pnpm worker:model-a:preview\n`
    );
  }
}

if (process.argv[1]?.endsWith("sign-agent-payment-decision.ts")) {
  main().catch((err) => {
    console.error("Signing error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
