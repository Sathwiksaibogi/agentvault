import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { createApiHandler } from "./api-handler";
import { createOwnerDashboardSessionHandler } from "./owner-dashboard-session";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBoundedRpcFetch } from "./api-rpc-security";
import { configureApiHttpServer } from "./api-http-security";
import { createApiReadCache } from "./api-read-cache";
import { mapWithConcurrency } from "./api-concurrency";
import { createRpcConcurrencyGate } from "./api-rpc-concurrency";

import { createApiDatabase, verifyApiDatabase } from "./api-database";

import { verifySavedPaymentIntegrity } from "./saved-payment-integrity";
import { Connection, PublicKey } from "@solana/web3.js";

import { getAccount, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import type { Agentvault } from "../target/types/agentvault";
import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";

import bs58 from "bs58";

import { existsSync, readdirSync } from "node:fs";

import { SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

import {
  signedWorkflowSchema,
  verifyWorkflowApproval,
  type ApprovalScope,
} from "./signed-workflow";

import { loadApiCredentials } from "./api-auth";

import { classifyPayment } from "./payment-recovery-state";
type DemoState = {
  genesisHash: string;
  programId: string;
  vault: string;
  owner: string;
  mint: string;
  treasury: string;
  vaultId: string;
};

const PORT = 8787;
const HOST = "127.0.0.1";

const API_CREDENTIALS = loadApiCredentials(process.env);

const DEMO_AGENTS = [
  {
    id: "agent-a",
    name: "Procurement Agent",
    workflow: "procurement",
    authority: "24y99x9EPoJ2ToqygjM37eU9AXz3aFwiDcHFv87LXQfQ",
    taskId: 1,
  },
  {
    id: "agent-b",
    name: "Operations Agent",
    workflow: "operations",
    authority: "5qHQ9f5E6vQ91JhrDRbbBLpSFudzRBGNdvpXkT1iDLxT",
    taskId: 1,
  },
] as const;

const state = JSON.parse(
  readFileSync(join(RUNTIME_DIR, "state.json"), "utf8")
) as DemoState;

const idl = JSON.parse(
  readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
) as Agentvault;

const rpcConcurrencyGate = createRpcConcurrencyGate({
  maxActive: 8,
  maxQueued: 32,
  queueTimeoutMs: 5_000,
});

const boundedRpcFetch = createBoundedRpcFetch(fetch);

const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  fetch: (input, init) =>
    rpcConcurrencyGate.run(() => boundedRpcFetch(input, init), init?.signal),
  disableRetryOnRateLimit: true,
});

const program = new anchor.Program<Agentvault>(idl, {
  connection,
});

assert.equal(program.programId.toBase58(), state.programId);

const { cachedRead } = createApiReadCache();

async function getTreasuryData() {
  const vaultPda = new PublicKey(state.vault);
  const treasuryPda = new PublicKey(state.treasury);
  const mintPda = new PublicKey(state.mint);

  const [genesisHash, vault, treasury, mint] = await Promise.all([
    connection.getGenesisHash(),
    program.account.vault.fetch(vaultPda, "confirmed"),
    getAccount(connection, treasuryPda, "confirmed", TOKEN_PROGRAM_ID),
    getMint(connection, mintPda, "confirmed", TOKEN_PROGRAM_ID),
  ]);

  assert.equal(genesisHash, state.genesisHash);
  assert.equal(vault.owner.toBase58(), state.owner);
  assert.equal(vault.tokenMint.toBase58(), state.mint);
  assert.equal(vault.vaultId.toString(), state.vaultId);

  assert.ok(treasury.owner.equals(vaultPda));
  assert.ok(treasury.mint.equals(mintPda));

  const balance = treasury.amount;
  const reserved = BigInt(vault.totalReserved.toString());

  assert.ok(reserved <= balance, "Treasury reservation invariant violated");

  return {
    network: NETWORK,
    vault: state.vault,
    owner: state.owner,
    tokenMint: state.mint,
    treasury: state.treasury,
    vaultId: state.vaultId,
    decimals: mint.decimals,
    paused: vault.paused,
    balanceBaseUnits: balance.toString(),
    reservedBaseUnits: reserved.toString(),
    availableBaseUnits: (balance - reserved).toString(),
  };
}

