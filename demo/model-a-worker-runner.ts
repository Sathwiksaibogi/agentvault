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
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Agentvault } from "../target/types/agentvault";
import {
  ModelAWorker,
  type ModelAExecutionAdapter,
  type ModelAWorkerOptions,
} from "./model-a-worker";
import { isModelAPaymentIntentAcknowledged } from "./model-a-payment-intake";
import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";

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

  return {
    runtimeDir,
    vault,
    mode,
    rpcUrl,
    pollIntervalMs,
    expectedGenesisHash,
    agentSigner,
  };
}

export async function createConfiguredWorker(
  configOverride?: Partial<ReturnType<typeof resolveWorkerConfig>>
): Promise<{ worker: ModelAWorker; connection: Connection; stop: () => void }> {
  const cfg = { ...resolveWorkerConfig(), ...configOverride };
  const connection = new Connection(cfg.rpcUrl, "confirmed");

  const genesisHash =
    cfg.expectedGenesisHash || (await connection.getGenesisHash().catch(() => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"));

  const idlPath = join(process.cwd(), "target/idl/agentvault.json");
  assert.ok(existsSync(idlPath), `Anchor IDL not found at ${idlPath}`);
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as Agentvault;
  const program = new anchor.Program<Agentvault>(idl, { connection });

  const adapter: ModelAExecutionAdapter = {
    mode: cfg.mode,
  };

  const worker = new ModelAWorker({
    runtimeDir: cfg.runtimeDir,
    network: "devnet",
    expectedGenesisHash: genesisHash,
    vault: cfg.vault,
    rpc: connection,
    program,
    adapter,
    agentSigner: cfg.agentSigner,
    pollIntervalMs: cfg.pollIntervalMs,
    readAck: ({ vault, requestId }) => {
      const result = isModelAPaymentIntentAcknowledged(cfg.runtimeDir, "devnet", vault, requestId);
      return { acknowledged: result.acknowledged, acknowledgedAtUnix: result.record?.acknowledgedAtUnix };
    },
    authorizePayment: async (intent) => {
      // Look for persisted agent authorization decision
      const decisionPath = join(
        cfg.runtimeDir,
        "agent-decisions",
        `${intent.request.requestId}.json`
      );
      if (existsSync(decisionPath)) {
        try {
          const decision = JSON.parse(readFileSync(decisionPath, "utf8"));
          return decision;
        } catch {
          return { decision: "REJECT", reason: "Failed to read agent decision record" };
        }
      }
      return {
        decision: "REJECT",
        reason: "No authenticated agent decision found for this request",
      };
    },
  });

  return {
    worker,
    connection,
    stop: () => worker.stop(),
  };
}

export async function runStandaloneWorker(): Promise<void> {
  const config = resolveWorkerConfig();

  console.log("====================================================");
  console.log("       AgentVault Model A Autonomous Worker         ");
  console.log("====================================================");
  console.log(`Network:           ${NETWORK}`);
  console.log(`Execution Mode:    ${config.mode} (non-broadcasting default: ${config.mode !== "live_devnet"})`);
  console.log(`Vault:             ${config.vault}`);
  console.log(`Runtime Directory: ${config.runtimeDir}`);
  console.log(`Polling Interval:  ${config.pollIntervalMs} ms`);
  console.log(`Live Broadcast:    ${process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST === "true" ? "ENABLED (LIVE DEVNET)" : "DISABLED (SAFE)"}`);
  console.log("====================================================");

  const { worker, stop } = await createConfiguredWorker(config);

  let isStopping = false;
  const shutdown = (signal: string) => {
    if (isStopping) return;
    isStopping = true;
    console.log(`\n[Worker] Received ${signal}. Shutting down gracefully...`);
    stop();
    console.log("[Worker] Polling stopped cleanly. Goodbye.");
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  console.log("[Worker] Polling loop started. Watching for acknowledged payment intents...\n");
  worker.start();
}

if (process.argv[1] && process.argv[1].endsWith("model-a-worker-runner.ts")) {
  runStandaloneWorker().catch((err) => {
    console.error("[Worker] Fatal startup error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
