/**
 * AgentVault Model A Durable Polling Worker: DEVNET ONLY.
 *
 * Implements a restart-safe, idempotent autonomous execution worker for
 * Model A payment intents within owner-approved on-chain task policies.
 *
 * Safety boundaries:
 * - Local Devnet testing only; live broadcasting prohibited without explicit flag.
 * - Delivery acknowledgment is NOT payment authorization; full on-chain
 *   policy, budget, recipient, nonce, and deterministic AI evaluation are enforced.
 * - Single active execution per task PDA prevents nonce collisions.
 * - Atomic exclusive file claims in journal/ prevent duplicate execution.
 * - Prepared signed transactions are durably saved before any broadcast.
 * - Uncertain confirmations fail closed; never automatically recreate transactions.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import type { Agentvault } from "../target/types/agentvault";
import {
  assertPaymentInstructions,
  assertExactAgentVaultPayment,
  assertSerializedAgentVaultPayment,
  type ExpectedPayment,
} from "./payment-transaction-guard";
import {
  prepareSignedPayment,
  loadPreparedPayment,
  type PreparedPaymentRecord,
} from "./prepared-payment";
import type { RequestJournalRecord } from "./request-journal";
import {
  classifyPayment,
  type ObservedSignatureStatus,
  type RecoveryState,
} from "./payment-recovery-state";
import {
  readModelAPaymentIntent,
  readModelAPaymentIntentAcknowledgment,
  type StoredModelAPaymentIntent,
} from "./model-a-payment-intake";
import { AGENT_WORKFLOWS, type AgentId } from "./workflow-policy";

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type ModelAWorkerExecutionStatus =
  | "simulated"
  | "prepared"
  | "confirmed"
  | "failed_on_chain"
  | "rejected"
  | "skipped";

export type WorkerExecutionResult = {
  requestId: string;
  vault: string;
  agentAuthority: string;
  taskId: string;
  amountBaseUnits: string;
  recipient: string;
  status: ModelAWorkerExecutionStatus;
  signature?: string;
  nonce?: string;
  reason?: string;
};

export type ModelAWorkerRecoveryRecord = {
  requestId: string;
  status:
    | RecoveryState
    | "CLAIMED_WITHOUT_PREPARED"
    | "REJECTED";
  signature?: string;
  nonce?: string;
  lastValidBlockHeight?: number;
  currentBlockHeight?: number;
  reason?: string;
};

export interface ModelAExecutionAdapter {
  mode: "simulated" | "live_devnet";
  signTransaction?(
    agentAuthority: PublicKey,
    transaction: Transaction
  ): Promise<Transaction> | Transaction;
  broadcastTransaction?(rawTransaction: Buffer): Promise<{ signature: string }>;
  confirmTransaction?(
    signature: string,
    lastValidBlockHeight: number
  ): Promise<{ succeeded: boolean; err?: unknown }>;
}

export interface ModelAWorkerRpc {
  getGenesisHash(): Promise<string>;
  getLatestBlockhash(
    commitment?: string
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getBlockHeight(commitment?: string): Promise<number>;
  getAccountInfo(
    address: PublicKey,
    commitment?: string
  ): Promise<AccountInfo<Buffer> | null>;
  getSignatureStatus?(
    signature: string
  ): Promise<{ value: ObservedSignatureStatus | null }>;
  simulateTransaction?(
    transaction: VersionedTransaction,
    config?: unknown
  ): Promise<{
    value: {
      err: unknown | null;
      unitsConsumed?: number;
      logs?: string[];
    };
  }>;
  sendRawTransaction?(raw: Buffer, options?: unknown): Promise<string>;
  confirmTransaction?(
    strategy: unknown,
    commitment?: string
  ): Promise<{ value: { err: unknown | null } }>;
}

export type ModelAWorkerOptions = {
  runtimeDir: string;
  network: "devnet";
  expectedGenesisHash: string;
  vault: string;
  rpc: ModelAWorkerRpc;
  program: {
    programId: PublicKey;
    account: {
      vault: { fetch(address: PublicKey, commitment?: string): Promise<any> };
      agent: { fetch(address: PublicKey, commitment?: string): Promise<any> };
      task: { fetch(address: PublicKey, commitment?: string): Promise<any> };
    };
    methods: {
      executeTaskPayment(
        amount: BN,
        nonce: BN
      ): {
        accountsPartial(accounts: any): {
          instruction(): Promise<TransactionInstruction>;
        };
      };
    };
  };
  adapter?: ModelAExecutionAdapter;
  agentSigner?: Keypair;
  evaluateAi?: (
    intent: StoredModelAPaymentIntent
  ) => Promise<{ decision: "PAY" | "REJECT"; reason: string }>;
  pollIntervalMs?: number;
  now?: () => number;
};

export class LiveExecutionProhibitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveExecutionProhibitedError";
  }
}

/** In-memory mutual exclusion lock per task PDA to avoid on-chain nonce races. */
class TaskLock {
  private activeLocks = new Set<string>();

