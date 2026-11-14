import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  type AccountInfo,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import {
  ModelAWorker,
  type ModelAWorkerOptions,
  type ModelAExecutionAdapter,
} from "./model-a-worker";
import {
  receiveModelAPaymentIntent,
  acknowledgeModelAPaymentIntent,
  readModelAPaymentIntent,
  PaymentIntentConflict,
  type StoredModelAPaymentIntent,
  type TrustedPaymentIntakeScope,
} from "./model-a-payment-intake";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import { loadPreparedPayment } from "./prepared-payment";

const GENESIS = "test-devnet-genesis-hash";
const NOW = 1_700_000_000;

const VALID_BLOCKHASH = Keypair.generate().publicKey.toBase58();

function clockBuffer(nowUnix: number): Buffer {
  const buf = Buffer.alloc(40);
  buf.writeBigInt64LE(BigInt(nowUnix), 32);
  return buf;
}

function makeWorkerHarness() {
  const root = mkdtempSync(join(tmpdir(), "av-worker-test-"));
  const runtimeDir = join(root, "runtime");
  mkdirSync(runtimeDir, { recursive: true });

  const owner = Keypair.generate();
  const agentAuthority = Keypair.generate();
  const recipient = Keypair.generate();
  const mint = Keypair.generate();

  const [vaultKey] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.publicKey.toBuffer(), Buffer.alloc(8)],
    AGENTVAULT_PROGRAM_ID
  );
  const [agentPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("agent"),
      vaultKey.toBuffer(),
      agentAuthority.publicKey.toBuffer(),
    ],
    AGENTVAULT_PROGRAM_ID
  );
  const taskIdBn = new BN(1);
  const [taskPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("task"),
      agentPda.toBuffer(),
      taskIdBn.toArrayLike(Buffer, "le", 8),
    ],
    AGENTVAULT_PROGRAM_ID
  );

  const treasuryAta = getAssociatedTokenAddressSync(
    mint.publicKey,
    vaultKey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const recipientAta = getAssociatedTokenAddressSync(
    mint.publicKey,
    recipient.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const state = {
    genesisHash: GENESIS,
    currentBlockHeight: 50,
    vault: {
      owner: owner.publicKey,
      tokenMint: mint.publicKey,
      paused: false,
      totalReserved: new BN(100_000),
    },
    agent: {
      vault: vaultKey,
      authority: agentAuthority.publicKey,
      active: true,
    },
    task: {
      vault: vaultKey,
      agent: agentPda,
      taskId: taskIdBn,
      recipient: recipient.publicKey,
      active: true,
      budget: new BN(100_000),
      spent: new BN(0),
      nextNonce: new BN(0),
      expiresAt: new BN(NOW + 3600),
    },
    signatureStatusMap: new Map<string, any>(),
  };

  const executeTaskPaymentDiscriminator = createHash("sha256")
    .update("global:execute_task_payment")
    .digest()
    .subarray(0, 8);

  const rpc: ModelAWorkerOptions["rpc"] = {
    async getGenesisHash() {
      return state.genesisHash;
    },
    async getLatestBlockhash() {
      return { blockhash: VALID_BLOCKHASH, lastValidBlockHeight: 100 };
    },
    async getBlockHeight() {
      return state.currentBlockHeight;
    },
    async getAccountInfo(address: PublicKey) {
      if (address.equals(SYSVAR_CLOCK_PUBKEY)) {
        return {
          data: clockBuffer(NOW),
          executable: false,
          lamports: 1,
          owner: SYSVAR_CLOCK_PUBKEY,
        };
      }
      return null;
    },
    async simulateTransaction() {
      return { value: { err: null, unitsConsumed: 1200 } };
    },
    async getSignatureStatus(sig: string) {
      return { value: state.signatureStatusMap.get(sig) ?? null };
    },
  };

  const program: ModelAWorkerOptions["program"] = {
    programId: AGENTVAULT_PROGRAM_ID,
    account: {
      vault: {
        async fetch() {
          return state.vault;
        },
      },
      agent: {
        async fetch() {
          return state.agent;
        },
      },
      task: {
        async fetch() {
          return state.task;
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
                    {
                      pubkey: accounts.agentAuthority,
                      isSigner: true,
                      isWritable: true,
                    },
                    {
                      pubkey: accounts.vault,
                      isSigner: false,
                      isWritable: true,
                    },
                    {
                      pubkey: accounts.agent,
                      isSigner: false,
                      isWritable: true,
                    },
                    {
                      pubkey: accounts.task,
                      isSigner: false,
                      isWritable: true,
                    },
                    {
                      pubkey: accounts.tokenMint,
                      isSigner: false,
                      isWritable: false,
                    },
                    {
                      pubkey: accounts.treasury,
                      isSigner: false,
                      isWritable: true,
                    },
                    {
                      pubkey: accounts.recipient,
                      isSigner: false,
                      isWritable: false,
                    },
                    {
                      pubkey: accounts.recipientToken,
                      isSigner: false,
                      isWritable: true,
                    },
                    {
                      pubkey: accounts.tokenProgram,
                      isSigner: false,
                      isWritable: false,
                    },
                  ],
                });
              },
            };
          },
        };
      },
    },
  };

  const trustedScope: TrustedPaymentIntakeScope = {
    principalId: "dev-principal-01",
    vault: vaultKey.toBase58(),
    network: "devnet",
    nowUnix: NOW,
  };

  function createIntent(requestId: string, overrides: Partial<any> = {}) {
    return receiveModelAPaymentIntent({
      runtimeDir,
      trustedScope,
      input: {
        requestId,
        agentAuthority: agentAuthority.publicKey.toBase58(),
        taskId: "1",
        recipient: recipient.publicKey.toBase58(),
        amountBaseUnits: "5000",
        expiresAtUnix: String(NOW + 1800),
        reason: "Test payment intent",
        ...overrides,
      },
    });
  }

  function createWorker(customOptions: Partial<ModelAWorkerOptions> = {}) {
    return new ModelAWorker({
      runtimeDir,
      network: "devnet",
      expectedGenesisHash: GENESIS,
      vault: vaultKey.toBase58(),
      agentSigner: agentAuthority,
      rpc,
      program,
      now: () => NOW * 1000,
      ...customOptions,
    });
  }

  function cleanup() {
    rmSync(root, { recursive: true, force: true });
  }

  return {
    root,
    runtimeDir,
    owner,
    agentAuthority,
    recipient,
    mint,
    vaultKey,
    agentPda,
    taskPda,
    state,
    trustedScope,
    createIntent,
    createWorker,
    cleanup,
  };
}

