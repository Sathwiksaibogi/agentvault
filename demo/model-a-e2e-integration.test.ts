/**
 * Complete End-to-End Integration Test Suite for AgentVault Model A and Model B.
 *
 * Verifies:
 * 1. Full automated Model A payment workflow via actual SDK, backend API, agent inbox,
 *    cryptographic agent decision, and unattended worker processing with mock RPC.
 * 2. Unsigned or untrusted agent authorization cannot trigger payment execution.
 * 3. Duplicate payment request submission idempotency without duplicate executions.
 * 4. Worker restart safety and persistence without duplicate executions.
 * 5. Cross-process task lock concurrency protection.
 * 6. Crash recovery for locks and claimed requests without bypassing unresolved states.
 * 7. Verification that zero live network or live broadcast calls occur.
 * 8. Model B pending request -> owner approval -> durable storage lifecycle without broadcasting.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY,
  type AccountInfo,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { AgentVaultClient } from "../sdk/src/index.js";
import { InMemoryDeveloperApiKeyRepository } from "./api-key-memory-repository.js";
import { issueDeveloperApiKey } from "./api-key-issuance.js";
import { createModelAPaymentHttpHandler } from "./model-a-payment-http.js";
import { createModelAAgentInboxHttpHandler } from "./model-a-agent-inbox.js";
import {
  createSelectedVaultSessionHandler,
  type WorkflowApprovalV2,
  type PaymentApprovalV2,
} from "./selected-vault-dashboard-session.js";
import { encodePaymentApprovalV2 } from "./payment-approval-v2.js";
import { encodeWorkflowV2 } from "./signed-workflow-v2.js";
import { createApiHandler, type ApiDataReaders } from "./api-handler.js";
import {
  ModelAWorker,
  CrossProcessTaskLock,
  encodeAgentPaymentDecision,
  type AuthenticatedAgentPaymentDecision,
  type ModelAWorkerOptions,
} from "./model-a-worker.js";
import {
  readModelAPaymentIntent,
  readModelAPaymentExecution,
  type StoredModelAPaymentIntent,
} from "./model-a-payment-intake.js";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard.js";
import { loadPreparedPayment } from "./prepared-payment.js";
import type { ApiPrincipal } from "./api-principal.js";

const GENESIS = Keypair.generate().publicKey.toBase58();
const NOW = 1_700_000_000;
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";

function clockBuffer(nowUnix: number): Buffer {
  const buf = Buffer.alloc(40);
  buf.writeBigInt64LE(BigInt(nowUnix), 32);
  return buf;
}

const executeTaskPaymentDiscriminator = createHash("sha256")
  .update("global:execute_task_payment")
  .digest()
  .subarray(0, 8);

interface E2EHarness {
  root: string;
  runtimeDir: string;
  server: Server;
  port: number;
  baseUrl: string;
  devToken: string;
  activityToken: string;
  ownerToken: string;
  ownerKeypair: Keypair;
  agentKeypair: Keypair;
  recipientKeypair: Keypair;
  mintKeypair: Keypair;
  vaultKey: PublicKey;
  agentPda: PublicKey;
  taskPda: PublicKey;
  treasuryAta: PublicKey;
  recipientAta: PublicKey;
  sdkClient: AgentVaultClient;
  activityClient: AgentVaultClient;
  rpcMock: ModelAWorkerOptions["rpc"];
  programMock: ModelAWorkerOptions["program"];
  activityLogs: Array<{
    signature: string;
    slot: number;
    blockTimeUnix: number;
    agentId: string;
    workflow: string;
    taskId: number;
    taskPda: string;
    succeeded: boolean;
    explorerUrl: string;
  }>;
  sentRawTxs: Buffer[];
  cleanup: () => Promise<void>;
}

async function setupE2EHarness(): Promise<E2EHarness> {
  const root = mkdtempSync(join(tmpdir(), "av-e2e-integration-"));
  const runtimeDir = join(root, "runtime");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  const ownerKeypair = Keypair.generate();
  const agentKeypair = Keypair.generate();
  const recipientKeypair = Keypair.generate();
  const mintKeypair = Keypair.generate();

  const vaultId = BigInt(1);
  const u64VaultId = Buffer.alloc(8);
  u64VaultId.writeBigUInt64LE(vaultId);

  const [vaultKey, vaultBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), ownerKeypair.publicKey.toBuffer(), u64VaultId],
    AGENTVAULT_PROGRAM_ID
  );

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vaultKey.toBuffer(), agentKeypair.publicKey.toBuffer()],
    AGENTVAULT_PROGRAM_ID
  );

  const taskIdBn = new BN(1);
  const [taskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), agentPda.toBuffer(), taskIdBn.toArrayLike(Buffer, "le", 8)],
    AGENTVAULT_PROGRAM_ID
  );

  const [treasuryAta] = PublicKey.findProgramAddressSync(
    [vaultKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const [recipientAta] = PublicKey.findProgramAddressSync(
    [recipientKeypair.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Build binary buffers matching owner-vault-verifier on-chain requirements
  const vaultData = Buffer.alloc(90);
  createHash("sha256")
    .update("account:Vault")
    .digest()
    .copy(vaultData, 0, 0, 8);
  ownerKeypair.publicKey.toBuffer().copy(vaultData, 8);
  mintKeypair.publicKey.toBuffer().copy(vaultData, 40);
  vaultData.writeBigUInt64LE(vaultId, 72);
  vaultData.writeBigUInt64LE(BigInt(250_000), 80);
  vaultData[89] = vaultBump;

  const tokenData = Buffer.alloc(165);
  mintKeypair.publicKey.toBuffer().copy(tokenData, 0);
  vaultKey.toBuffer().copy(tokenData, 32);
  tokenData.writeBigUInt64LE(BigInt(1_000_000), 64);
  tokenData[108] = 1;

  const mintData = Buffer.alloc(82);
  mintData[44] = 6;
  mintData[45] = 1;

  const apiKeyRepo = new InMemoryDeveloperApiKeyRepository();
  const ownerPrincipal: ApiPrincipal = {
    principalId: "owner-principal-1",
    role: "owner",
    vaults: [vaultKey.toBase58()],
    scopes: ["treasury:read", "activity:read", "workflows:read", "agents:read"],
  };

  const devKeyRes = await issueDeveloperApiKey({
    issuer: ownerPrincipal,
    principalId: "dev-agent-caller",
    vault: vaultKey.toBase58(),
    scopes: ["payments:request"],
    expiresAt: (NOW + 86400) * 1000,
    now: NOW * 1000,
    repository: apiKeyRepo,
  });

  const activityKeyRes = await issueDeveloperApiKey({
    issuer: ownerPrincipal,
    principalId: "dev-activity-reader",
    vault: vaultKey.toBase58(),
    scopes: ["activity:read"],
    expiresAt: (NOW + 86400) * 1000,
    now: NOW * 1000,
    repository: apiKeyRepo,
  });

  const devToken = devKeyRes.token;
  const activityToken = activityKeyRes.token;
  const ownerToken = "avk_owner_test_credential_secret";

  const activityLogs: E2EHarness["activityLogs"] = [];
  const sentRawTxs: Buffer[] = [];

  const rpcMock: ModelAWorkerOptions["rpc"] = {
    async getGenesisHash() {
      return GENESIS;
    },
    async getLatestBlockhash() {
      return {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 500,
      };
    },
    async getBlockHeight() {
      return 150;
    },
    async getAccountInfo(address: PublicKey) {
      if (address.equals(SYSVAR_CLOCK_PUBKEY)) {
        return {
          data: clockBuffer(NOW),
          executable: false,
          lamports: 1,
          owner: SYSVAR_CLOCK_PUBKEY,
        } as AccountInfo<Buffer>;
      }
      if (address.equals(vaultKey)) {
        return {
          data: vaultData,
          executable: false,
          lamports: 1_000_000,
          owner: AGENTVAULT_PROGRAM_ID,
        } as AccountInfo<Buffer>;
      }
      if (address.equals(treasuryAta)) {
        return {
          data: tokenData,
          executable: false,
          lamports: 1_000_000,
          owner: TOKEN_PROGRAM_ID,
        } as AccountInfo<Buffer>;
      }
      if (address.equals(mintKeypair.publicKey)) {
        return {
          data: mintData,
          executable: false,
          lamports: 1_000_000,
          owner: TOKEN_PROGRAM_ID,
        } as AccountInfo<Buffer>;
      }
      return null;
    },
    async simulateTransaction() {
      return { value: { err: null, unitsConsumed: 1500 } };
    },
    async sendRawTransaction(raw: Buffer) {
      sentRawTxs.push(raw);
      const tx = Transaction.from(raw);
      const sig = bs58.encode(tx.signature!);
      activityLogs.unshift({
        signature: sig,
        slot: 12345,
        blockTimeUnix: NOW,
        agentId: "agent-a",
        workflow: "procurement",
        taskId: 1,
        taskPda: taskPda.toBase58(),
        succeeded: true,
        explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      });
      return sig;
    },
    async confirmTransaction() {
      return {
        context: { slot: 12345 },
        value: { err: null, confirmationStatus: "confirmed" },
      };
    },
  };

  const programMock: ModelAWorkerOptions["program"] = {
    programId: AGENTVAULT_PROGRAM_ID,
    account: {
      vault: {
        async fetch() {
          return {
            owner: ownerKeypair.publicKey,
            tokenMint: mintKeypair.publicKey,
            paused: false,
            totalReserved: new BN(500_000),
          };
        },
      },
      agent: {
        async fetch() {
          return {
            vault: vaultKey,
            authority: agentKeypair.publicKey,
            active: true,
          };
        },
      },
      task: {
        async fetch() {
          return {
            vault: vaultKey,
            agent: agentPda,
            taskId: taskIdBn,
            active: true,
            recipient: recipientKeypair.publicKey,
            budget: new BN(200_000),
            spent: new BN(0),
            nextNonce: new BN(0),
            expiresAt: new BN(NOW + 3600),
          };
        },
      },
    },
    methods: {
      executeTaskPayment(amount: BN, nonce: BN) {
        return {
          accountsPartial(accounts: any) {
            return {
              async instruction() {
                const data = Buffer.concat([
                  executeTaskPaymentDiscriminator,
                  amount.toArrayLike(Buffer, "le", 8),
                  nonce.toArrayLike(Buffer, "le", 8),
                ]);
                return new TransactionInstruction({
                  programId: AGENTVAULT_PROGRAM_ID,
                  data,
                  keys: [
                    { pubkey: accounts.agentAuthority, isSigner: true, isWritable: true },
                    { pubkey: accounts.vault, isSigner: false, isWritable: true },
                    { pubkey: accounts.agent, isSigner: false, isWritable: true },
                    { pubkey: accounts.task, isSigner: false, isWritable: true },
                    { pubkey: accounts.tokenMint, isSigner: false, isWritable: false },
                    { pubkey: accounts.treasury, isSigner: false, isWritable: true },
                    { pubkey: accounts.recipient, isSigner: false, isWritable: false },
                    { pubkey: accounts.recipientToken, isSigner: false, isWritable: true },
                    { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
                  ],
                });
              },
            };
          },
        };
      },
    },
  };

  const readers: ApiDataReaders = {
    getTreasuryData: async () => ({
      network: "devnet",
      vault: vaultKey.toBase58(),
      owner: ownerKeypair.publicKey.toBase58(),
      tokenMint: mintKeypair.publicKey.toBase58(),
      treasury: treasuryAta.toBase58(),
      vaultId: "1",
      decimals: 6,
      paused: false,
      balanceBaseUnits: "1000000",
      reservedBaseUnits: "250000",
      availableBaseUnits: "750000",
    }),
    getAgentsData: async () => ({
      network: "devnet",
      owner: ownerKeypair.publicKey.toBase58(),
      vault: vaultKey.toBase58(),
      agents: [
        {
          id: "agent-a",
          name: "Procurement Agent",
          workflow: "procurement",
          authority: agentKeypair.publicKey.toBase58(),
          agentPda: agentPda.toBase58(),
          active: true,
          task: {
            taskId: 1,
            taskPda: taskPda.toBase58(),
            active: true,
            recipient: recipientKeypair.publicKey.toBase58(),
            budgetBaseUnits: "200000",
            spentBaseUnits: "0",
            remainingBaseUnits: "200000",
            nextNonce: "0",
            expiresAtUnix: String(NOW + 3600),
          },
        },
      ],
    }),
    getWorkflowIds: () => [],
    getWorkflowData: async () => null,
    getActivityData: async () => ({
      network: "devnet",
      activity: activityLogs,
    }),
  };

  const apiHandler = createApiHandler({
    network: "devnet",
    runtimeVault: vaultKey.toBase58(),
    credentials: {
      ownerToken,
      developerToken: devToken,
      developerVault: vaultKey.toBase58(),
    },
    readers,
    lookupDeveloperKey: (id) => apiKeyRepo.findById(id),
    cachedRead: async (_key, loader) => loader(),
    now: () => NOW * 1000,
  });

  const selectedDashboardHandler = createSelectedVaultSessionHandler({
    fallbackHandler: apiHandler,
    network: "devnet",
    rpc: rpcMock as any,
    frontendOrigin: FRONTEND_ORIGIN,
    cookieSecret: "test-dashboard-secret-32-bytes-long!",
    expectedGenesisHash: GENESIS,
    getGenesisHash: async () => GENESIS,
    now: () => NOW * 1000,
    readScopedAgents: async (verified) => ({
      network: "devnet",
      owner: verified.owner,
      vault: verified.vault,
      agents: [
        {
          id: "agent-a",
          name: "Procurement Agent",
          workflow: "procurement",
          authority: agentKeypair.publicKey.toBase58(),
          agentPda: agentPda.toBase58(),
          active: true,
          tasks: [
            {
              taskId: "1",
              taskPda: taskPda.toBase58(),
              active: true,
              recipient: recipientKeypair.publicKey.toBase58(),
              budgetBaseUnits: "200000",
              spentBaseUnits: "0",
              remainingBaseUnits: "200000",
              nextNonce: "0",
              expiresAtUnix: String(NOW + 3600),
            },
          ],
        },
      ],
    }),
    readScopedActivity: async (verified) => ({
      network: "devnet" as const,
      vault: verified.vault,
      activity: activityLogs,
    }),
    runtimeDir,
  });

  const paymentHttpHandler = createModelAPaymentHttpHandler({
    fallbackHandler: selectedDashboardHandler,
    lookupDeveloperKey: (id) => apiKeyRepo.findById(id),
    network: "devnet",
    runtimeDir,
    expectedGenesisHash: GENESIS,
    getGenesisHash: async () => GENESIS,
    now: () => NOW * 1000,
    checkPolicy: async ({ trustedScope, input }) => {
      if (trustedScope.vault !== vaultKey.toBase58()) {
        throw new Error("Invalid vault in payment intent policy");
      }
      if (!input || typeof input !== "object") throw new Error("Invalid input");
    },
    now: () => NOW * 1000,
  });

  const inboxHttpHandler = createModelAAgentInboxHttpHandler({
    fallbackHandler: paymentHttpHandler,
    network: "devnet",
    runtimeDir,
    expectedGenesisHash: GENESIS,
    getGenesisHash: async () => GENESIS,
    now: () => NOW * 1000,
    verifyAgent: async ({ vault, agentAuthority }) => {
      if (vault !== vaultKey.toBase58() || agentAuthority !== agentKeypair.publicKey.toBase58()) {
        throw new Error("Agent not authorized for this vault");
      }
    },
    now: () => NOW * 1000,
  });

  const server = createServer(inboxHttpHandler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const sdkClient = new AgentVaultClient({
    baseUrl,
    token: devToken,
  });

  const activityClient = new AgentVaultClient({
    baseUrl,
    token: activityToken,
  });

  return {
    root,
    runtimeDir,
    server,
    port,
    baseUrl,
    devToken,
    activityToken,
    ownerToken,
    ownerKeypair,
    agentKeypair,
    recipientKeypair,
    mintKeypair,
    vaultKey,
    agentPda,
    taskPda,
    treasuryAta,
    recipientAta,
    sdkClient,
    activityClient,
    rpcMock,
    programMock,
    activityLogs,
    sentRawTxs,
    async cleanup() {
      server.close();
      await once(server, "close");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("E2E Integration: Complete automated Model A payment flow via SDK, HTTP API, Agent Inbox, and unattended Worker", async () => {
  const h = await setupE2EHarness();
  let worker: ModelAWorker | null = null;
  try {
    const requestId = "e2e_intent_flow_01";
    const amountBaseUnits = "25000";
    const expiresAtUnix = String(NOW + 600);

    // 1. External developer submits payment intent through AgentVault SDK
    const acceptRes = await h.sdkClient.submitModelAPaymentIntent({
      requestId,
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskId: "1",
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits,
      expiresAtUnix,
      reason: "Quarterly server infrastructure renewal",
    });

    assert.equal(acceptRes.requestId, requestId);
    assert.equal(acceptRes.status, "received");
    assert.equal(acceptRes.duplicate, false);
    assert.equal(acceptRes.network, "devnet");
    assert.equal(acceptRes.vault, h.vaultKey.toBase58());

    // Verify durable persistence in payment-intent-inbox
    const initialStatus = await h.sdkClient.getModelAPaymentIntent(requestId);
    assert.equal(initialStatus.status, "received");
    assert.equal(initialStatus.request.amountBaseUnits, amountBaseUnits);
    assert.equal(initialStatus.execution?.status, "unclaimed");
    assert.equal(initialStatus.delivery?.acknowledged, false);

    // 2. Registered test agent receives request from authenticated Agent Inbox
    const pollChallenge = await h.sdkClient.requestAgentInboxChallenge({
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
    });
    assert.ok(pollChallenge.nonce);
    assert.ok(pollChallenge.message);

    const pollSig = bs58.encode(
      nacl.sign.detached(Buffer.from(pollChallenge.message, "utf8"), h.agentKeypair.secretKey)
    );

    const pollResult = await h.sdkClient.pollAgentInbox({
      nonce: pollChallenge.nonce,
      signature: pollSig,
    });

    assert.equal(pollResult.network, "devnet");
    assert.equal(pollResult.vault, h.vaultKey.toBase58());
    assert.equal(pollResult.agentAuthority, h.agentKeypair.publicKey.toBase58());
    const discovered = pollResult.items.find((item) => item.request.requestId === requestId);
    assert.ok(discovered, "Payment intent must be discoverable in authenticated inbox");

    // 3. Registered test agent acknowledges delivery
    const ackChallenge = await h.sdkClient.requestAgentInboxChallenge({
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
    });

    const ackSig = bs58.encode(
      nacl.sign.detached(Buffer.from(ackChallenge.message, "utf8"), h.agentKeypair.secretKey)
    );

    const ackResult = await h.sdkClient.acknowledgeAgentInboxItem({
      nonce: ackChallenge.nonce,
      signature: ackSig,
      requestId,
    });

    assert.equal(ackResult.requestId, requestId);
    assert.equal(ackResult.duplicate, false);
    assert.ok(ackResult.acknowledgedAtUnix > 0);

    // 4 & 5. Set up unattended worker with valid, request-bound cryptographic agent authorization
    const boundDecision: AuthenticatedAgentPaymentDecision = {
      requestId,
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskPda: h.taskPda.toBase58(),
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits,
      decision: "PAY",
      authorizedAtUnix: NOW,
    };
    const decisionBytes = encodeAgentPaymentDecision(boundDecision);
    boundDecision.signature = Buffer.from(nacl.sign.detached(decisionBytes, h.agentKeypair.secretKey)).toString("base64");

    worker = new ModelAWorker({
      runtimeDir: h.runtimeDir,
      network: "devnet",
      expectedGenesisHash: GENESIS,
      vault: h.vaultKey.toBase58(),
      rpc: h.rpcMock,
      program: h.programMock,
      adapter: { mode: "simulated" },
      agentSigner: h.agentKeypair,
      pollIntervalMs: 50,
      now: () => NOW * 1000,
      evaluateAi: async () => ({ decision: "PAY", reason: "Advisory AI approves legitimate infrastructure cost" }),
      authorizePayment: async () => boundDecision,
    });

    // 6. Start the worker unattended — it scans, verifies policy, and processes without manual execution CLI
    assert.equal(worker.isRunning(), false);
    worker.start();
    assert.equal(worker.isRunning(), true);

    // Wait for the automated worker polling loop to process the payment intent
    let terminalExecutionStatus: string | undefined;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const statusCheck = await h.sdkClient.getModelAPaymentIntent(requestId);
      if (statusCheck.execution?.status === "confirmed" || statusCheck.execution?.status === "finalized") {
        terminalExecutionStatus = statusCheck.execution.status;
        break;
      }
    }

    // 7. Verify durable execution status is recorded atomically
    assert.equal(terminalExecutionStatus, "confirmed");
    assert.equal(h.sentRawTxs.length, 1, "Mock RPC must receive exactly one signed raw transaction");

    // 8. Developer SDK retrieves the resulting payment status
    const finalSdkStatus = await h.sdkClient.getModelAPaymentIntent(requestId);
    assert.equal(finalSdkStatus.status, "received");
    assert.equal(finalSdkStatus.delivery?.acknowledged, true);
    assert.ok(finalSdkStatus.delivery?.acknowledgedAtUnix);
    assert.equal(finalSdkStatus.execution?.claimed, true);
    assert.equal(finalSdkStatus.execution?.prepared, true);
    assert.equal(finalSdkStatus.execution?.status, "confirmed");
    assert.ok(finalSdkStatus.execution?.signature);
    assert.equal(finalSdkStatus.execution?.nonce, "0");

    // 9. Owner activity interface reflects the correct confirmed outcome
    const activityResult = await h.activityClient.listActivity();
    assert.ok(activityResult.length >= 1);
    const activityEntry = activityResult.find((a) => a.signature === finalSdkStatus.execution?.signature);
    assert.ok(activityEntry, "Payment transaction must appear in activity log");
    assert.equal(activityEntry?.succeeded, true);
    assert.equal(activityEntry?.taskId, 1);
    assert.equal(activityEntry?.taskPda, h.taskPda.toBase58());
  } finally {
    if (worker) worker.stop();
    await h.cleanup();
  }
});

test("E2E Integration: Unsigned or untrusted agent authorization cannot trigger payment processing", async () => {
  const h = await setupE2EHarness();
  let worker: ModelAWorker | null = null;
  try {
    const requestId = "e2e_untrusted_01";
    await h.sdkClient.submitModelAPaymentIntent({
      requestId,
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskId: "1",
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "10000",
      expiresAtUnix: String(NOW + 600),
    });

    // Acknowledge delivery
    const ackChallenge = await h.sdkClient.requestAgentInboxChallenge({
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
    });
    const ackSig = bs58.encode(
      nacl.sign.detached(Buffer.from(ackChallenge.message, "utf8"), h.agentKeypair.secretKey)
    );
    await h.sdkClient.acknowledgeAgentInboxItem({
      nonce: ackChallenge.nonce,
      signature: ackSig,
      requestId,
    });

    // Agent decision attempts bare advisory "PAY" without cryptographic identity binding
    worker = new ModelAWorker({
      runtimeDir: h.runtimeDir,
      network: "devnet",
      expectedGenesisHash: GENESIS,
      vault: h.vaultKey.toBase58(),
      rpc: h.rpcMock,
      program: h.programMock,
      adapter: { mode: "simulated" },
      agentSigner: h.agentKeypair,
      now: () => NOW * 1000,
      authorizePayment: async () => ({ decision: "PAY", reason: "Bare advisory PAY callback without bound terms" } as any),
    });

    // Run one tick
    const results = await worker.processPendingIntentsOnce();
    assert.equal(results.length, 0, "Untrusted authorization must not produce any successful execution result");

    // SDK status must remain unclaimed and unexecuted
    const status = await h.sdkClient.getModelAPaymentIntent(requestId);
    assert.equal(status.execution?.status, "unclaimed");
    assert.equal(h.sentRawTxs.length, 0, "No transaction must be sent when authorization is untrusted");

    // Case 2: Forged Ed25519 signature on bound terms
    const forgedAgent = Keypair.generate();
    const forgedDecision: AuthenticatedAgentPaymentDecision = {
      requestId,
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskPda: h.taskPda.toBase58(),
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "10000",
      decision: "PAY",
      authorizedAtUnix: NOW,
    };
    forgedDecision.signature = Buffer.from(
      nacl.sign.detached(encodeAgentPaymentDecision(forgedDecision), forgedAgent.secretKey)
    ).toString("base64");

    const workerForged = new ModelAWorker({
      runtimeDir: h.runtimeDir,
      network: "devnet",
      expectedGenesisHash: GENESIS,
      vault: h.vaultKey.toBase58(),
      rpc: h.rpcMock,
      program: h.programMock,
      adapter: { mode: "simulated" },
      agentSigner: h.agentKeypair,
      now: () => NOW * 1000,
      authorizePayment: async () => forgedDecision,
    });

    const forgedResults = await workerForged.processPendingIntentsOnce();
    assert.equal(forgedResults.length, 0, "Forged signature must fail closed and refuse execution");
    assert.equal(h.sentRawTxs.length, 0);
  } finally {
    if (worker) worker.stop();
    await h.cleanup();
  }
});

test("E2E Integration: Duplicate payment requests cannot produce multiple executions", async () => {
  const h = await setupE2EHarness();
  let worker: ModelAWorker | null = null;
  try {
    const requestId = "e2e_dup_test_01";
    const payload = {
      requestId,
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskId: "1",
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "15000",
      expiresAtUnix: String(NOW + 600),
    };

    // First submission: accepted (202)
    const firstRes = await h.sdkClient.submitModelAPaymentIntent(payload);
    assert.equal(firstRes.status, "received");
    assert.equal(firstRes.duplicate, false);

    // Duplicate submission via SDK: idempotent accepted (200)
    const dupRes = await h.sdkClient.submitModelAPaymentIntent(payload);
    assert.equal(dupRes.status, "received");
    assert.equal(dupRes.duplicate, true);

    // Acknowledge receipt
    const ackChallenge = await h.sdkClient.requestAgentInboxChallenge({
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
    });
    const ackSig = bs58.encode(
      nacl.sign.detached(Buffer.from(ackChallenge.message, "utf8"), h.agentKeypair.secretKey)
    );
    await h.sdkClient.acknowledgeAgentInboxItem({
      nonce: ackChallenge.nonce,
      signature: ackSig,
      requestId,
    });

    const boundDecision: AuthenticatedAgentPaymentDecision = {
      requestId,
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskPda: h.taskPda.toBase58(),
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "15000",
      decision: "PAY",
      authorizedAtUnix: NOW,
    };
    boundDecision.signature = Buffer.from(
      nacl.sign.detached(encodeAgentPaymentDecision(boundDecision), h.agentKeypair.secretKey)
    ).toString("base64");

    worker = new ModelAWorker({
      runtimeDir: h.runtimeDir,
      network: "devnet",
      expectedGenesisHash: GENESIS,
      vault: h.vaultKey.toBase58(),
      rpc: h.rpcMock,
      program: h.programMock,
      adapter: { mode: "simulated" },
      agentSigner: h.agentKeypair,
      now: () => NOW * 1000,
      authorizePayment: async () => boundDecision,
    });

    // First worker run executes payment
    const exec1 = await worker.processPendingIntentsOnce();
    assert.equal(exec1.length, 1);
    assert.equal(exec1[0].status, "confirmed");
    assert.equal(h.sentRawTxs.length, 1);

    // Second worker run must skip already-confirmed request
    const exec2 = await worker.processPendingIntentsOnce();
    assert.equal(exec2.length, 0, "Second worker pass must not re-execute confirmed payment");
    assert.equal(h.sentRawTxs.length, 1, "Raw transactions count must not increase");

    // Resubmitting payment intent again still returns duplicate: true
    const dupRes3 = await h.sdkClient.submitModelAPaymentIntent(payload);
    assert.equal(dupRes3.duplicate, true);
  } finally {
    if (worker) worker.stop();
    await h.cleanup();
  }
});

test("E2E Integration: Worker restart does not cause duplicate payment execution", async () => {
  const h = await setupE2EHarness();
  try {
    const requestId = "e2e_restart_test_01";
    await h.sdkClient.submitModelAPaymentIntent({
      requestId,
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskId: "1",
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "12000",
      expiresAtUnix: String(NOW + 600),
    });

    const ackChallenge = await h.sdkClient.requestAgentInboxChallenge({
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
    });
    const ackSig = bs58.encode(
      nacl.sign.detached(Buffer.from(ackChallenge.message, "utf8"), h.agentKeypair.secretKey)
    );
    await h.sdkClient.acknowledgeAgentInboxItem({
      nonce: ackChallenge.nonce,
      signature: ackSig,
      requestId,
    });

    const boundDecision: AuthenticatedAgentPaymentDecision = {
      requestId,
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskPda: h.taskPda.toBase58(),
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "12000",
      decision: "PAY",
      authorizedAtUnix: NOW,
    };
    boundDecision.signature = Buffer.from(
      nacl.sign.detached(encodeAgentPaymentDecision(boundDecision), h.agentKeypair.secretKey)
    ).toString("base64");

    // Worker 1 starts, processes payment, and shuts down
    const worker1 = new ModelAWorker({
      runtimeDir: h.runtimeDir,
      network: "devnet",
      expectedGenesisHash: GENESIS,
      vault: h.vaultKey.toBase58(),
      rpc: h.rpcMock,
      program: h.programMock,
      adapter: { mode: "simulated" },
      agentSigner: h.agentKeypair,
      pollIntervalMs: 50,
      now: () => NOW * 1000,
      authorizePayment: async () => boundDecision,
    });

    const exec1 = await worker1.processPendingIntentsOnce();
    assert.equal(exec1.length, 1);
    assert.equal(exec1[0].status, "confirmed");
    const sig1 = exec1[0].signature;
    assert.ok(sig1);

    // Simulate Worker 1 process termination
    worker1.stop();
    assert.equal(worker1.isRunning(), false);

    // Worker 2 starts up fresh against the same runtime directory
    const worker2 = new ModelAWorker({
      runtimeDir: h.runtimeDir,
      network: "devnet",
      expectedGenesisHash: GENESIS,
      vault: h.vaultKey.toBase58(),
      rpc: h.rpcMock,
      program: h.programMock,
      adapter: { mode: "simulated" },
      agentSigner: h.agentKeypair,
      pollIntervalMs: 50,
      now: () => NOW * 1000,
      authorizePayment: async () => boundDecision,
    });

    const exec2 = await worker2.processPendingIntentsOnce();
    assert.equal(exec2.length, 0, "Worker 2 must detect previously confirmed request and skip execution");
    assert.equal(h.sentRawTxs.length, 1, "No duplicate transactions sent after worker restart");

    // SDK status remains intact with original signature
    const finalStatus = await h.sdkClient.getModelAPaymentIntent(requestId);
    assert.equal(finalStatus.execution?.status, "confirmed");
    assert.equal(finalStatus.execution?.signature, sig1);
    assert.equal(finalStatus.execution?.nonce, "0");

    worker2.stop();
  } finally {
    await h.cleanup();
  }
});

test("E2E Integration: Concurrency & cross-process task locking prevents nonce races", async () => {
  const h = await setupE2EHarness();
  try {
    const requestId = "e2e_lock_race_01";
    await h.sdkClient.submitModelAPaymentIntent({
      requestId,
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskId: "1",
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "8000",
      expiresAtUnix: String(NOW + 600),
    });

    const ackChallenge = await h.sdkClient.requestAgentInboxChallenge({
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
    });
    const ackSig = bs58.encode(
      nacl.sign.detached(Buffer.from(ackChallenge.message, "utf8"), h.agentKeypair.secretKey)
    );
    await h.sdkClient.acknowledgeAgentInboxItem({
      nonce: ackChallenge.nonce,
      signature: ackSig,
      requestId,
    });

    // Acquire cross-process lock manually to simulate another active worker process
    const externalLock = new CrossProcessTaskLock();
    const lockAcquired = externalLock.acquire(h.runtimeDir, h.taskPda.toBase58());
    assert.equal(lockAcquired, true, "External worker must successfully acquire lock");

    const boundDecision: AuthenticatedAgentPaymentDecision = {
      requestId,
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskPda: h.taskPda.toBase58(),
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "8000",
      decision: "PAY",
      authorizedAtUnix: NOW,
    };
    boundDecision.signature = Buffer.from(
      nacl.sign.detached(encodeAgentPaymentDecision(boundDecision), h.agentKeypair.secretKey)
    ).toString("base64");

    const worker = new ModelAWorker({
      runtimeDir: h.runtimeDir,
      network: "devnet",
      expectedGenesisHash: GENESIS,
      vault: h.vaultKey.toBase58(),
      rpc: h.rpcMock,
      program: h.programMock,
      adapter: { mode: "simulated" },
      agentSigner: h.agentKeypair,
      now: () => NOW * 1000,
      authorizePayment: async () => boundDecision,
    });

    // Process attempt must gracefully skip locked task without crashing or executing
    const intentRecord = (await h.sdkClient.getModelAPaymentIntent(requestId)) as any;
    const result = await worker.processPaymentIntent(intentRecord);
    assert.equal(result.status, "skipped", "Worker must skip task locked by another process");
    assert.equal(h.sentRawTxs.length, 0, "No transaction broadcast while locked");

    // Release external lock
    externalLock.release();

    // Now worker can acquire lock and process cleanly
    const retryResult = await worker.processPaymentIntent(intentRecord);
    assert.equal(retryResult.status, "confirmed");
    assert.equal(h.sentRawTxs.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("E2E Integration: Crash recovery preserves prepared transactions without bypassing unresolved states", async () => {
  const h = await setupE2EHarness();
  try {
    const requestId = "e2e_recovery_test_01";
    await h.sdkClient.submitModelAPaymentIntent({
      requestId,
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskId: "1",
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "9000",
      expiresAtUnix: String(NOW + 600),
    });

    const ackChallenge = await h.sdkClient.requestAgentInboxChallenge({
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
    });
    const ackSig = bs58.encode(
      nacl.sign.detached(Buffer.from(ackChallenge.message, "utf8"), h.agentKeypair.secretKey)
    );
    await h.sdkClient.acknowledgeAgentInboxItem({
      nonce: ackChallenge.nonce,
      signature: ackSig,
      requestId,
    });

    const boundDecision: AuthenticatedAgentPaymentDecision = {
      requestId,
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      taskPda: h.taskPda.toBase58(),
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "9000",
      decision: "PAY",
      authorizedAtUnix: NOW,
    };
    boundDecision.signature = Buffer.from(
      nacl.sign.detached(encodeAgentPaymentDecision(boundDecision), h.agentKeypair.secretKey)
    ).toString("base64");

    // Create worker without broadcast capability to leave transaction in prepared journal state
    const workerPrep = new ModelAWorker({
      runtimeDir: h.runtimeDir,
      network: "devnet",
      expectedGenesisHash: GENESIS,
      vault: h.vaultKey.toBase58(),
      rpc: {
        ...h.rpcMock,
        sendRawTransaction: undefined, // no broadcast
        confirmTransaction: undefined,
      },
      program: h.programMock,
      adapter: { mode: "simulated" },
      agentSigner: h.agentKeypair,
      now: () => NOW * 1000,
      authorizePayment: async () => boundDecision,
    });

    const intentRecord = (await h.sdkClient.getModelAPaymentIntent(requestId)) as any;
    const prepResult = await workerPrep.processPaymentIntent(intentRecord);
    assert.equal(prepResult.status, "prepared");
    const preparedSig = prepResult.signature;
    assert.ok(preparedSig);

    // Verify prepared files on disk
    const prepared = loadPreparedPayment(h.runtimeDir, requestId);
    assert.equal(bs58.encode(prepared.transaction.signature!), preparedSig);

    // Call recoverRequest to simulate restart after crash/timeout
    const recovery = await workerPrep.recoverRequest(requestId);
    assert.equal(recovery.signature, preparedSig);
    assert.equal(recovery.nonce, "0");

    const execStatus = readModelAPaymentExecution(h.runtimeDir, requestId);
    assert.equal(execStatus.claimed, true);
    assert.equal(execStatus.prepared, true);
    assert.equal(execStatus.status, "prepared");
    assert.equal(bs58.encode(Buffer.from(execStatus.signature!, "base64")), preparedSig);
    assert.notEqual(execStatus.status, "failed_on_chain");
  } finally {
    await h.cleanup();
  }
});

test("E2E Integration: Model B lifecycle: pending request -> owner approval -> durable storage without broadcasting", async () => {
  const h = await setupE2EHarness();
  try {
    const rawWorkflow: WorkflowApprovalV2 = {
      version: 2,
      authorizationModel: "model-b",
      network: "devnet",
      requestId: "model_b_e2e_req_01",
      genesisHash: GENESIS,
      programId: AGENTVAULT_PROGRAM_ID.toBase58(),
      vault: h.vaultKey.toBase58(),
      owner: h.ownerKeypair.publicKey.toBase58(),
      mint: h.mintKeypair.publicKey.toBase58(),
      assignedAgent: "agent-b",
      agentAuthority: h.agentKeypair.publicKey.toBase58(),
      kind: "procurement",
      taskId: 1,
      recipient: h.recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: 30000,
      expiresAtUnix: NOW + 1200,
      description: "Quarterly server infrastructure renewal",
    };

    const signedWorkflow = {
      workflow: rawWorkflow,
      signature: Buffer.from(
        nacl.sign.detached(encodeWorkflowV2(rawWorkflow), h.ownerKeypair.secretKey)
      ).toString("base64"),
    };

    // Owner requests challenge
    const challengeRes = await fetch(
      `${h.baseUrl}/owner-vault/auth/challenge?owner=${h.ownerKeypair.publicKey.toBase58()}&vault=${h.vaultKey.toBase58()}`,
      {
        method: "GET",
        headers: {
          Origin: FRONTEND_ORIGIN,
        },
      }
    );
    assert.equal(challengeRes.status, 200);
    const challengeData = (await challengeRes.json()) as { message: string; nonce: string };

    const loginSig = Buffer.from(
      nacl.sign.detached(Buffer.from(challengeData.message, "utf8"), h.ownerKeypair.secretKey)
    ).toString("base64");

    const loginRes = await fetch(`${h.baseUrl}/owner-vault/auth/login`, {
      method: "POST",
      headers: {
        Origin: FRONTEND_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        nonce: challengeData.nonce,
        publicKey: h.ownerKeypair.publicKey.toBase58(),
        vault: h.vaultKey.toBase58(),
        signature: loginSig,
      }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(cookie);

    // Submit pending request
    const pendingSubmitRes = await fetch(`${h.baseUrl}/owner-vault/api/pending-requests`, {
      method: "POST",
      headers: {
        Origin: FRONTEND_ORIGIN,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: rawWorkflow.requestId,
        recipient: rawWorkflow.recipient,
        amountBaseUnits: String(rawWorkflow.amountBaseUnits),
        expiresAtUnix: String(rawWorkflow.expiresAtUnix),
        agentAuthority: rawWorkflow.agentAuthority,
        taskId: String(rawWorkflow.taskId),
        signedWorkflow,
      }),
    });
    assert.equal(pendingSubmitRes.status, 201);

    // 2. Owner reads pending requests queue via /owner-vault/api/approvals
    const pendingListRes = await fetch(`${h.baseUrl}/owner-vault/api/approvals`, {
      method: "GET",
      headers: {
        Origin: FRONTEND_ORIGIN,
        Cookie: cookie,
      },
    });
    assert.equal(pendingListRes.status, 200);
    const pendingData = (await pendingListRes.json()) as { approvals: any[] };
    assert.ok(pendingData.approvals.length >= 1);
    const foundPending = pendingData.approvals.find(
      (p) => p.requestId === rawWorkflow.requestId && p.status === "pending_owner_approval"
    );
    assert.ok(foundPending);
    assert.equal(foundPending.amountBaseUnits, "30000");

    // 3. Owner signs PaymentApprovalV2 bound to pending request
    const paymentApproval: PaymentApprovalV2 = {
      version: 2,
      genesisHash: GENESIS,
      programId: AGENTVAULT_PROGRAM_ID.toBase58(),
      vault: h.vaultKey.toBase58(),
      owner: h.ownerKeypair.publicKey.toBase58(),
      mint: h.mintKeypair.publicKey.toBase58(),
      agent: h.agentPda.toBase58(),
      agentAuthority: rawWorkflow.agentAuthority,
      task: h.taskPda.toBase58(),
      recipient: rawWorkflow.recipient,
      amountBaseUnits: "30000",
      expiresAtUnix: String(rawWorkflow.expiresAtUnix),
      nonce: "0",
      requestId: rawWorkflow.requestId,
    };

    const encodedApproval = encodePaymentApprovalV2(paymentApproval);
    const approvalSig = Buffer.from(
      nacl.sign.detached(encodedApproval, h.ownerKeypair.secretKey)
    ).toString("base64");

    // 4. Submit approval
    const approvalRes = await fetch(`${h.baseUrl}/owner-vault/api/approvals`, {
      method: "POST",
      headers: {
        Origin: FRONTEND_ORIGIN,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentApproval,
        signatureBase64: approvalSig,
      }),
    });
    assert.equal(approvalRes.status, 200);
    const approvalSaved = (await approvalRes.json()) as {
      ok: boolean;
      requestId: string;
      status: string;
      notice?: string;
    };
    assert.equal(approvalSaved.ok, true);
    assert.equal(approvalSaved.status, "approved_pending_execution");
    assert.equal(approvalSaved.requestId, rawWorkflow.requestId);

    // 5. Owner retrieves stored approvals
    const readApprovalsRes = await fetch(`${h.baseUrl}/owner-vault/api/approvals`, {
      method: "GET",
      headers: {
        Origin: FRONTEND_ORIGIN,
        Cookie: cookie,
      },
    });
    assert.equal(readApprovalsRes.status, 200);
    const approvalsList = (await readApprovalsRes.json()) as { approvals: any[] };
    assert.ok(approvalsList.approvals.length >= 1);
    const approvedItem = approvalsList.approvals.find(
      (a: any) =>
        a.requestId === rawWorkflow.requestId &&
        a.status === "approved_pending_execution"
    );
    assert.ok(
      approvedItem,
      "Approved request should appear in owner approvals with approved_pending_execution status"
    );

    // 6. Verify that broadcast is NOT triggered and approval file is persisted durably
    const storedApprovalPath = join(
      h.runtimeDir,
      "approvals",
      `${rawWorkflow.requestId}.payment.json`
    );
    assert.ok(existsSync(storedApprovalPath), "Payment approval file must be persisted on disk");
    const pendingFile = join(
      h.runtimeDir,
      "model-b-pending",
      `${rawWorkflow.requestId}.json`
    );
    assert.ok(!existsSync(pendingFile), "Pending item must be cleaned up after approval");
    const foundApproval = approvalsList.approvals.find((a) => a.requestId === rawWorkflow.requestId);
    assert.ok(foundApproval);
    assert.equal(foundApproval.amountBaseUnits, "30000");

    // Verify broadcast boundary remains intact: no transactions broadcast for Model B
    assert.equal(h.sentRawTxs.length, 0, "Model B broadcasting must remain strictly disabled");
  } finally {
    await h.cleanup();
  }
});