  acquire(taskKey: string): boolean {
    if (this.activeLocks.has(taskKey)) return false;
    this.activeLocks.add(taskKey);
    return true;
  }

  release(taskKey: string): void {
    this.activeLocks.delete(taskKey);
  }
}

export class ModelAWorker {
  private readonly runtimeDir: string;
  private readonly network: "devnet";
  private readonly expectedGenesisHash: string;
  private readonly vault: string;
  private readonly rpc: ModelAWorkerRpc;
  private readonly program: ModelAWorkerOptions["program"];
  private readonly adapter: ModelAExecutionAdapter;
  private readonly agentSigner?: Keypair;
  private readonly evaluateAi?: (
    intent: StoredModelAPaymentIntent
  ) => Promise<{ decision: "PAY" | "REJECT"; reason: string }>;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  private readonly taskLocks = new TaskLock();
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(options: ModelAWorkerOptions) {
    if (options.network !== "devnet") {
      throw new Error("Model A Worker is strictly Devnet-only");
    }
    this.runtimeDir = options.runtimeDir;
    this.network = options.network;
    this.expectedGenesisHash = options.expectedGenesisHash;
    this.vault = new PublicKey(options.vault).toBase58();
    this.rpc = options.rpc;
    this.program = options.program;
    this.adapter = options.adapter ?? { mode: "simulated" };
    this.agentSigner = options.agentSigner;
    this.evaluateAi = options.evaluateAi;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processPendingIntentsOnce().catch((err) => {
        console.error("Model A Worker background error:", err);
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Scan inbox and execute eligible payment intents once.
   */
  async processPendingIntentsOnce(): Promise<WorkerExecutionResult[]> {
    if (this.isProcessing) return [];
    this.isProcessing = true;
    try {
      const inboxDir = join(this.runtimeDir, "payment-intent-inbox");
      if (!existsSync(inboxDir)) return [];

      const entries = readdirSync(inboxDir)
        .filter((f) => f.endsWith(".json"))
        .sort();

      const results: WorkerExecutionResult[] = [];
      const nowUnix = Math.floor(this.now() / 1000);

      for (const entry of entries) {
        let stored: StoredModelAPaymentIntent;
        try {
          const raw = readFileSync(join(inboxDir, entry), "utf8");
          stored = JSON.parse(raw) as StoredModelAPaymentIntent;
        } catch {
          continue;
        }

        if (
          stored.version !== 1 ||
          stored.kind !== "model-a-payment-intent" ||
          stored.network !== "devnet" ||
          stored.vault !== this.vault
        ) {
          continue;
        }

        const requestId = stored.request.requestId;
        if (!REQUEST_ID_RE.test(requestId)) continue;

        // Skip expired intents
        if (BigInt(stored.request.expiresAtUnix) <= BigInt(nowUnix)) {
          continue;
        }

        // Check if previously claimed or rejected
        const claimPath = join(this.runtimeDir, "journal", `${requestId}.json`);
        const rejectedPath = join(
          this.runtimeDir,
          "journal",
          `${requestId}.rejected.json`
        );
        if (existsSync(claimPath) || existsSync(rejectedPath)) {
          continue;
        }

        try {
          const res = await this.processPaymentIntent(stored);
          results.push(res);
        } catch (error) {
          console.error(
            `Failed processing payment intent ${requestId}:`,
            error instanceof Error ? error.message : error
          );
        }
      }
      return results;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute an individual payment intent following the durable lifecycle:
   * 1. Check lock (1 active execution per task)
   * 2. Verify on-chain state & policy
   * 3. AI / deterministic evaluation
   * 4. Atomic journal claim
   * 5. Instruction building & pre-broadcast simulation
   * 6. Transaction signing & durable preparation
   * 7. Broadcast / simulation via adapter
   */
  async processPaymentIntent(
    intent: StoredModelAPaymentIntent
  ): Promise<WorkerExecutionResult> {
    const requestId = intent.request.requestId;
    const vaultKey = new PublicKey(this.vault);
    const authority = new PublicKey(intent.request.agentAuthority);
    const recipient = new PublicKey(intent.request.recipient);
    const taskIdNumber = Number(intent.request.taskId);
    const taskIdBn = new BN(intent.request.taskId);
    const amountBn = new BN(intent.request.amountBaseUnits);

    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), vaultKey.toBuffer(), authority.toBuffer()],
      this.program.programId
    );
    const [taskPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task"),
        agentPda.toBuffer(),
        taskIdBn.toArrayLike(Buffer, "le", 8),
      ],
      this.program.programId
    );

    const taskLockKey = `${this.vault}:${taskPda.toBase58()}`;
    if (!this.taskLocks.acquire(taskLockKey)) {
      return {
        requestId,
        vault: this.vault,
        agentAuthority: intent.request.agentAuthority,
        taskId: intent.request.taskId,
        amountBaseUnits: intent.request.amountBaseUnits,
        recipient: intent.request.recipient,
        status: "skipped",
        reason: "Task currently locked by an active payment execution",
      };
    }

    try {
      // 1. Verify Devnet genesis
      const currentGenesis = await this.rpc.getGenesisHash();
      if (currentGenesis !== this.expectedGenesisHash) {
        throw new Error("Devnet ledger genesis mismatch");
      }

      // 2. Fetch live on-chain accounts and verify policy
      const [vaultAcc, agentAcc, taskAcc, clockInfo] = await Promise.all([
        this.program.account.vault.fetch(vaultKey, "confirmed"),
        this.program.account.agent.fetch(agentPda, "confirmed"),
        this.program.account.task.fetch(taskPda, "confirmed"),
        this.rpc.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"),
      ]);

      if (!clockInfo || clockInfo.data.length < 40) {
        throw new Error("Solana clock sysvar unavailable");
      }
      const chainTime = clockInfo.data.readBigInt64LE(32);

      // Verify Vault
      if (vaultAcc.paused) {
        throw new Error("Vault is paused on-chain");
      }
      const mint = vaultAcc.tokenMint as PublicKey;
      const treasuryAta = getAssociatedTokenAddressSync(
        mint,
        vaultKey,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // Verify Agent & Task
      if (!agentAcc.active) {
        throw new Error("Agent revoked or inactive on-chain");
      }
      if (!agentAcc.vault.equals(vaultKey) || !agentAcc.authority.equals(authority)) {
        throw new Error("Agent identity mismatch");
      }
      if (!taskAcc.active) {
        throw new Error("Task revoked or inactive on-chain");
      }
      if (
        !taskAcc.vault.equals(vaultKey) ||
        !taskAcc.agent.equals(agentPda) ||
        !taskAcc.taskId.eq(taskIdBn)
      ) {
        throw new Error("Task identity mismatch");
      }
      if (!taskAcc.recipient.equals(recipient)) {
        throw new Error("Recipient does not match task allowlist");
      }
      if (BigInt(taskAcc.expiresAt.toString()) <= chainTime) {
        throw new Error("Task expired on-chain");
      }
      if (BigInt(intent.request.expiresAtUnix) > BigInt(taskAcc.expiresAt.toString())) {
        throw new Error("Intent expiry exceeds task expiry");
      }
      if (amountBn.lte(new BN(0))) {
        throw new Error("Payment amount must be positive");
      }
      if (taskAcc.spent.add(amountBn).gt(taskAcc.budget)) {
        throw new Error("Task budget exceeded");
      }
      if (amountBn.gt(vaultAcc.totalReserved)) {
        throw new Error("Vault reserved balance insufficient");
      }

      const currentNonce = taskAcc.nextNonce as BN;

      // 3. AI / Deterministic Advisory Gate
      if (this.evaluateAi) {
        const evalResult = await this.evaluateAi(intent);
        if (evalResult.decision === "REJECT") {
          this.recordRejection(requestId, evalResult.reason);
          return {
            requestId,
            vault: this.vault,
            agentAuthority: intent.request.agentAuthority,
            taskId: intent.request.taskId,
            amountBaseUnits: intent.request.amountBaseUnits,
            recipient: intent.request.recipient,
            status: "rejected",
            reason: evalResult.reason,
          };
        }
      }

      // 4. Atomic Journal Claim (exclusive file creation)
      const nowUnix = Math.floor(this.now() / 1000);
      const claimRecord = this.claimPayment({
        requestId,
        network: "devnet",
        genesisHash: currentGenesis,
        vault: this.vault,
        owner: vaultAcc.owner.toBase58(),
        agent: this.resolveAgentId(authority),
        agentAuthority: authority.toBase58(),
        taskPda: taskPda.toBase58(),
        recipient: recipient.toBase58(),
        amountBaseUnits: amountBn.toNumber(),
        claimedAtUnix: nowUnix,
      });

      // 5. Instruction Building
      const recipientAta = getAssociatedTokenAddressSync(
        mint,
        recipient,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const ataInstruction =
        createAssociatedTokenAccountIdempotentInstruction(
          authority,
          recipientAta,
          recipient,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );

      const paymentInstruction = await this.program.methods
        .executeTaskPayment(amountBn, currentNonce)
        .accountsPartial({
          agentAuthority: authority,
          vault: vaultKey,
          agent: agentPda,
          task: taskPda,
          tokenMint: mint,
          treasury: treasuryAta,
          recipient,
          recipientToken: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      const { blockhash, lastValidBlockHeight } =
        await this.rpc.getLatestBlockhash("confirmed");

      const transaction = new Transaction({
        feePayer: authority,
        recentBlockhash: blockhash,
      }).add(ataInstruction, paymentInstruction);

      const expectedPayment: ExpectedPayment = {
        agentAuthority: authority,
        recipient,
        mint,
        paymentInstruction,
      };

      assertPaymentInstructions(transaction, expectedPayment);

      // 6. Pre-broadcast simulation
      if (this.rpc.simulateTransaction) {
        const message = new TransactionMessage({
          payerKey: authority,
          recentBlockhash: blockhash,
          instructions: transaction.instructions,
        }).compileToV0Message();

        const preview = await this.rpc.simulateTransaction(
          new VersionedTransaction(message),
          { commitment: "confirmed", sigVerify: false }
        );
        if (preview.value.err !== null) {
          throw new Error(
            `Transaction simulation failed: ${JSON.stringify(
              preview.value.err
            )}`
          );
        }
      }

      // 7. Transaction Signing & Preparation
      let signedTx: Transaction;
      if (this.agentSigner) {
        if (
          this.adapter.mode === "live_devnet" &&
          process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST !== "true"
        ) {
          throw new LiveExecutionProhibitedError(
            "Live autonomous transaction signing and broadcasting is prohibited without explicit owner approval and AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST=true"
          );
        }
        transaction.sign(this.agentSigner);
        signedTx = transaction;
      } else if (this.adapter.signTransaction) {
        signedTx = await this.adapter.signTransaction(authority, transaction);
      } else {
        throw new Error(
          "Agent signer keypair or signTransaction adapter required"
        );
      }

      // 8. Persist signed transaction durably before any permitted broadcast
      const agentId = this.resolveAgentId(authority);
      prepareSignedPayment(
        this.runtimeDir,
        requestId,
        agentId,
        signedTx.feePayer!,
        taskPda,
        amountBn.toNumber(),
        currentNonce.toString(),
        lastValidBlockHeight,
        signedTx
      );

      const prepared = loadPreparedPayment(this.runtimeDir, requestId);
      const signature = bs58.encode(prepared.transaction.signature!);

      // 9. Broadcast & Confirmation (Gated)
      if (this.adapter.mode === "live_devnet") {
        if (this.rpc.sendRawTransaction && this.rpc.confirmTransaction) {
          const txSig = await this.rpc.sendRawTransaction(prepared.raw, {
            skipPreflight: false,
            preflightCommitment: "confirmed",
            maxRetries: 2,
          });
          const confirmRes = await this.rpc.confirmTransaction(
            {
              signature: txSig,
              blockhash,
              lastValidBlockHeight,
            },
            "confirmed"
          );
          if (confirmRes.value.err !== null) {
            return {
              requestId,
              vault: this.vault,
              agentAuthority: authority.toBase58(),
              taskId: intent.request.taskId,
              amountBaseUnits: intent.request.amountBaseUnits,
              recipient: recipient.toBase58(),
              status: "failed_on_chain",
              signature: txSig,
              nonce: currentNonce.toString(),
              reason: JSON.stringify(confirmRes.value.err),
            };
          }
          return {
            requestId,
            vault: this.vault,
            agentAuthority: authority.toBase58(),
            taskId: intent.request.taskId,
            amountBaseUnits: intent.request.amountBaseUnits,
            recipient: recipient.toBase58(),
            status: "confirmed",
            signature: txSig,
            nonce: currentNonce.toString(),
          };
        }
      }

      return {
        requestId,
        vault: this.vault,
        agentAuthority: authority.toBase58(),
        taskId: intent.request.taskId,
        amountBaseUnits: intent.request.amountBaseUnits,
        recipient: recipient.toBase58(),
        status: "prepared",
        signature,
        nonce: currentNonce.toString(),
      };
    } finally {
      this.taskLocks.release(taskLockKey);
    }
  }

  /**
   * Safe read-only crash recovery scanner for requests in journal/.
   * Strictly adheres to: "Never automatically recreate or resubmit a different transaction for an uncertain claimed request."
   */
  async recoverRequest(requestId: string): Promise<ModelAWorkerRecoveryRecord> {
    if (!REQUEST_ID_RE.test(requestId)) {
      throw new Error("Invalid request ID for recovery");
    }

    const journalDir = join(this.runtimeDir, "journal");
    const rejectedPath = join(journalDir, `${requestId}.rejected.json`);
    if (existsSync(rejectedPath)) {
      const parsed = JSON.parse(readFileSync(rejectedPath, "utf8"));
      return {
        requestId,
        status: "REJECTED",
        reason: parsed.reason,
      };
    }

    const claimPath = join(journalDir, `${requestId}.json`);
    if (!existsSync(claimPath)) {
      throw new Error(`Request ${requestId} is not in payment journal`);
    }

    const signedPath = join(journalDir, `${requestId}.signed.json`);
    if (!existsSync(signedPath)) {
      // Claimed before crash, but signed transaction was never prepared.
      // Must NOT recreate a transaction automatically!
      return {
        requestId,
        status: "CLAIMED_WITHOUT_PREPARED",
      };
    }

    const prepared = loadPreparedPayment(this.runtimeDir, requestId);
    const signature = bs58.encode(prepared.transaction.signature!);
    const currentBlockHeight = await this.rpc.getBlockHeight("confirmed");

    let statusResult: ObservedSignatureStatus | null = null;
    if (this.rpc.getSignatureStatus) {
      const res = await this.rpc.getSignatureStatus(signature);
      statusResult = res.value;
    }

    const recoveryState = classifyPayment(
      statusResult,
      currentBlockHeight,
      prepared.record.lastValidBlockHeight
    );

    return {
      requestId,
      status: recoveryState,
      signature,
      nonce: prepared.record.nonce,
      lastValidBlockHeight: prepared.record.lastValidBlockHeight,
      currentBlockHeight,
    };
  }

  private claimPayment(args: {
    requestId: string;
    network: string;
    genesisHash: string;
    vault: string;
    owner: string;
    agent: string;
    agentAuthority: string;
    taskPda: string;
    recipient: string;
    amountBaseUnits: number;
    claimedAtUnix: number;
  }): RequestJournalRecord {
    const journalDir = join(this.runtimeDir, "journal");
    mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const path = join(journalDir, `${args.requestId}.json`);

    const approvalDigest = createHash("sha256")
      .update(
        JSON.stringify([
          "model-a-intent",
          args.network,
          args.vault,
          args.agentAuthority,
          args.taskPda,
          args.recipient,
          args.amountBaseUnits,
          args.requestId,
        ])
      )
      .digest("hex");

    const record: RequestJournalRecord = {
      version: 1,
      requestId: args.requestId,
      network: args.network,
      genesisHash: args.genesisHash,
      vault: args.vault,
      owner: args.owner,
      agent: args.agent,
      recipient: args.recipient,
      amountBaseUnits: args.amountBaseUnits,
      approvalDigest,
      status: "claimed",
      claimedAt: new Date(args.claimedAtUnix * 1000).toISOString(),
    };

    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Request ${args.requestId} already claimed. Inspect journal; do not rerun execution.`
        );
      }
      throw error;
    }

    try {
      writeFileSync(fd, JSON.stringify(record, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    const dirFd = openSync(journalDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }

    return record;
  }

  private recordRejection(requestId: string, reason: string): void {
    const journalDir = join(this.runtimeDir, "journal");
    mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const path = join(journalDir, `${requestId}.rejected.json`);
    const record = {
      version: 1,
      requestId,
      status: "rejected",
      reason: reason.slice(0, 500),
      rejectedAt: new Date(this.now()).toISOString(),
    };
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch {
      return; // Already recorded
    }
    try {
      writeFileSync(fd, JSON.stringify(record, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private resolveAgentId(authority: PublicKey): AgentId {
    const authStr = authority.toBase58();
    if (authStr === "24y99x9EPoJ2ToqygjM37eU9AXz3aFwiDcHFv87LXQfQ") {
      return "agent-a";
    }
    if (authStr === "5qHQ9f5E6vQ91JhrDRbbBLpSFudzRBGNdvpXkT1iDLxT") {
      return "agent-b";
    }
    return "agent-a";
  }
}
