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
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
import nacl from "tweetnacl";
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
  validateModelAPaymentIntent,
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

export type BroadcastCapabilityType = "mock" | "live_network";

export interface ModelABroadcastCapability {
  readonly capabilityType: BroadcastCapabilityType;
  sendRawTransaction(raw: Buffer, options?: unknown): Promise<string>;
  confirmTransaction(
    strategy: unknown,
    commitment?: string
  ): Promise<{
    value: { err: unknown | null; confirmationStatus?: string };
    context?: { slot: number };
  }>;
}

export class MockBroadcastCapability implements ModelABroadcastCapability {
  readonly capabilityType = "mock" as const;

  constructor(
    private readonly sender?: (raw: Buffer, options?: unknown) => Promise<string>,
    private readonly confirmer?: (
      strategy: unknown,
      commitment?: string
    ) => Promise<{
      value: { err: unknown | null; confirmationStatus?: string };
      context?: { slot: number };
    }>
  ) {}

  async sendRawTransaction(raw: Buffer, options?: unknown): Promise<string> {
    if (this.sender) {
      return this.sender(raw, options);
    }
    const tx = Transaction.from(raw);
    return bs58.encode(tx.signature!);
  }

  async confirmTransaction(
    strategy: unknown,
    commitment?: string
  ): Promise<{
    value: { err: unknown | null; confirmationStatus?: string };
    context?: { slot: number };
  }> {
    if (this.confirmer) {
      return this.confirmer(strategy, commitment);
    }
    return {
      value: { err: null, confirmationStatus: "confirmed" },
      context: { slot: 1 },
    };
  }
}

export class LiveDevnetBroadcastCapability implements ModelABroadcastCapability {
  readonly capabilityType = "live_network" as const;

  constructor(
    private readonly broadcastRpc: {
      sendRawTransaction(raw: Buffer, options?: unknown): Promise<string>;
      confirmTransaction(
        strategy: unknown,
        commitment?: string
      ): Promise<{
        value: { err: unknown | null; confirmationStatus?: string };
        context?: { slot: number };
      }>;
    }
  ) {}

  async sendRawTransaction(raw: Buffer, options?: unknown): Promise<string> {
    if (process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST !== "true") {
      throw new LiveExecutionProhibitedError(
        "Live network broadcast prohibited without explicit owner approval and AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST=true"
      );
    }
    return this.broadcastRpc.sendRawTransaction(raw, options);
  }

  async confirmTransaction(
    strategy: unknown,
    commitment?: string
  ): Promise<{
    value: { err: unknown | null; confirmationStatus?: string };
    context?: { slot: number };
  }> {
    return this.broadcastRpc.confirmTransaction(strategy, commitment);
  }
}