test("duplicate delivery: acknowledging delivery twice is idempotent", async () => {
  const h = makeWorkerHarness();
  try {
    h.createIntent("req_ack_dup_01");
    const ack1 = acknowledgeModelAPaymentIntent({
      runtimeDir: h.runtimeDir,
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentAuthority.publicKey.toBase58(),
      requestId: "req_ack_dup_01",
      nowUnix: NOW + 10,
    });
    assert.equal(ack1.duplicate, false);
    assert.equal(ack1.acknowledgedAtUnix, NOW + 10);

    const ack2 = acknowledgeModelAPaymentIntent({
      runtimeDir: h.runtimeDir,
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentAuthority.publicKey.toBase58(),
      requestId: "req_ack_dup_01",
      nowUnix: NOW + 20,
    });
    assert.equal(ack2.duplicate, true);
    assert.equal(ack2.acknowledgedAtUnix, NOW + 10);

    const read = readModelAPaymentIntent({
      runtimeDir: h.runtimeDir,
      trustedScope: h.trustedScope,
      requestId: "req_ack_dup_01",
      includeDelivery: true,
    });
    assert.ok(read);
    assert.equal(read.delivery?.acknowledged, true);
    assert.equal(read.delivery?.acknowledgedAtUnix, NOW + 10);
  } finally {
    h.cleanup();
  }
});

test("duplicate payment requests: identical is duplicate, changed terms throw conflict", async () => {
  const h = makeWorkerHarness();
  try {
    const res1 = h.createIntent("req_dup_req_01");
    assert.equal(res1.duplicate, false);
    assert.equal(res1.record.request.requestId, "req_dup_req_01");

    const res2 = h.createIntent("req_dup_req_01");
    assert.equal(res2.duplicate, true);

    assert.throws(
      () => h.createIntent("req_dup_req_01", { amountBaseUnits: "9999" }),
      PaymentIntentConflict
    );
  } finally {
    h.cleanup();
  }
});

