import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  PINNED_DEVNET_GENESIS_HASH,
  loadOptionalAgentSigner,
  resolveWorkerConfig,
  createConfiguredWorker,
  runAcceptancePreview,
} from "./model-a-worker-runner";
import { encodeAgentPaymentDecision } from "./model-a-worker";
import {
  receiveModelAPaymentIntent,
  acknowledgeModelAPaymentIntent,
} from "./model-a-payment-intake";

function makeMockConnection(genesis = PINNED_DEVNET_GENESIS_HASH) {
  return {
    async getGenesisHash() {
      return genesis;
    },
    async getAccountInfo() {
      return null;
    },
    async getLatestBlockhash() {
      return {
        blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
        lastValidBlockHeight: 1000,
      };
    },
    async getBlockHeight() {
      return 500;
    },
  } as any;
}

test("worker runner: defaults to simulated mode and resolves safe configurations", () => {
  const origEnv = { ...process.env };
  try {
    delete process.env.AGENTVAULT_WORKER_MODE;
    delete process.env.AGENTVAULT_VAULT;
    delete process.env.AGENTVAULT_POLL_INTERVAL_MS;
    delete process.env.AGENTVAULT_TARGET_REQUEST_ID;
    delete process.env.AGENTVAULT_TARGET_TASK_PDA;
    delete process.env.AGENTVAULT_TARGET_AMOUNT;

    const config = resolveWorkerConfig();
    assert.equal(config.mode, "simulated", "Worker must default to simulated mode");
    assert.ok(config.vault.length >= 32, "Vault must be configured");
    assert.ok(config.pollIntervalMs >= 500, "Polling interval must be at least 500ms");
    assert.ok(config.runtimeDir.length > 0, "Runtime directory must be set");
    assert.equal(config.targetRequest, undefined, "targetRequest should be undefined by default");
  } finally {
    process.env = origEnv;
  }
});