export interface ModelAExecutionAdapter {
  mode: "simulated" | "preview" | "live_devnet";
  broadcaster?: ModelABroadcastCapability;
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

export function isRealNetworkRpc(rpc: ModelAWorkerRpc): boolean {
  if (rpc instanceof Connection) return true;
  const anyRpc = rpc as any;
  if (typeof anyRpc._rpcEndpoint === "string" && anyRpc._rpcEndpoint.length > 0) return true;
  if (typeof anyRpc.rpcEndpoint === "string" && anyRpc.rpcEndpoint.length > 0) return true;
  if (typeof anyRpc._rpcBatchEndpoint === "string" && anyRpc._rpcBatchEndpoint.length > 0) return true;
  if (anyRpc._rpcClient !== undefined) return true;
  return false;
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

export type AuthenticatedAgentPaymentDecision = {
  decision: "PAY" | "REJECT";
  requestId: string;
  vault: string;
  agentAuthority: string;
  taskPda: string;
  recipient: string;
  amountBaseUnits: string;
  reason: string;
  signature?: string;
  expiresAtUnix?: number | string;
  authorizedAtUnix?: number;
};

export type AgentAuthorizationContext = {
  taskPda: PublicKey;
  vaultKey: PublicKey;
  expectedNonce: string;
};

export function encodeAgentPaymentDecision(d: {
  requestId: string;
  vault: string;
  agentAuthority: string;
  taskPda: string;
  recipient: string;
  amountBaseUnits: string;
  expiresAtUnix?: number | string;
}): Buffer {
  if (d.expiresAtUnix !== undefined) {
    return Buffer.from(
      JSON.stringify([
        "agentvault:agent-payment-decision:v2",
        d.requestId,
        d.vault,
        d.agentAuthority,
        d.taskPda,
        d.recipient,
        d.amountBaseUnits,
        String(d.expiresAtUnix),
      ]),
      "utf8"
    );
  }
  return Buffer.from(
    JSON.stringify([
      "agentvault:agent-payment-decision:v1",
      d.requestId,
      d.vault,
      d.agentAuthority,
      d.taskPda,
      d.recipient,
      d.amountBaseUnits,
    ]),
    "utf8"
  );
}

export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp.${randomBytes(8).toString("hex")}`;
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Some platforms do not support opening directories for fsync
  }
}

/** Cross-process mutual exclusion lock using atomic filesystem locks. */
export class CrossProcessTaskLock {
  private lockFd: number | null = null;
  private lockPath: string | null = null;

  acquire(runtimeDir: string, taskPda: string): boolean {
    const locksDir = join(runtimeDir, "locks");
    mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const lockPath = join(locksDir, `task-${taskPda}.lock`);
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      fsyncSync(fd);
      this.lockFd = fd;
      this.lockPath = lockPath;
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw err;
    }
  }

  release(): void {
    if (this.lockFd !== null && this.lockPath !== null) {
      try {
        closeSync(this.lockFd);
      } catch {}
      try {
        unlinkSync(this.lockPath);
      } catch {}
      this.lockFd = null;
      this.lockPath = null;
    }
  }
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
  readAck?: (args: {
    vault: string;
    requestId: string;
  }) => { acknowledged: boolean; acknowledgedAtUnix?: number };
  authorizePayment?: (
    intent: StoredModelAPaymentIntent,
    context?: AgentAuthorizationContext
  ) => Promise<
    | AuthenticatedAgentPaymentDecision
    | { decision: "REJECT"; reason: string }
    | { decision: "PAY"; reason: string }
  >;
  evaluateAi?: (
    intent: StoredModelAPaymentIntent
  ) => Promise<{ decision: "PAY" | "REJECT"; reason: string }>;
  pollIntervalMs?: number;
  now?: () => number;
  targetRequest?: {
    requestId: string;
    taskPda: string;
    amountBaseUnits: string;
    maxExecutions?: number;
  };
  requireCryptographicSignature?: boolean;
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
  private readonly readAck?: (args: {
    vault: string;
    requestId: string;
  }) => { acknowledged: boolean; acknowledgedAtUnix?: number };
  private readonly authorizePayment?: (
    intent: StoredModelAPaymentIntent,
    context?: AgentAuthorizationContext
  ) => Promise<
    | AuthenticatedAgentPaymentDecision
    | { decision: "REJECT"; reason: string }
    | { decision: "PAY"; reason: string }
  >;
  private readonly evaluateAi?: (
    intent: StoredModelAPaymentIntent
  ) => Promise<{ decision: "PAY" | "REJECT"; reason: string }>;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly broadcaster: ModelABroadcastCapability | null;
  private readonly targetRequest?: ModelAWorkerOptions["targetRequest"];
  private readonly requireCryptographicSignature: boolean;

  private readonly taskLocks = new TaskLock();
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private executionCount = 0;
  private activeProcessingPromise: Promise<WorkerExecutionResult[]> | null = null;

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
    this.readAck = options.readAck;
    this.authorizePayment = options.authorizePayment;
    this.evaluateAi = options.evaluateAi;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.now = options.now ?? Date.now;
    this.targetRequest = options.targetRequest;
    this.requireCryptographicSignature =
      options.requireCryptographicSignature ?? false;

    // Resolve broadcaster capability by construction based on explicit adapter mode
    if (this.adapter.mode === "preview") {
      // Preview mode NEVER has broadcast capability by construction
      this.broadcaster = null;
    } else if (this.adapter.mode === "simulated") {
      // Simulated mode CANNOT invoke a real network broadcast capability by construction
      if (this.adapter.broadcaster) {
        if (this.adapter.broadcaster.capabilityType === "live_network") {
          throw new LiveExecutionProhibitedError(
            "Simulated mode cannot accept or invoke a live network broadcast capability"
          );
        }
        this.broadcaster = this.adapter.broadcaster;
      } else if (this.rpc.sendRawTransaction && this.rpc.confirmTransaction) {
        if (isRealNetworkRpc(this.rpc)) {
          // If RPC is a real network connection, simulated mode refuses to construct a broadcaster from it
          this.broadcaster = null;
        } else {
          // Mock RPC without real network connection gets wrapped into mock broadcast capability
          this.broadcaster = new MockBroadcastCapability(
            this.rpc.sendRawTransaction.bind(this.rpc),
            this.rpc.confirmTransaction.bind(this.rpc) as any
          );
        }
      } else {
        this.broadcaster = null;
      }
    } else if (this.adapter.mode === "live_devnet") {
      if (this.adapter.broadcaster) {
        if (this.adapter.broadcaster.capabilityType !== "live_network") {
          throw new LiveExecutionProhibitedError(
            "Live Devnet mode requires an authorized live network broadcast capability"
          );
        }
        this.broadcaster = this.adapter.broadcaster;
      } else if (this.rpc.sendRawTransaction && this.rpc.confirmTransaction) {
        this.broadcaster = new LiveDevnetBroadcastCapability(this.rpc as any);
      } else {
        this.broadcaster = null;
      }
    } else {
      this.broadcaster = null;
    }
  }

  private assertLiveExecutionAllowed(): void {
    if (this.adapter.mode === "live_devnet") {
      if (process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST !== "true") {
        throw new LiveExecutionProhibitedError(
          "Live autonomous transaction signing and broadcasting is prohibited without explicit owner approval and AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST=true"
        );
      }
    }
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

  async stopGracefully(timeoutMs = 15000): Promise<void> {
    this.stop();
    if (this.activeProcessingPromise) {
      await Promise.race([
        this.activeProcessingPromise,
        new Promise<void>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "Graceful shutdown timed out waiting for in-flight processing"
                )
              ),
            timeoutMs
          )
        ),
      ]).catch((err) => {
        console.warn(
          "[Worker] Warning during graceful shutdown:",
          err instanceof Error ? err.message : err
        );
      });
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
    if (
      this.targetRequest &&
      this.executionCount >= (this.targetRequest.maxExecutions ?? 1)
    ) {
      this.stop();
      return [];
    }
    this.isProcessing = true;

    const work = async (): Promise<WorkerExecutionResult[]> => {
      const inboxDir = join(this.runtimeDir, "payment-intent-inbox");
      if (!existsSync(inboxDir)) return [];

      const entries = readdirSync(inboxDir)
        .filter((f) => f.endsWith(".json"))
        .sort();

      const results: WorkerExecutionResult[] = [];
      const nowUnix = Math.floor(this.now() / 1000);

      for (const entry of entries) {
        if (
          this.targetRequest &&
          this.executionCount >= (this.targetRequest.maxExecutions ?? 1)
        ) {
          this.stop();
          break;
        }

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

        const requestId = stored.request?.requestId;
        if (!requestId || !REQUEST_ID_RE.test(requestId)) continue;

        // In single-request acceptance mode, NEVER process unrelated requests!
        if (this.targetRequest) {
          if (requestId !== this.targetRequest.requestId) {
            continue;
          }
          if (
            stored.request.amountBaseUnits !== this.targetRequest.amountBaseUnits
          ) {
            console.warn(
              `[Worker] Skipping request ${requestId}: amount ${stored.request.amountBaseUnits} does not match target amount ${this.targetRequest.amountBaseUnits}`
            );
            continue;
          }
        }

        // Skip expired intents
        if (BigInt(stored.request.expiresAtUnix) <= BigInt(nowUnix)) {
          continue;
        }

        // Verify delivery acknowledgment before processing
        const ack = this.readAck
          ? this.readAck({ vault: this.vault, requestId })
          : readModelAPaymentIntentAcknowledgment({
              runtimeDir: this.runtimeDir,
              vault: this.vault,
              requestId,
            });
        if (!ack.acknowledged) {
          continue;
        }

        // Check if previously claimed, rejected, failed, or uncertain
        const journalDir = join(this.runtimeDir, "journal");
        const claimPath = join(journalDir, `${requestId}.json`);
        const rejectedPath = join(journalDir, `${requestId}.rejected.json`);
        const failedPath = join(journalDir, `${requestId}.failed.json`);
        const confirmedPath = join(journalDir, `${requestId}.confirmed.json`);
        const signedPath = join(journalDir, `${requestId}.signed.json`);
        if (
          existsSync(claimPath) ||
          existsSync(rejectedPath) ||
          existsSync(failedPath) ||
          existsSync(confirmedPath) ||
          existsSync(signedPath)
        ) {
          continue;
        }

        try {
          const res = await this.processPaymentIntent(stored);
          results.push(res);
          if (
            res.status === "confirmed" ||
            res.status === "prepared" ||
            res.status === "simulated"
          ) {
            this.executionCount++;
            if (
              this.targetRequest &&
              this.executionCount >= (this.targetRequest.maxExecutions ?? 1)
            ) {
              this.stop();
              break;
            }
          }
        } catch (error) {
          console.error(
            `Failed processing payment intent ${requestId}:`,
            error instanceof Error ? error.message : error
          );
        }
      }
      return results;
    };

    this.activeProcessingPromise = work();
    try {
      return await this.activeProcessingPromise;
    } finally {
      this.isProcessing = false;
      this.activeProcessingPromise = null;
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
    // 0. Enforce live execution permission gate before claiming, signing, or preparing
    this.assertLiveExecutionAllowed();

    // 0.1 In single-request acceptance mode, enforce target match strictly
    if (this.targetRequest) {
      if (intent.request?.requestId !== this.targetRequest.requestId) {
        throw new Error(
          `Target request mismatch: expected ${this.targetRequest.requestId}, got ${intent.request?.requestId}`
        );
      }
      if (
        intent.request?.amountBaseUnits !== this.targetRequest.amountBaseUnits
      ) {
        throw new Error(
          `Target amount mismatch: expected ${this.targetRequest.amountBaseUnits}, got ${intent.request?.amountBaseUnits}`
        );
      }
    }

    // 1. Validate the entire payment-intent envelope
    if (
      !intent ||
      intent.version !== 1 ||
      intent.kind !== "model-a-payment-intent" ||
      intent.status !== "received"
    ) {
      throw new Error("Invalid payment intent envelope version or kind");
    }
    if (intent.network !== "devnet" || this.network !== "devnet") {
      throw new Error("Network mismatch; Devnet required");
    }
    if (intent.vault !== this.vault) {
      throw new Error("Intent vault does not match worker vault");
    }
    const requestId = intent.request?.requestId;
    if (!requestId || !REQUEST_ID_RE.test(requestId)) {
      throw new Error("Invalid payment intent request ID format");
    }

    // 1.1 Fail closed if request was previously claimed, rejected, failed, or uncertain in journal
    const journalDir = join(this.runtimeDir, "journal");
    const claimPath = join(journalDir, `${requestId}.json`);
    const rejectedPath = join(journalDir, `${requestId}.rejected.json`);
    const failedPath = join(journalDir, `${requestId}.failed.json`);
    const confirmedPath = join(journalDir, `${requestId}.confirmed.json`);
    const signedPath = join(journalDir, `${requestId}.signed.json`);

    if (
      existsSync(claimPath) ||
      existsSync(rejectedPath) ||
      existsSync(failedPath) ||
      existsSync(confirmedPath) ||
      existsSync(signedPath)
    ) {
      throw new Error(
        `Payment intent ${requestId} has already been processed or claimed in journal; retries are prohibited to prevent duplicate payments`
      );
    }

    const currentTrustedTime = Math.floor(this.now() / 1000);
    if (BigInt(intent.request.expiresAtUnix) <= BigInt(currentTrustedTime)) {
      throw new Error("Payment intent has expired against current trusted time");
    }

    // Validate canonical fields with validateModelAPaymentIntent
    validateModelAPaymentIntent(intent.request, currentTrustedTime);

    // Consistency with persisted intent on disk
    const persistedIntent = readModelAPaymentIntent({
      runtimeDir: this.runtimeDir,
      trustedScope: {
        network: "devnet",
        vault: this.vault,
        principalId: intent.principalId,
        nowUnix: currentTrustedTime,
      },
      requestId,
    });
    if (
      !persistedIntent ||
      JSON.stringify(persistedIntent.request) !== JSON.stringify(intent.request)
    ) {
      throw new Error("Payment intent does not match persisted intent on disk");
    }

    // Consistency with delivery acknowledgment
    const ack = this.readAck
      ? this.readAck({ vault: this.vault, requestId })
      : readModelAPaymentIntentAcknowledgment({
          runtimeDir: this.runtimeDir,
          vault: this.vault,
          requestId,
        });
    if (!ack.acknowledged) {
      throw new Error(
        `Payment intent ${requestId} has not been acknowledged for delivery by agent inbox`
      );
    }
    if (ack.acknowledgedAtUnix && ack.acknowledgedAtUnix > currentTrustedTime) {
      throw new Error("Delivery acknowledgment timestamp is in the future");
    }

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

    if (this.targetRequest && taskPda.toBase58() !== this.targetRequest.taskPda) {
      throw new Error(
        `Target task PDA mismatch: expected ${this.targetRequest.taskPda}, got ${taskPda.toBase58()}`
      );
    }

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

    const crossLock = new CrossProcessTaskLock();
    if (!crossLock.acquire(this.runtimeDir, taskPda.toBase58())) {
      this.taskLocks.release(taskLockKey);
      return {
        requestId,
        vault: this.vault,
        agentAuthority: intent.request.agentAuthority,
        taskId: intent.request.taskId,
        amountBaseUnits: intent.request.amountBaseUnits,
        recipient: intent.request.recipient,
        status: "skipped",
        reason: "Task currently locked by another worker process",
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

      // 3. Authoritative Agent-Authorization Gate
      // Keep Gemini advisory; never treat AI output alone as cryptographic authorization.
      if (this.evaluateAi) {
        const aiResult = await this.evaluateAi(intent);
        if (!aiResult || aiResult.decision !== "PAY") {
          const reason =
            aiResult?.reason || "Payment intent rejected by AI policy";
          this.recordRejection(requestId, reason);
          return {
            requestId,
            vault: this.vault,
            agentAuthority: intent.request.agentAuthority,
            taskId: intent.request.taskId,
            amountBaseUnits: intent.request.amountBaseUnits,
            recipient: intent.request.recipient,
            status: "rejected",
            reason,
          };
        }
      }

      if (!this.authorizePayment) {
        throw new Error(
          "Missing required agent payment authorization callback (fail-closed); delivery acknowledgment alone does not authorize payment"
        );
      }

      const authResult = await this.authorizePayment(intent, {
        taskPda,
        vaultKey,
        expectedNonce: currentNonce.toString(),
      });

      if (!authResult || authResult.decision !== "PAY") {
        const reason =
          (authResult as any)?.reason ||
          "Payment intent rejected by agent authorization policy";
        this.recordRejection(requestId, reason);
        return {
          requestId,
          vault: this.vault,
          agentAuthority: intent.request.agentAuthority,
          taskId: intent.request.taskId,
          amountBaseUnits: intent.request.amountBaseUnits,
          recipient: intent.request.recipient,
          status: "rejected",
          reason,
        };
      }

      // Require a payment decision bound to the exact request, amount, recipient, vault, task and agent.
      const candidate = authResult as Partial<AuthenticatedAgentPaymentDecision>;
      if (
        !candidate.requestId ||
        candidate.requestId !== requestId ||
        !candidate.vault ||
        candidate.vault !== this.vault ||
        !candidate.agentAuthority ||
        candidate.agentAuthority !== intent.request.agentAuthority ||
        !candidate.taskPda ||
        candidate.taskPda !== taskPda.toBase58() ||
        !candidate.recipient ||
        candidate.recipient !== intent.request.recipient ||
        !candidate.amountBaseUnits ||
        candidate.amountBaseUnits !== intent.request.amountBaseUnits
      ) {
        throw new Error(
          "Untrusted agent decision: decision is not bound to the exact request, amount, recipient, vault, task and agent"
        );
      }

      if (this.requireCryptographicSignature && !candidate.signature) {
        throw new Error(
          "Cryptographic agent authorization signature is required for live Devnet execution; unsigned JSON or AI output alone cannot authorize payment"
        );
      }

      if (candidate.signature) {
        const sigBytes = Buffer.from(candidate.signature, "base64");
        if (sigBytes.length !== 64) {
          throw new Error("Invalid agent authorization signature format");
        }
        if ((candidate as any).expiresAtUnix !== undefined) {
          if (
            String((candidate as any).expiresAtUnix) !==
            String(intent.request.expiresAtUnix)
          ) {
            throw new Error("Agent authorization decision expiry mismatch");
          }
        }
        const encV2 = encodeAgentPaymentDecision({
          requestId: candidate.requestId,
          vault: candidate.vault,
          agentAuthority: candidate.agentAuthority,
          taskPda: candidate.taskPda,
          recipient: candidate.recipient,
          amountBaseUnits: candidate.amountBaseUnits,
          expiresAtUnix: (candidate as any).expiresAtUnix,
        });
        const encV1 = encodeAgentPaymentDecision({
          requestId: candidate.requestId,
          vault: candidate.vault,
          agentAuthority: candidate.agentAuthority,
          taskPda: candidate.taskPda,
          recipient: candidate.recipient,
          amountBaseUnits: candidate.amountBaseUnits,
        });
        const validV2 =
          (candidate as any).expiresAtUnix !== undefined
            ? nacl.sign.detached.verify(encV2, sigBytes, authority.toBytes())
            : false;
        const validV1 = nacl.sign.detached.verify(
          encV1,
          sigBytes,
          authority.toBytes()
        );
        if (!validV2 && !validV1) {
          throw new Error("Invalid cryptographic agent authorization signature");
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

      // 6. Pre-broadcast simulation (Mandatory for live execution path)
      if (this.adapter.mode === "live_devnet" && !this.rpc.simulateTransaction) {
        throw new Error(
          "RPC transaction simulation capability is required for live Devnet execution"
        );
      }
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
      this.assertLiveExecutionAllowed();

      // Revalidation before signing:
      // Revalidate expiry against current trusted time, persisted intent consistency,
      // and ensure on-chain task state / nonce hasn't changed.
      const preSignTime = Math.floor(this.now() / 1000);
      if (BigInt(intent.request.expiresAtUnix) <= BigInt(preSignTime)) {
        throw new Error("Payment intent expired prior to transaction signing");
      }
      const recheckPersisted = readModelAPaymentIntent({
        runtimeDir: this.runtimeDir,
        trustedScope: {
          network: "devnet",
          vault: this.vault,
          principalId: intent.principalId,
          nowUnix: preSignTime,
        },
        requestId,
      });
      if (
        !recheckPersisted ||
        JSON.stringify(recheckPersisted.request) !== JSON.stringify(intent.request)
      ) {
        throw new Error(
          "Persisted payment intent modified prior to transaction signing"
        );
      }
      const freshTaskAcc = await this.program.account.task.fetch(
        taskPda,
        "confirmed"
      );
      if (!freshTaskAcc.active || !freshTaskAcc.nextNonce.eq(currentNonce)) {
        throw new Error(
          "On-chain task state changed prior to transaction signing"
        );
      }

      let signedTx: Transaction;
      if (this.agentSigner) {
        transaction.sign(this.agentSigner);
        signedTx = transaction;
      } else if (this.adapter.signTransaction) {
        signedTx = await this.adapter.signTransaction(authority, transaction);
      } else {
        throw new Error(
          "Agent signer keypair or signTransaction adapter required"
        );
      }

      // Verify the final signed transaction against exact intended payment instructions,
      // fee payer, program, task, amount, recipient, nonce and mint.
      assertExactAgentVaultPayment(signedTx, expectedPayment);

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
      assertSerializedAgentVaultPayment(prepared.transaction, expectedPayment);
      const signature = bs58.encode(prepared.transaction.signature!);

      // 9. Broadcast & Confirmation (Strict separation: preview, simulated, live_devnet)
      if (this.adapter.mode === "preview") {
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
      }

      if (this.adapter.mode === "simulated") {
        if (this.broadcaster && this.broadcaster.capabilityType === "live_network") {
          throw new LiveExecutionProhibitedError(
            "Simulated mode cannot invoke a live network broadcast capability by construction"
          );
        }
        if (isRealNetworkRpc(this.rpc)) {
          throw new LiveExecutionProhibitedError(
            "Simulated mode cannot broadcast to a real Solana RPC network adapter"
          );
        }
      } else if (this.adapter.mode === "live_devnet") {
        this.assertLiveExecutionAllowed();
        if (!this.broadcaster || this.broadcaster.capabilityType !== "live_network") {
          throw new LiveExecutionProhibitedError(
            "Live Devnet mode requires an authorized live network broadcast capability"
          );
        }
      }

      if (this.broadcaster) {

        const locallyPreparedSig = bs58.encode(prepared.transaction.signature!);
        const txSig = await this.broadcaster.sendRawTransaction(prepared.raw, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 2,
        });

        // Verify RPC-returned transaction signature against locally prepared signed bytes
        if (txSig !== locallyPreparedSig) {
          throw new Error(
            `RPC-returned transaction signature ${txSig} does not match locally signed signature ${locallyPreparedSig}`
          );
        }

        let confirmRes: any;
        try {
          confirmRes = await this.broadcaster.confirmTransaction(
            {
              signature: txSig,
              blockhash,
              lastValidBlockHeight,
            },
            "confirmed"
          );
        } catch (confirmError) {
          // Confirmation failed or timed out.
          // Never mark an uncertain transaction as definitively failed!
          return {
            requestId,
            vault: this.vault,
            agentAuthority: authority.toBase58(),
            taskId: intent.request.taskId,
            amountBaseUnits: intent.request.amountBaseUnits,
            recipient: recipient.toBase58(),
            status: "prepared",
            signature: txSig,
            nonce: currentNonce.toString(),
            reason: `Transaction broadcast uncertain; confirmation pending or timed out: ${(confirmError as Error).message}`,
          };
        }

        if (confirmRes.value && confirmRes.value.err !== null) {
          this.recordFailedOnChain(
            requestId,
            txSig,
            currentNonce.toString(),
            confirmRes.value.err
          );
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

        if (confirmRes.context?.slot && confirmRes.value?.confirmationStatus === "finalized") {
          this.recordFinalized(requestId, txSig, currentNonce.toString());
          return {
            requestId,
            vault: this.vault,
            agentAuthority: authority.toBase58(),
            taskId: intent.request.taskId,
            amountBaseUnits: intent.request.amountBaseUnits,
            recipient: recipient.toBase58(),
            status: "finalized",
            signature: txSig,
            nonce: currentNonce.toString(),
          };
        }

        this.recordConfirmed(requestId, txSig, currentNonce.toString());
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
      crossLock.release();
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
    try {
      atomicWriteJsonSync(path, record);
    } catch {
      // Ignore if already written
    }
  }

  private recordConfirmed(
    requestId: string,
    signature: string,
    nonce: string
  ): void {
    const journalDir = join(this.runtimeDir, "journal");
    const path = join(journalDir, `${requestId}.confirmed.json`);
    const record = {
      version: 1,
      requestId,
      status: "confirmed",
      signature,
      nonce,
      confirmedAt: new Date(this.now()).toISOString(),
    };
    atomicWriteJsonSync(path, record);
  }

  private recordFinalized(
    requestId: string,
    signature: string,
    nonce: string
  ): void {
    const journalDir = join(this.runtimeDir, "journal");
    const path = join(journalDir, `${requestId}.finalized.json`);
    const record = {
      version: 1,
      requestId,
      status: "finalized",
      signature,
      nonce,
      finalizedAt: new Date(this.now()).toISOString(),
    };
    atomicWriteJsonSync(path, record);
  }

  private recordFailedOnChain(
    requestId: string,
    signature: string,
    nonce: string,
    err: unknown
  ): void {
    const journalDir = join(this.runtimeDir, "journal");
    const path = join(journalDir, `${requestId}.failed.json`);
    const record = {
      version: 1,
      requestId,
      status: "failed_on_chain",
      signature,
      nonce,
      reason: JSON.stringify(err),
      failedAt: new Date(this.now()).toISOString(),
    };
    atomicWriteJsonSync(path, record);
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