test("concurrent workers: two workers race to claim the same request; exactly one claims", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_concurrent_01").record;
    const worker1 = h.createWorker();
    const worker2 = h.createWorker();

    const [res1, res2] = await Promise.allSettled([
      worker1.processPaymentIntent(intent),
      worker2.processPaymentIntent(intent),
    ]);

    const successes = [res1, res2].filter((r) => r.status === "fulfilled");
    assert.equal(successes.length, 1, "Expected exactly one worker to succeed");
    const result = (successes[0] as PromiseFulfilledResult<any>).value;
    assert.equal(result.status, "prepared");

    const claimPath = join(h.runtimeDir, "journal", "req_concurrent_01.json");
    const signedPath = join(
      h.runtimeDir,
      "journal",
      "req_concurrent_01.signed.json"
    );
    assert.ok(existsSync(claimPath));
    assert.ok(existsSync(signedPath));
  } finally {
    h.cleanup();
  }
});

test("nonce mismatch: simulation error or on-chain nonce desync fails closed before broadcast", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_nonce_mismatch_01").record;
    h.state.task.nextNonce = new BN(5); // Simulate non-zero nonce

    const worker = h.createWorker({
      rpc: {
        ...h.createWorker().constructor,
        getGenesisHash: async () => GENESIS,
        getLatestBlockhash: async () => ({
          blockhash: VALID_BLOCKHASH,
          lastValidBlockHeight: 100,
        }),
        getBlockHeight: async () => 50,
        getAccountInfo: async () => ({
          data: clockBuffer(NOW),
          executable: false,
          lamports: 1,
          owner: SYSVAR_CLOCK_PUBKEY,
        }),
        simulateTransaction: async () => {
          return { value: { err: { InstructionError: [1, "Custom 6003"] } } };
        },
      } as any,
    });

    await assert.rejects(
      () => worker.processPaymentIntent(intent),
      /Transaction simulation failed/
    );

    const signedPath = join(
      h.runtimeDir,
      "journal",
      "req_nonce_mismatch_01.signed.json"
    );
    assert.ok(!existsSync(signedPath));
  } finally {
    h.cleanup();
  }
});

test("agent revocation: revoked agent or task fails closed before claim or payment", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_agent_revoked_01").record;
    h.state.agent.active = false; // Revoke agent on-chain

    const worker = h.createWorker();
    await assert.rejects(
      () => worker.processPaymentIntent(intent),
      /Agent revoked or inactive on-chain/
    );

    const claimPath = join(
      h.runtimeDir,
      "journal",
      "req_agent_revoked_01.json"
    );
    assert.ok(!existsSync(claimPath), "Revoked agent must never be claimed");
  } finally {
    h.cleanup();
  }
});

test("expired tasks: task expired on-chain refuses claim", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_expired_task_01").record;
    h.state.task.expiresAt = new BN(NOW - 10); // Expired on chain

    const worker = h.createWorker();
    await assert.rejects(
      () => worker.processPaymentIntent(intent),
      /Task expired on-chain/
    );

    const claimPath = join(
      h.runtimeDir,
      "journal",
      "req_expired_task_01.json"
    );
    assert.ok(!existsSync(claimPath));
  } finally {
    h.cleanup();
  }
});

test("wrong recipient: intent recipient not in task allowlist refuses claim", async () => {
  const h = makeWorkerHarness();
  try {
    const attacker = Keypair.generate();
    const intent = h.createIntent("req_wrong_recipient_01", {
      recipient: attacker.publicKey.toBase58(),
    }).record;

    const worker = h.createWorker();
    await assert.rejects(
      () => worker.processPaymentIntent(intent),
      /Recipient does not match task allowlist/
    );

    const claimPath = join(
      h.runtimeDir,
      "journal",
      "req_wrong_recipient_01.json"
    );
    assert.ok(!existsSync(claimPath));
  } finally {
    h.cleanup();
  }
});

