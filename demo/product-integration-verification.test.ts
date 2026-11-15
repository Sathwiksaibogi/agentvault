/**
 * Real Product Integration Verification (Phase 5 - Priority 3).
 *
 * Starts the real backend server locally and verifies:
 * 1. Developer SDK submits payment intent to running backend (POST /api/model-a/payment-intents)
 * 2. Agent inbox receives and acknowledges it (challenge, poll, ack)
 * 3. Model A Worker processes the authenticated test-agent decision unattended
 * 4. Payment status is available through the developer SDK/API
 * 5. Dashboard activity API reflects the payment outcome
 * 6. Model B pending requests appear in the owner approval interface (/owner-vault/api/approvals)
 *
 * NOTE: Uses local test fixtures and mock mode for payment execution;
 * does NOT claim mock transactions represent live on-chain Solana transactions.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AgentVaultClient } from "../sdk/src/index.js";
import {
  ModelAWorker,
  encodeAgentPaymentDecision,
  type AuthenticatedAgentPaymentDecision,
} from "./model-a-worker";
import { createApiHandler } from "./api-handler";
import { createModelAPaymentHttpHandler } from "./model-a-payment-http";
import { createModelAAgentInboxHttpHandler } from "./model-a-agent-inbox";
import { createSelectedVaultSessionHandler } from "./selected-vault-dashboard-session";
import { issueDeveloperApiKey } from "./api-key-issuance.js";
import { InMemoryDeveloperApiKeyRepository } from "./api-key-memory-repository";

const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const AGENTVAULT_PROGRAM = new PublicKey("BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d");
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";

test("Product Integration: full end-to-end flow with running server, SDK, Agent Inbox, Worker, Dashboard and Model B approvals", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-product-int-"));
  const runtimeDir = join(root, "runtime");
  mkdirSync(runtimeDir, { recursive: true });

  const ownerKeypair = Keypair.generate();
  const agentKeypair = Keypair.generate();
  const recipientKeypair = Keypair.generate();
  const mintKeypair = Keypair.generate();

  const vaultId = BigInt(1);
  const u64VaultId = Buffer.alloc(8);
  u64VaultId.writeBigUInt64LE(vaultId);

  const [vaultKey, vaultBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), ownerKeypair.publicKey.toBuffer(), u64VaultId],
    AGENTVAULT_PROGRAM
  );
  const [agentPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("agent"),
      vaultKey.toBuffer(),
      agentKeypair.publicKey.toBuffer(),
    ],
    AGENTVAULT_PROGRAM
  );
  const taskIdBn = new BN(1);
  const [taskPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("task"),
      agentPda.toBuffer(),
      taskIdBn.toArrayLike(Buffer, "le", 8),
    ],
    AGENTVAULT_PROGRAM
  );

  const [treasuryAta] = PublicKey.findProgramAddressSync(
    [vaultKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Build binary buffers matching owner-vault-verifier on-chain requirements
  const vaultData = Buffer.alloc(90);
  nacl.hash(Buffer.from("account:Vault")).subarray(0, 8); // Anchor discriminator
  const disc = Buffer.from([211, 8, 232, 43, 2, 152, 117, 119]); // SHA256("account:Vault")[:8]
  disc.copy(vaultData, 0, 0, 8);
  ownerKeypair.publicKey.toBuffer().copy(vaultData, 8);
  mintKeypair.publicKey.toBuffer().copy(vaultData, 40);
  vaultData.writeBigUInt64LE(vaultId, 72);
  vaultData.writeBigUInt64LE(BigInt(100_000), 80);
  vaultData[89] = vaultBump;

  const tokenData = Buffer.alloc(165);
  mintKeypair.publicKey.toBuffer().copy(tokenData, 0);
  vaultKey.toBuffer().copy(tokenData, 32);
  tokenData.writeBigUInt64LE(BigInt(1_000_000), 64);
  tokenData[108] = 1;

  const mintData = Buffer.alloc(82);
  mintData[44] = 6;
  mintData[45] = 1;

  const keyRepo = new InMemoryDeveloperApiKeyRepository();
  const now = Math.floor(Date.now() / 1000);

  const ownerPrincipal = {
    role: "owner" as const,
    vaults: [vaultKey.toBase58()],
  };

  const devKey = await issueDeveloperApiKey({
    issuer: ownerPrincipal,
    principalId: "product-dev-01",
    vault: vaultKey.toBase58(),
    scopes: ["payments:request"],
    expiresAt: (now + 3600) * 1000,
    now: now * 1000,
    repository: keyRepo,
  });

  const activityKey = await issueDeveloperApiKey({
    issuer: ownerPrincipal,
    principalId: "product-activity-01",
    vault: vaultKey.toBase58(),
    scopes: ["activity:read"],
    expiresAt: (now + 3600) * 1000,
    now: now * 1000,
    repository: keyRepo,
  });

  let simulatedSlot = 1000;
  const recordedActivities: any[] = [];

  const mockRpc: any = {
    getGenesisHash: async () => GENESIS,
    getLatestBlockhash: async () => ({
      blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
      lastValidBlockHeight: 1000,
    }),
    getBlockHeight: async () => 500,
    getAccountInfo: async (addr: PublicKey) => {
      if (addr.equals(SYSVAR_CLOCK_PUBKEY)) {
        const b = Buffer.alloc(40);
        b.writeBigInt64LE(BigInt(now), 32);
        return { data: b, executable: false, owner: PublicKey.default, lamports: 1000000 };
      }
      if (addr.equals(vaultKey)) {
        return { data: vaultData, executable: false, owner: AGENTVAULT_PROGRAM, lamports: 1000000 };
      }
      if (addr.equals(treasuryAta)) {
        return { data: tokenData, executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1000000 };
      }
      if (addr.equals(mintKeypair.publicKey)) {
        return { data: mintData, executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1000000 };
      }
      return null;
    },
    sendRawTransaction: async (raw: Buffer) => {
      const tx = Transaction.from(raw);
      return bs58.encode(tx.signature!);
    },
    confirmTransaction: async () => {
      simulatedSlot += 1;
      return {
        context: { slot: simulatedSlot },
        value: { err: null, confirmationStatus: "confirmed" },
      };
    },
  };

  const programMock: any = {
    programId: AGENTVAULT_PROGRAM,
    account: {
      vault: {
        fetch: async () => ({
          owner: ownerKeypair.publicKey,
          tokenMint: mintKeypair.publicKey,
          vaultId: new BN(0),
          paused: false,
          totalReserved: new BN(100000),
        }),
      },
      agent: {
        fetch: async () => ({
          vault: vaultKey,
          authority: agentKeypair.publicKey,
          active: true,
        }),
      },
      task: {
        fetch: async () => ({
          vault: vaultKey,
          agent: agentPda,
          taskId: taskIdBn,
          recipient: recipientKeypair.publicKey,
          budget: new BN(100000),
          spent: new BN(0),
          nextNonce: new BN(0),
          expiresAt: new BN(now + 3600),
          active: true,
        }),
      },
    },
    methods: {
      executeTaskPayment(amount: BN, nonce: BN) {
        return {
          accountsPartial(accounts: any) {
            return {
              async instruction() {
                return new TransactionInstruction({
                  programId: AGENTVAULT_PROGRAM,
                  data: Buffer.alloc(0),
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

  // Build HTTP Server
  const apiHandler = createApiHandler({
    network: "devnet",
    runtimeVault: vaultKey.toBase58(),
    credentials: {
      ownerToken: "test_owner_secret_token_1234567890abcdef",
      developerToken: "test_developer_secret_token_1234567890abcdef",
      developerVault: vaultKey.toBase58(),
    },
    lookupDeveloperKey: (keyId) => keyRepo.findById(keyId),
    cachedRead: async (_k, loader) => loader(),
    readers: {
      getTreasuryData: async () => ({
        network: "devnet",
        vault: vaultKey.toBase58(),
        owner: ownerKeypair.publicKey.toBase58(),
        mint: mintKeypair.publicKey.toBase58(),
        treasury: "test_treasury_pda",
        balanceBaseUnits: "100000",
        totalReservedBaseUnits: "50000",
        unreservedBaseUnits: "50000",
        paused: false,
      }),
      getAgentsData: async () => ({
        network: "devnet",
        vault: vaultKey.toBase58(),
        agents: [],
      }),
      getWorkflowIds: async () => ({ network: "devnet", vault: vaultKey.toBase58(), workflows: [] }),
      getWorkflowData: async () => null,
      getActivityData: async () => ({
        network: "devnet",
        vault: vaultKey.toBase58(),
        activity: recordedActivities,
      }),
    },
  });

  const dashboardHandler = createSelectedVaultSessionHandler({
    fallbackHandler: apiHandler,
    rpc: mockRpc,
    network: "devnet",
    expectedGenesisHash: GENESIS,
    frontendOrigin: FRONTEND_ORIGIN,
    runtimeDir,
    readScopedActivity: async () => ({
      network: "devnet",
      vault: vaultKey.toBase58(),
      activity: recordedActivities,
    }),
    readScopedAgents: async () => ({
      network: "devnet",
      vault: vaultKey.toBase58(),
      owner: ownerKeypair.publicKey.toBase58(),
      agents: [
        {
          agentPda: agentPda.toBase58(),
          authority: agentKeypair.publicKey.toBase58(),
          active: true,
          tasks: [
            {
              taskPda: taskPda.toBase58(),
              taskId: 1,
              recipient: recipientKeypair.publicKey.toBase58(),
              budgetBaseUnits: "100000",
              spentBaseUnits: "0",
              remainingBaseUnits: "100000",
              expiresAtUnix: now + 3600,
              nextNonce: "0",
              active: true,
            },
          ],
        },
      ],
    }),
  });

  const paymentHttpHandler = createModelAPaymentHttpHandler({
    fallbackHandler: dashboardHandler,
    lookupDeveloperKey: (keyId) => keyRepo.findById(keyId),
    network: "devnet",
    runtimeDir,
    expectedGenesisHash: GENESIS,
    getGenesisHash: async () => GENESIS,
    checkPolicy: async () => ({
      ok: true,
      agentPda,
      taskPda,
      expectedRecipient: recipientKeypair.publicKey,
      remainingBaseUnits: new BN(100000),
      nextNonce: new BN(0),
    }),
  });

  const inboxHttpHandler = createModelAAgentInboxHttpHandler({
    fallbackHandler: paymentHttpHandler,
    network: "devnet",
    runtimeDir,
    expectedGenesisHash: GENESIS,
    getGenesisHash: async () => GENESIS,
    verifyAgent: async ({ vault, agentAuthority }) => {
      if (
        vault !== vaultKey.toBase58() ||
        agentAuthority !== agentKeypair.publicKey.toBase58()
      ) {
        throw new Error("Agent not authorized for this vault");
      }
    },
  });

  const server = createServer(inboxHttpHandler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const devClient = new AgentVaultClient({
      baseUrl: `${baseUrl}/`,
      token: devKey.token,
    });

    const activityClient = new AgentVaultClient({
      baseUrl: `${baseUrl}/`,
      token: activityKey.token,
    });

    // 1. Developer SDK submits payment intent
    const requestId = "prod_intent_001";
    const submitted = await devClient.submitModelAPaymentIntent({
      requestId,
      agentAuthority: agentKeypair.publicKey.toBase58(),
      taskId: "1",
      recipient: recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "25000",
      expiresAtUnix: String(now + 1800),
    });
    assert.equal(submitted.duplicate, false);
    assert.equal(submitted.status, "received");

    // 2. Agent receives intent via Inbox and Acknowledges delivery
    const pollChallenge = await devClient.requestAgentInboxChallenge({
      vault: vaultKey.toBase58(),
      agentAuthority: agentKeypair.publicKey.toBase58(),
    });

    const pollSig = bs58.encode(
      nacl.sign.detached(
        Buffer.from(pollChallenge.message, "utf8"),
        agentKeypair.secretKey
      )
    );

    const polled = await devClient.pollAgentInbox({
      nonce: pollChallenge.nonce,
      signature: pollSig,
    });
    assert.equal(polled.items.length, 1);
    assert.equal(polled.items[0].request.requestId, requestId);

    const ackChallenge = await devClient.requestAgentInboxChallenge({
      vault: vaultKey.toBase58(),
      agentAuthority: agentKeypair.publicKey.toBase58(),
    });

    const ackSig = bs58.encode(
      nacl.sign.detached(
        Buffer.from(ackChallenge.message, "utf8"),
        agentKeypair.secretKey
      )
    );

    const ack = await devClient.acknowledgeAgentInboxItem({
      nonce: ackChallenge.nonce,
      signature: ackSig,
      requestId,
    });
    assert.equal(ack.duplicate, false);

    // 3. Agent provides authenticated decision
    const decision: AuthenticatedAgentPaymentDecision = {
      decision: "PAY",
      requestId,
      vault: vaultKey.toBase58(),
      agentAuthority: agentKeypair.publicKey.toBase58(),
      taskPda: taskPda.toBase58(),
      recipient: recipientKeypair.publicKey.toBase58(),
      amountBaseUnits: "25000",
      expiresAtUnix: now + 1800,
      reason: "Approved product payment",
      signature: "",
    };
    const decisionBytes = encodeAgentPaymentDecision(decision);
    decision.signature = Buffer.from(
      nacl.sign.detached(decisionBytes, agentKeypair.secretKey)
    ).toString("base64");

    // 4. Worker executes unattended
    const worker = new ModelAWorker({
      runtimeDir,
      network: "devnet",
      expectedGenesisHash: GENESIS,
      vault: vaultKey.toBase58(),
      rpc: mockRpc,
      program: programMock,
      agentSigner: agentKeypair,
      adapter: { mode: "simulated" },
      readAck: () => ({ acknowledged: true, acknowledgedAtUnix: now }),
      authorizePayment: async () => decision,
    });

    const executionResults = await worker.processPendingIntentsOnce();
    assert.equal(executionResults.length, 1);
    assert.equal(executionResults[0].status, "confirmed");
    assert.ok(executionResults[0].signature);

    // Track activity for dashboard inspection
    recordedActivities.push({
      signature: executionResults[0].signature,
      slot: simulatedSlot,
      blockTimeUnix: now,
      agentId: "agent-a",
      workflow: "procurement",
      taskId: 1,
      taskPda: taskPda.toBase58(),
      succeeded: true,
      explorerUrl: `https://explorer.solana.com/tx/${executionResults[0].signature}?cluster=devnet`,
    });

    // 5. Developer SDK queries payment status through API
    const fetchedIntent = await devClient.getModelAPaymentIntent(requestId);
    assert.equal(fetchedIntent.execution?.status, "confirmed");
    assert.equal(fetchedIntent.execution?.signature, executionResults[0].signature);
    assert.equal(fetchedIntent.request.amountBaseUnits, "25000");

    // 6. Owner activity endpoint returns confirmed payment
    const activityList = await activityClient.listActivity();
    assert.equal(activityList.length, 1);
    assert.equal(activityList[0].signature, executionResults[0].signature);

    // 7. Model B pending request appears in dashboard approval interface
    const modelBPendingDir = join(runtimeDir, "model-b-pending");
    mkdirSync(modelBPendingDir, { recursive: true });
    const modelBReqId = "model_b_pending_prod_01";
    writeFileSync(
      join(modelBPendingDir, `${modelBReqId}.json`),
      JSON.stringify(
        {
          version: 2,
          network: "devnet",
          requestId: modelBReqId,
          vault: vaultKey.toBase58(),
          agentAuthority: agentKeypair.publicKey.toBase58(),
          recipient: recipientKeypair.publicKey.toBase58(),
          amountBaseUnits: "15000",
          nonce: "0",
          expiresAtUnix: String(now + 1800),
          createdAtUnix: now,
        },
        null,
        2
      )
    );

    // Perform owner dashboard authentication
    const challengeRes = await fetch(
      `${baseUrl}/owner-vault/auth/challenge?owner=${ownerKeypair.publicKey.toBase58()}&vault=${vaultKey.toBase58()}`
    );
    assert.equal(challengeRes.status, 200);
    const ownerChallenge = (await challengeRes.json()) as {
      nonce: string;
      message: string;
      ownerPublicKey: string;
      vaultPublicKey: string;
    };

    const ownerSig = Buffer.from(
      nacl.sign.detached(
        Buffer.from(ownerChallenge.message, "utf8"),
        ownerKeypair.secretKey
      )
    ).toString("base64");

    const ownerLoginRes = await fetch(`${baseUrl}/owner-vault/auth/login`, {
      method: "POST",
      headers: {
        Origin: FRONTEND_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        nonce: ownerChallenge.nonce,
        publicKey: ownerKeypair.publicKey.toBase58(),
        vault: vaultKey.toBase58(),
        signature: ownerSig,
      }),
    });
    assert.equal(ownerLoginRes.status, 200);
    const cookie = ownerLoginRes.headers.get("set-cookie")?.split(";")[0]!;
    assert.ok(cookie);

    // Query /owner-vault/api/approvals through authenticated dashboard session
    const approvalsRes = await fetch(`${baseUrl}/owner-vault/api/approvals`, {
      method: "GET",
      headers: {
        Origin: FRONTEND_ORIGIN,
        Cookie: cookie,
      },
    });
    assert.equal(approvalsRes.status, 200);
    const approvalsData = (await approvalsRes.json()) as { approvals: any[] };
    const pendingItem = approvalsData.approvals.find((a: any) => a.requestId === modelBReqId);
    assert.ok(pendingItem, "Model B request must appear in owner approvals queue");
    assert.equal(pendingItem.status, "pending_owner_approval");
    assert.equal(pendingItem.amountBaseUnits, "15000");

    console.log("✔ Real Product Integration Verification: all 6 boundaries confirmed passing!");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