async function getAgentsData() {
  assert.equal(NETWORK, "devnet", "Demo agent API currently supports Devnet");

  const genesisHash = await connection.getGenesisHash();

  assert.equal(
    genesisHash,
    state.genesisHash,
    "RPC is connected to an unexpected ledger"
  );

  const vaultPda = new PublicKey(state.vault);

  const agents = await Promise.all(
    DEMO_AGENTS.map(async (config) => {
      const authority = new PublicKey(config.authority);
      const taskId = new BN(config.taskId);

      // Derive the registered agent PDA.
      const [agentPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), vaultPda.toBuffer(), authority.toBuffer()],
        program.programId
      );

      // Derive the agent's task PDA.
      const [taskPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("task"),
          agentPda.toBuffer(),
          taskId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      // Read actual on-chain accounts.
      const [agent, task] = await Promise.all([
        program.account.agent.fetch(agentPda, "confirmed"),
        program.account.task.fetch(taskPda, "confirmed"),
      ]);

      // Verify account relationships.
      assert.ok(agent.vault.equals(vaultPda));
      assert.ok(agent.authority.equals(authority));

      assert.ok(task.vault.equals(vaultPda));
      assert.ok(task.agent.equals(agentPda));
      assert.ok(task.taskId.eq(taskId));

      const budget = BigInt(task.budget.toString());
      const spent = BigInt(task.spent.toString());

      assert.ok(spent <= budget, "Task spending exceeds its budget");

      return {
        id: config.id,
        name: config.name,
        workflow: config.workflow,
        authority: authority.toBase58(),
        agentPda: agentPda.toBase58(),
        active: agent.active,

        task: {
          taskId: config.taskId,
          taskPda: taskPda.toBase58(),
          active: task.active,
          recipient: task.recipient.toBase58(),
          budgetBaseUnits: budget.toString(),
          spentBaseUnits: spent.toString(),
          remainingBaseUnits: (budget - spent).toString(),
          nextNonce: task.nextNonce.toString(),
          expiresAtUnix: task.expiresAt.toString(),
        },
      };
    })
  );

  return {
    network: NETWORK,
    vault: state.vault,
    agents,
  };
}

const REQUEST_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