test("AI rejection: AI returns REJECT; payment is rejected and never claimed or paid", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_ai_reject_01").record;

    const worker = h.createWorker({
      evaluateAi: async () => ({
        decision: "REJECT",
        reason: "Purpose violates corporate policy",
      }),
    });

    const res = await worker.processPaymentIntent(intent);
    assert.equal(res.status, "rejected");
    assert.equal(res.reason, "Purpose violates corporate policy");

    const claimPath = join(h.runtimeDir, "journal", "req_ai_reject_01.json");
    const signedPath = join(
      h.runtimeDir,
      "journal",
      "req_ai_reject_01.signed.json"
    );
    const rejectedPath = join(
      h.runtimeDir,
      "journal",
      "req_ai_reject_01.rejected.json"
    );

    assert.ok(!existsSync(claimPath), "Rejected request must not be claimed");
    assert.ok(!existsSync(signedPath), "Rejected request must not be prepared");
    assert.ok(existsSync(rejectedPath), "Rejection record must be persisted");

    const recovery = await worker.recoverRequest("req_ai_reject_01");
    assert.equal(recovery.status, "REJECTED");
    assert.equal(recovery.reason, "Purpose violates corporate policy");
  } finally {
    h.cleanup();
  }
});

test("worker restart: interrupted claim before transaction prep is recovered and locked", async () => {
  const h = makeWorkerHarness();
  try {
    const journalDir = join(h.runtimeDir, "journal");
    mkdirSync(journalDir, { recursive: true });

    // Simulate process crash after claim write, before prepared payment write
    const crashRecord = {
      version: 1,
      requestId: "req_crash_01",
      network: "devnet",
      genesisHash: GENESIS,
      vault: h.vaultKey.toBase58(),
      owner: h.owner.publicKey.toBase58(),
      agent: "agent-a",
      recipient: h.recipient.publicKey.toBase58(),
      amountBaseUnits: 5000,
      approvalDigest: "test-digest",
      status: "claimed",
      claimedAt: new Date(NOW * 1000).toISOString(),
    };
    writeFileSync(
      join(journalDir, "req_crash_01.json"),
      JSON.stringify(crashRecord, null, 2)
    );

    // New worker instance boots up after restart
    const worker = h.createWorker();
    const recovery = await worker.recoverRequest("req_crash_01");
    assert.equal(recovery.status, "CLAIMED_WITHOUT_PREPARED");

    // Worker must refuse to overwrite or recreate
    h.createIntent("req_crash_01");
    const batch = await worker.processPendingIntentsOnce();
    assert.equal(
      batch.find((b) => b.requestId === "req_crash_01"),
      undefined,
      "Crashed claimed request must not be re-executed automatically"
    );
  } finally {
    h.cleanup();
  }
});

test("uncertain transaction status: expired blockhash without RPC record enters EXPIRED_UNRESOLVED", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_uncertain_01").record;
    const worker = h.createWorker();

    const result = await worker.processPaymentIntent(intent);
    assert.equal(result.status, "prepared");
    assert.ok(result.signature);

    // Simulate block height passing lastValidBlockHeight without RPC confirmation
    h.state.currentBlockHeight = 105; // lastValidBlockHeight is 100
    h.state.signatureStatusMap.set(result.signature!, null);

    const recovery = await worker.recoverRequest("req_uncertain_01");
    assert.equal(recovery.status, "EXPIRED_UNRESOLVED");
    assert.equal(recovery.signature, result.signature);

    // Rule: Transaction stays locked; never recreate or modify journal
    const batch = await worker.processPendingIntentsOnce();
    assert.equal(
      batch.find((b) => b.requestId === "req_uncertain_01"),
      undefined,
      "Uncertain expired payment must stay locked and never rerun"
    );
  } finally {
    h.cleanup();
  }
});

test("live execution boundary: live_devnet mode throws without explicit owner approval flag", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_live_boundary_01").record;
    delete process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST;

    const worker = h.createWorker({
      adapter: { mode: "live_devnet" },
    });

    await assert.rejects(
      () => worker.processPaymentIntent(intent),
      /Live autonomous transaction signing and broadcasting is prohibited/
    );

    const claimPath = join(
      h.runtimeDir,
      "journal",
      "req_live_boundary_01.json"
    );
    assert.ok(
      existsSync(claimPath),
      "Request was claimed before execution boundary check"
    );
    const signedPath = join(
      h.runtimeDir,
      "journal",
      "req_live_boundary_01.signed.json"
    );
    assert.ok(
      !existsSync(signedPath),
      "No signed transaction persisted when live execution is prohibited"
    );
  } finally {
    h.cleanup();
  }
});