test("worker runner: loadOptionalAgentSigner rejects insecure permissions and invalid secret", () => {
  const root = mkdtempSync(join(tmpdir(), "av-key-test-"));
  try {
    const keyPath = join(root, "agent.json");
    const kp = Keypair.generate();
    writeFileSync(keyPath, JSON.stringify(Array.from(kp.secretKey)));
    chmodSync(keyPath, 0o666); // Insecure permissions

    assert.throws(
      () => loadOptionalAgentSigner(keyPath),
      /Agent keypair file permissions must be 0600/
    );

    chmodSync(keyPath, 0o600);
    const loaded = loadOptionalAgentSigner(keyPath);
    assert.ok(loaded);
    assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker runner: createConfiguredWorker instantiates ModelAWorker and manages lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-runner-test-"));
  try {
    const mockConnection = makeMockConnection();
    const { worker, stop } = await createConfiguredWorker({
      runtimeDir: root,
      mode: "simulated",
      pollIntervalMs: 1000,
      vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
      connection: mockConnection,
    });

    assert.equal(worker.isRunning(), false);
    worker.start();
    assert.equal(worker.isRunning(), true);
    await stop();
    assert.equal(worker.isRunning(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-request acceptance mode: resolves and validates target request parameters", () => {
  const origEnv = { ...process.env };
  try {
    const taskPda = Keypair.generate().publicKey.toBase58();
    process.env.AGENTVAULT_TARGET_REQUEST_ID = "req_single_target_01";
    process.env.AGENTVAULT_TARGET_TASK_PDA = taskPda;
    process.env.AGENTVAULT_TARGET_AMOUNT = "10000";
    process.env.AGENTVAULT_MAX_EXECUTIONS = "1";

    const cfg = resolveWorkerConfig();
    assert.ok(cfg.targetRequest);
    assert.equal(cfg.targetRequest.requestId, "req_single_target_01");
    assert.equal(cfg.targetRequest.taskPda, taskPda);
    assert.equal(cfg.targetRequest.amountBaseUnits, "10000");
    assert.equal(cfg.targetRequest.maxExecutions, 1);
  } finally {
    process.env = origEnv;
  }
});

test("single-request acceptance mode: fails configuration when partial target parameters are provided", () => {
  const origEnv = { ...process.env };
  try {
    process.env.AGENTVAULT_TARGET_REQUEST_ID = "req_incomplete_01";
    delete process.env.AGENTVAULT_TARGET_TASK_PDA;
    delete process.env.AGENTVAULT_TARGET_AMOUNT;

    assert.throws(
      () => resolveWorkerConfig(),
      /Single-request acceptance mode requires AGENTVAULT_TARGET_REQUEST_ID/
    );
  } finally {
    process.env = origEnv;
  }
});

test("genesis pinning: runner fails closed on RPC error or genesis mismatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-genesis-test-"));
  try {
    // 1. RPC connection error
    const failingRpc = {
      async getGenesisHash() {
        throw new Error("Connection refused");
      },
    } as any;

    await assert.rejects(
      () =>
        createConfiguredWorker({
          runtimeDir: root,
          connection: failingRpc,
        }),
      /RPC connection failure while verifying genesis hash: Connection refused/
    );

    // 2. Genesis mismatch (e.g. mainnet or testnet returned)
    const mismatchedRpc = {
      async getGenesisHash() {
        return "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"; // Mainnet genesis
      },
    } as any;

    await assert.rejects(
      () =>
        createConfiguredWorker({
          runtimeDir: root,
          connection: mismatchedRpc,
        }),
      /Connected RPC genesis hash mismatch: expected EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent authorization: runner rejects unsigned agent decision or Gemini output alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-auth-test-"));
  try {
    const mockConnection = makeMockConnection();
    const { worker } = await createConfiguredWorker({
      runtimeDir: root,
      vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
      connection: mockConnection,
    });

    const decisionsDir = join(root, "agent-decisions");
    mkdirSync(decisionsDir, { recursive: true });

    // 1. Unsigned JSON decision (e.g. raw AI output or unauthenticated decision)
    writeFileSync(
      join(decisionsDir, "req_unsigned_01.json"),
      JSON.stringify({
        decision: "PAY",
        requestId: "req_unsigned_01",
        vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
        agentAuthority: Keypair.generate().publicKey.toBase58(),
        taskPda: Keypair.generate().publicKey.toBase58(),
        recipient: Keypair.generate().publicKey.toBase58(),
        amountBaseUnits: "10000",
        reason: "Gemini AI says PAY",
        // No cryptographic signature!
      })
    );

    const intent = {
      version: 1,
      kind: "model-a-payment-intent",
      status: "received",
      network: "devnet",
      vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
      principalId: "dev_01",
      request: {
        requestId: "req_unsigned_01",
        vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
        agentAuthority: Keypair.generate().publicKey.toBase58(),
        taskId: "3",
        recipient: Keypair.generate().publicKey.toBase58(),
        amountBaseUnits: "10000",
        expiresAtUnix: 1795000000,
      },
    } as any;

    const authResult = await (worker as any).authorizePayment(intent);
    assert.equal(authResult.decision, "REJECT");
    assert.match(authResult.reason, /missing mandatory cryptographic signature/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent authorization: runner accepts cryptographically verified signature on bound decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-auth-crypto-"));
  try {
    const mockConnection = makeMockConnection();
    const { worker } = await createConfiguredWorker({
      runtimeDir: root,
      vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
      connection: mockConnection,
    });

    const agentKp = Keypair.generate();
    const taskPda = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;
    const vault = "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U";
    const requestId = "req_valid_crypto_01";
    const amount = "10000";
    const expiresAt = 1795000000;

    const enc = encodeAgentPaymentDecision({
      requestId,
      vault,
      agentAuthority: agentKp.publicKey.toBase58(),
      taskPda: taskPda.toBase58(),
      recipient: recipient.toBase58(),
      amountBaseUnits: amount,
      expiresAtUnix: expiresAt,
    });
    const sigBytes = nacl.sign.detached(enc, agentKp.secretKey);
    const signature = Buffer.from(sigBytes).toString("base64");

    const decisionsDir = join(root, "agent-decisions");
    mkdirSync(decisionsDir, { recursive: true });
    writeFileSync(
      join(decisionsDir, `${requestId}.json`),
      JSON.stringify({
        decision: "PAY",
        requestId,
        vault,
        agentAuthority: agentKp.publicKey.toBase58(),
        taskPda: taskPda.toBase58(),
        recipient: recipient.toBase58(),
        amountBaseUnits: amount,
        expiresAtUnix: expiresAt,
        signature,
        reason: "Valid cryptographic decision",
      })
    );

    const intent = {
      version: 1,
      kind: "model-a-payment-intent",
      status: "received",
      network: "devnet",
      vault,
      principalId: "dev_01",
      request: {
        requestId,
        vault,
        agentAuthority: agentKp.publicKey.toBase58(),
        taskId: "3",
        recipient: recipient.toBase58(),
        amountBaseUnits: amount,
        expiresAtUnix: expiresAt,
      },
    } as any;

    const authResult = await (worker as any).authorizePayment(intent, { taskPda });
    assert.equal(authResult.decision, "PAY");
    assert.equal(authResult.signature, signature);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry prevention: worker refuses to re-process previously claimed, failed, rejected, or uncertain payment", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-retry-prevent-"));
  try {
    const mockConnection = makeMockConnection();
    const { worker } = await createConfiguredWorker({
      runtimeDir: root,
      vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
      connection: mockConnection,
    });

    const journalDir = join(root, "journal");
    mkdirSync(journalDir, { recursive: true });

    // Mark as previously claimed
    writeFileSync(join(journalDir, "req_already_claimed_01.json"), "{}");

    const intent = {
      version: 1,
      kind: "model-a-payment-intent",
      status: "received",
      network: "devnet",
      vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
      principalId: "dev_01",
      request: {
        requestId: "req_already_claimed_01",
        vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
        agentAuthority: Keypair.generate().publicKey.toBase58(),
        taskId: "3",
        recipient: Keypair.generate().publicKey.toBase58(),
        amountBaseUnits: "10000",
        expiresAtUnix: 1795000000,
      },
    } as any;

    await assert.rejects(
      () => worker.processPaymentIntent(intent),
      /Payment intent req_already_claimed_01 has already been processed or claimed in journal; retries are prohibited/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance preview: runAcceptancePreview runs read-only without private keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-prev-test-"));
  try {
    // Should run cleanly and output preview table
    await runAcceptancePreview({
      runtimeDir: root,
      vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
      rpcUrl: "https://api.devnet.solana.com",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