function getWorkflowIds(): string[] {
  const approvalsDir = join(RUNTIME_DIR, "approvals");

  if (!existsSync(approvalsDir)) {
    return [];
  }

  return readdirSync(approvalsDir, {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        REQUEST_PATTERN.test(entry.name.slice(0, -5))
    )
    .map((entry) => entry.name.slice(0, -5))
    .sort();
}

async function getWorkflowData(requestId: string) {
  assert.match(requestId, REQUEST_PATTERN);

  const approvalPath = join(RUNTIME_DIR, "approvals", `${requestId}.json`);

  if (!existsSync(approvalPath)) {
    return null;
  }

  const signedApproval = signedWorkflowSchema.parse(
    JSON.parse(readFileSync(approvalPath, "utf8"))
  );

  // Verify the API is reading the intended Solana ledger.
  const [genesisHash, clockAccount] = await Promise.all([
    connection.getGenesisHash(),
    connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"),
  ]);

  assert.equal(genesisHash, state.genesisHash, "Unexpected Solana ledger");

  assert.ok(clockAccount, "Solana clock unavailable");

  const nowUnix = Number(clockAccount.data.readBigInt64LE(32));

  assert.ok(Number.isSafeInteger(nowUnix));

  const scope: ApprovalScope = {
    network: NETWORK,
    genesisHash,
    programId: state.programId,
    vault: state.vault,
    owner: state.owner,
    mint: state.mint,
  };

  // Historical approvals may now be expired.
  // Verify their signature and scope separately
  // from their current authorization status.
  const expiresAtUnix = signedApproval.workflow.expiresAtUnix;

  const verificationTime = Math.min(nowUnix, expiresAtUnix - 1);

  const workflow = verifyWorkflowApproval(
    signedApproval,
    scope,
    verificationTime
  );

  assert.equal(workflow.requestId, requestId);

  const claimPath = join(RUNTIME_DIR, "journal", `${requestId}.json`);

  const signedPath = join(RUNTIME_DIR, "journal", `${requestId}.signed.json`);

  const decisionPath = join(RUNTIME_DIR, "ai-decisions", `${requestId}.json`);

  const claimed = existsSync(claimPath);
  const signedTransactionExists = existsSync(signedPath);

  assert.ok(
    !signedTransactionExists || claimed,
    "Signed transaction exists without a request claim"
  );

  let payment: {
    signature: string;
    recoveryState: string;
    amountBaseUnits: number;
    nonce: string;
  } | null = null;

  if (signedTransactionExists) {
    const verified = await verifySavedPaymentIntegrity(
      RUNTIME_DIR,
      requestId,
      {
        network: NETWORK,
        genesisHash: state.genesisHash,
        programId: state.programId,
        vault: state.vault,
        owner: state.owner,
        mint: state.mint,
        treasury: state.treasury,
      },
      program
    );

    const [response, blockHeight] = await Promise.all([
      connection.getSignatureStatuses([verified.signature], {
        searchTransactionHistory: true,
      }),
      connection.getBlockHeight("confirmed"),
    ]);

    payment = {
      signature: verified.signature,
      recoveryState: classifyPayment(
        response.value[0],
        blockHeight,
        verified.lastValidBlockHeight
      ),
      amountBaseUnits: verified.amountBaseUnits,
      nonce: verified.nonce,
    };
  }

  return {
    requestId,
    network: NETWORK,
    assignedAgent: workflow.assignedAgent,
    workflowKind: workflow.kind,
    taskId: workflow.taskId,
    recipient: workflow.recipient,
    amountBaseUnits: workflow.amountBaseUnits,

    approval: {
      signatureVerified: true,
      currentlyValid: nowUnix < expiresAtUnix,
      expiresAtUnix,
    },

    aiDecision: {
      receiptFilePresent: existsSync(decisionPath),
      verification: "not_performed",
    },

    execution: {
      journalStatus: !claimed
        ? "unclaimed"
        : signedTransactionExists
        ? "signed_transaction_saved"
        : "claimed_without_signed_transaction",
      payment,
    },
  };
}

async function getActivityData() {
  assert.equal(NETWORK, "devnet", "Activity API currently supports Devnet");

  // Reuse our verified on-chain agent reader.
  const { agents } = await cachedRead("agents", getAgentsData, 30_000);

  const pages = await mapWithConcurrency(agents, 4, async (agent) => {
    const taskPda = new PublicKey(agent.task.taskPda);

    // Read confirmed transactions referencing this task.
    const signatures = await connection.getSignaturesForAddress(
      taskPda,
      { limit: 12 },
      "confirmed"
    );

    return signatures.map((entry) => ({
      signature: entry.signature,
      slot: entry.slot,
      blockTimeUnix: entry.blockTime,
      agentId: agent.id,
      workflow: agent.workflow,
      taskId: agent.task.taskId,
      taskPda: agent.task.taskPda,
      succeeded: entry.err === null,
      explorerUrl:
        `https://explorer.solana.com/tx/` + `${entry.signature}?cluster=devnet`,
    }));
  });

  const activity = pages
    .flat()
    .sort((a, b) => b.slot - a.slot)
    .slice(0, 20);

  return {
    network: NETWORK,
    activity,
  };
}

async function main(): Promise<void> {
  const database = createApiDatabase(process.env);

  try {
    // Do not accept requests until PostgreSQL is reachable.
    await verifyApiDatabase(database);

    const apiHandler = createApiHandler({
        network: NETWORK,
        runtimeVault: state.vault,
        credentials: API_CREDENTIALS,

        lookupDeveloperKey: (keyId) => database.repository.findById(keyId),
        managementRepository: database.repository,

        readers: {
          getTreasuryData,
          getAgentsData,
          getWorkflowIds,
          getWorkflowData,
          getActivityData,
        },

        cachedRead,
      });
    const server = createServer(createOwnerDashboardSessionHandler({
      apiHandler,
      ownerPublicKey: state.owner,
      vaultPublicKey: state.vault,
      ownerApiToken: API_CREDENTIALS.ownerToken,
      frontendOrigin: "http://127.0.0.1:5173",
      upstreamOrigin: `http://${HOST}:${PORT}`,
    }));
    configureApiHttpServer(server);

    let shuttingDown = false;

    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;

      // Reject waiting RPC work and prevent new RPC operations.
      // Already-active RPC operations retain their transport deadline.
      rpcConcurrencyGate.close(new Error("API server shutting down"));

      console.log(`Received ${signal}; shutting down API`);

      void (async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });

            server.closeIdleConnections();
          });
        } catch (error) {
          console.error("HTTP shutdown failed:", error);
          process.exitCode = 1;
        } finally {
          try {
            await database.pool.end();
          } catch (error) {
            console.error("PostgreSQL shutdown failed:", error);
            process.exitCode = 1;
          }
        }
      })();
    };

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);

      server.listen(PORT, HOST, () => {
        server.off("error", reject);

        process.once("SIGINT", () => shutdown("SIGINT"));
        process.once("SIGTERM", () => shutdown("SIGTERM"));

        console.log("\n=== AGENTVAULT BACKEND API ===");
        console.log("Network:", NETWORK);
        console.log("Mode: READ ONLY");
        console.log("PostgreSQL authentication: enabled");
        console.log(`Health: http://${HOST}:${PORT}/health`);
        console.log(`Treasury: http://${HOST}:${PORT}/api/treasury`);
        console.log("No signing or Gemini endpoints exposed.");

        resolve();
      });
    });
  } catch (error) {
    await database.pool.end();
    throw error;
  }
}

void main().catch((error) => {
  console.error(
    "AgentVault API startup failed:",
    error instanceof Error ? error.message : error
  );

  process.exitCode = 1;
});
