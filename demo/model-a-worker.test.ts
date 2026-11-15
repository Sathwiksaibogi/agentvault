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
  Connection,
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
  encodeAgentPaymentDecision,
  CrossProcessTaskLock,
  LiveExecutionProhibitedError,
  MockBroadcastCapability,
  LiveDevnetBroadcastCapability,
  type ModelAWorkerOptions,
  type ModelAExecutionAdapter,
} from "./model-a-worker";
import {
  receiveModelAPaymentIntent,
  acknowledgeModelAPaymentIntent,
  readModelAPaymentIntent,
  readModelAPaymentExecution,
  PaymentIntentConflict,
  type StoredModelAPaymentIntent,
  type TrustedPaymentIntakeScope,
} from "./model-a-payment-intake";
import nacl from "tweetnacl";
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

  function createIntent(
    requestId: string,
    overrides: Partial<any> = {},
    autoAck = true
  ) {
    const received = receiveModelAPaymentIntent({
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
    if (autoAck) {
      acknowledgeModelAPaymentIntent({
        runtimeDir,
        vault: vaultKey.toBase58(),
        agentAuthority: agentAuthority.publicKey.toBase58(),
        requestId,
        nowUnix: NOW,
      });
    }
    return received;
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
      authorizePayment: async (intent, ctx) => ({
        decision: "PAY",
        requestId: intent.request.requestId,
        vault: vaultKey.toBase58(),
        agentAuthority: intent.request.agentAuthority,
        taskPda: ctx?.taskPda.toBase58() ?? taskPda.toBase58(),
        recipient: intent.request.recipient,
        amountBaseUnits: intent.request.amountBaseUnits,
        reason: "Test authorized",
      }),
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
    program,
    createIntent,
    createWorker,
    cleanup,
  };
}

test("duplicate delivery: acknowledging delivery twice is idempotent", async () => {
  const h = makeWorkerHarness();
  try {
    h.createIntent("req_ack_dup_01", {}, false);
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

    const preparedList = [res1, res2].filter(
      (r) =>
        r.status === "fulfilled" &&
        (r as PromiseFulfilledResult<any>).value.status === "prepared"
    );
    const lockedOrSkipped = [res1, res2].filter(
      (r) =>
        r.status === "rejected" ||
        (r.status === "fulfilled" &&
          (r as PromiseFulfilledResult<any>).value.status === "skipped")
    );
    assert.equal(
      preparedList.length,
      1,
      "Expected exactly one worker to prepare the payment"
    );
    assert.equal(
      lockedOrSkipped.length,
      1,
      "Expected the competing worker to be locked out / skipped"
    );

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

test("live execution boundary: disabled execution never claims, signs, or broadcasts (agentSigner)", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_live_gate_01").record;
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
      "req_live_gate_01.json"
    );
    assert.ok(
      !existsSync(claimPath),
      "Request must NOT be claimed when live execution is disabled"
    );
    const signedPath = join(
      h.runtimeDir,
      "journal",
      "req_live_gate_01.signed.json"
    );
    assert.ok(
      !existsSync(signedPath),
      "No signed transaction persisted when live execution is disabled"
    );
  } finally {
    h.cleanup();
  }
});

test("live execution boundary: disabled execution never claims, signs, or broadcasts (signTransaction adapter)", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_live_gate_02").record;
    delete process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST;

    let adapterSignCalled = false;
    const worker = h.createWorker({
      agentSigner: undefined,
      adapter: {
        mode: "live_devnet",
        signTransaction: async (_authority, tx) => {
          adapterSignCalled = true;
          return tx;
        },
      },
    });

    await assert.rejects(
      () => worker.processPaymentIntent(intent),
      /Live autonomous transaction signing and broadcasting is prohibited/
    );

    assert.equal(
      adapterSignCalled,
      false,
      "External signTransaction adapter must never be invoked when live execution is disabled"
    );

    const claimPath = join(
      h.runtimeDir,
      "journal",
      "req_live_gate_02.json"
    );
    assert.ok(!existsSync(claimPath), "Claim must never be created");
  } finally {
    h.cleanup();
  }
});

test("payment authorization & delivery: unacknowledged intent fails closed and is skipped in worker scan", async () => {
  const h = makeWorkerHarness();
  try {
    const unackedIntent = h.createIntent("req_unacked_01", {}, false).record;
    const worker = h.createWorker();

    // Direct execution fails closed
    await assert.rejects(
      () => worker.processPaymentIntent(unackedIntent),
      /has not been acknowledged for delivery by agent inbox/
    );

    const claimPath = join(
      h.runtimeDir,
      "journal",
      "req_unacked_01.json"
    );
    assert.ok(!existsSync(claimPath), "Unacknowledged intent must not be claimed");

    // Background scan skips unacknowledged intents
    const results = await worker.processPendingIntentsOnce();
    assert.equal(
      results.find((r) => r.requestId === "req_unacked_01"),
      undefined,
      "Unacknowledged intent must be skipped by worker polling"
    );

    // After acknowledgment, processing succeeds
    acknowledgeModelAPaymentIntent({
      runtimeDir: h.runtimeDir,
      vault: h.vaultKey.toBase58(),
      agentAuthority: h.agentAuthority.publicKey.toBase58(),
      requestId: "req_unacked_01",
      nowUnix: NOW,
    });

    const res = await worker.processPaymentIntent(unackedIntent);
    assert.equal(res.status, "prepared");
    assert.ok(existsSync(claimPath), "Acknowledged intent can be claimed");
  } finally {
    h.cleanup();
  }
});

test("payment authorization & delivery: worker fails closed without explicit payment authorization callback", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_unauthorized_01").record;

    // Delivery acknowledgment alone must NOT authorize payment
    const worker = h.createWorker({
      authorizePayment: undefined,
      evaluateAi: undefined,
    });

    await assert.rejects(
      () => worker.processPaymentIntent(intent),
      /Missing required agent payment authorization callback/
    );

    const claimPath = join(
      h.runtimeDir,
      "journal",
      "req_unauthorized_01.json"
    );
    assert.ok(
      !existsSync(claimPath),
      "Unauthorized intent must never be claimed"
    );
  } finally {
    h.cleanup();
  }
});

test("signed transaction integrity: external signing adapter returning tampered recipient fails closed", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_tamper_adapter_01").record;
    const rogueRecipient = Keypair.generate();

    const worker = h.createWorker({
      agentSigner: undefined,
      adapter: {
        mode: "simulated",
        signTransaction: async (_authority, tx) => {
          // Attacker adapter alters instruction data/accounts
          const tampered = new Transaction({
            feePayer: h.agentAuthority.publicKey,
            recentBlockhash: tx.recentBlockhash,
          });
          // Replace second instruction recipient with rogue recipient
          tampered.add(tx.instructions[0]);
          const badInstruction = new TransactionInstruction({
            programId: tx.instructions[1].programId,
            keys: tx.instructions[1].keys.map((k) =>
              k.pubkey.equals(h.recipient.publicKey)
                ? { ...k, pubkey: rogueRecipient.publicKey }
                : k
            ),
            data: tx.instructions[1].data,
          });
          tampered.add(badInstruction);
          tampered.sign(h.agentAuthority);
          return tampered;
        },
      },
    });

    await assert.rejects(
      () => worker.processPaymentIntent(intent),
      /account 6 address mismatch|Payment instruction lacks approved recipient/
    );

    const signedPath = join(
      h.runtimeDir,
      "journal",
      "req_tamper_adapter_01.signed.json"
    );
    assert.ok(
      !existsSync(signedPath),
      "Tampered transaction must never be durably persisted as prepared payment"
    );
  } finally {
    h.cleanup();
  }
});

test("signed transaction integrity: live devnet execution requires RPC simulation capability", async () => {
  const h = makeWorkerHarness();
  try {
    process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST = "true";
    const intent = h.createIntent("req_live_no_sim_01").record;

    const worker = h.createWorker({
      adapter: { mode: "live_devnet" },
      rpc: {
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
        simulateTransaction: undefined, // Missing simulation capability!
      } as any,
    });

    await assert.rejects(
      () => worker.processPaymentIntent(intent),
      /RPC transaction simulation capability is required for live Devnet execution/
    );
  } finally {
    delete process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST;
    h.cleanup();
  }
});

test("durable execution state: confirmed and failed on-chain payments are recorded and exposed through payment-intent API", async () => {
  const h = makeWorkerHarness();
  try {
    process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST = "true";

    // 1. Test confirmed payment recording
    const intentSuccess = h.createIntent("req_durable_confirm_01").record;
    let sentRaw: Buffer | null = null;
    const workerSuccess = h.createWorker({
      adapter: { mode: "live_devnet" },
      rpc: {
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
        simulateTransaction: async () => ({ value: { err: null } }),
        sendRawTransaction: async (raw: Buffer) => {
          sentRaw = raw;
          return bs58.encode(Transaction.from(raw).signature!);
        },
        confirmTransaction: async () => ({ value: { err: null } }),
      } as any,
    });

    const resSuccess = await workerSuccess.processPaymentIntent(intentSuccess);
    assert.equal(resSuccess.status, "confirmed");
    assert.ok(sentRaw);

    const readSuccess = readModelAPaymentIntent({
      runtimeDir: h.runtimeDir,
      trustedScope: h.trustedScope,
      requestId: "req_durable_confirm_01",
      includeExecution: true,
    });
    assert.equal(readSuccess?.execution?.status, "confirmed");
    assert.equal(
      readSuccess?.execution?.signature,
      bs58.encode(Transaction.from(sentRaw).signature!)
    );

    // 2. Test failed on-chain payment recording
    const intentFail = h.createIntent("req_durable_fail_01").record;
    let sentFailRaw: Buffer | null = null;
    const workerFail = h.createWorker({
      adapter: { mode: "live_devnet" },
      rpc: {
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
        simulateTransaction: async () => ({ value: { err: null } }),
        sendRawTransaction: async (raw: Buffer) => {
          sentFailRaw = raw;
          return bs58.encode(Transaction.from(raw).signature!);
        },
        confirmTransaction: async () => ({
          value: { err: { InstructionError: [1, "Custom 6001"] } },
        }),
      } as any,
    });

    const resFail = await workerFail.processPaymentIntent(intentFail);
    assert.equal(resFail.status, "failed_on_chain");

    const readFail = readModelAPaymentIntent({
      runtimeDir: h.runtimeDir,
      trustedScope: h.trustedScope,
      requestId: "req_durable_fail_01",
      includeExecution: true,
    });
    assert.equal(readFail?.execution?.status, "failed_on_chain");
    assert.ok(readFail?.execution?.failureReason?.includes("Custom 6001"));
  } finally {
    delete process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST;
    h.cleanup();
  }
});

test("model a request integrity: expired intent against current trusted time fails closed", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_integrity_expired_01", {
      expiresAtUnix: String(NOW + 5),
    }).record;
    const worker = h.createWorker({
      now: () => (NOW + 10) * 1000,
    });

    await assert.rejects(
      async () => worker.processPaymentIntent(intent),
      /Payment intent has expired against current trusted time/
    );
  } finally {
    h.cleanup();
  }
});

test("model a request integrity: persisted intent tampering fails closed", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_integrity_tamper_01").record;
    const worker = h.createWorker();

    // Tamper with the in-memory intent object to alter the payment recipient
    const tamperedIntent: StoredModelAPaymentIntent = {
      ...intent,
      request: {
        ...intent.request,
        recipient: Keypair.generate().publicKey.toBase58(),
      },
    };

    await assert.rejects(
      async () => worker.processPaymentIntent(tamperedIntent),
      /Payment intent does not match persisted intent on disk/
    );
  } finally {
    h.cleanup();
  }
});

test("model a request integrity: revalidation before signing fails closed if task state changed", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_integrity_reval_01").record;
    let fetchCount = 0;
    const worker = h.createWorker({
      program: {
        ...h.program,
        account: {
          ...h.program.account,
          task: {
            fetch: async (address: PublicKey, commitment?: string) => {
              fetchCount++;
              if (fetchCount > 1) {
                // Task was modified or revoked on-chain between step 2 and signing!
                return {
                  ...h.state.task,
                  active: false,
                };
              }
              return h.state.task;
            },
          },
        },
      },
    });

    await assert.rejects(
      async () => worker.processPaymentIntent(intent),
      /On-chain task state changed prior to transaction signing/
    );
  } finally {
    h.cleanup();
  }
});

test("agent authorization: bare PAY callback without bound terms fails closed as untrusted", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_auth_bare_01").record;
    const worker = h.createWorker({
      // Bare callback returning PAY without binding to request terms
      authorizePayment: async () =>
        ({
          decision: "PAY",
          reason: "Bare authorization without request binding",
        } as any),
    });

    await assert.rejects(
      async () => worker.processPaymentIntent(intent),
      /Untrusted agent decision: decision is not bound to the exact request, amount, recipient, vault, task and agent/
    );
  } finally {
    h.cleanup();
  }
});

test("agent authorization: cryptographic signature on bound decision verifies authority", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_auth_crypto_01").record;
    const worker = h.createWorker({
      authorizePayment: async (it, ctx) => {
        const enc = encodeAgentPaymentDecision({
          requestId: it.request.requestId,
          vault: h.vaultKey.toBase58(),
          agentAuthority: it.request.agentAuthority,
          taskPda: ctx?.taskPda.toBase58() ?? h.taskPda.toBase58(),
          recipient: it.request.recipient,
          amountBaseUnits: it.request.amountBaseUnits,
        });
        const sigBytes = nacl.sign.detached(enc, h.agentAuthority.secretKey);
        return {
          decision: "PAY",
          requestId: it.request.requestId,
          vault: h.vaultKey.toBase58(),
          agentAuthority: it.request.agentAuthority,
          taskPda: ctx?.taskPda.toBase58() ?? h.taskPda.toBase58(),
          recipient: it.request.recipient,
          amountBaseUnits: it.request.amountBaseUnits,
          reason: "Cryptographically verified agent authorization",
          signature: Buffer.from(sigBytes).toString("base64"),
        };
      },
    });

    const res = await worker.processPaymentIntent(intent);
    assert.equal(res.status, "prepared");
  } finally {
    h.cleanup();
  }
});

test("agent authorization: forged signature fails closed", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_auth_forged_01").record;
    const rogueKeypair = Keypair.generate();
    const worker = h.createWorker({
      authorizePayment: async (it, ctx) => {
        const enc = encodeAgentPaymentDecision({
          requestId: it.request.requestId,
          vault: h.vaultKey.toBase58(),
          agentAuthority: it.request.agentAuthority,
          taskPda: ctx?.taskPda.toBase58() ?? h.taskPda.toBase58(),
          recipient: it.request.recipient,
          amountBaseUnits: it.request.amountBaseUnits,
        });
        // Signed with wrong/rogue keypair!
        const forgedSigBytes = nacl.sign.detached(enc, rogueKeypair.secretKey);
        return {
          decision: "PAY",
          requestId: it.request.requestId,
          vault: h.vaultKey.toBase58(),
          agentAuthority: it.request.agentAuthority,
          taskPda: ctx?.taskPda.toBase58() ?? h.taskPda.toBase58(),
          recipient: it.request.recipient,
          amountBaseUnits: it.request.amountBaseUnits,
          reason: "Forged agent authorization",
          signature: Buffer.from(forgedSigBytes).toString("base64"),
        };
      },
    });

    await assert.rejects(
      async () => worker.processPaymentIntent(intent),
      /Invalid cryptographic agent authorization signature/
    );
  } finally {
    h.cleanup();
  }
});

test("agent authorization: Gemini PAY does not bypass agent authorization checks", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_gemini_advisory_01").record;
    const worker = h.createWorker({
      evaluateAi: async () => ({
        decision: "PAY",
        reason: "Gemini advisory says PAY",
      }),
      // But agent authorization returns REJECT:
      authorizePayment: async () => ({
        decision: "REJECT",
        reason: "Agent authority rejects payment",
      }),
    });

    const res = await worker.processPaymentIntent(intent);
    assert.equal(res.status, "rejected");
    assert.equal(res.reason, "Agent authority rejects payment");
  } finally {
    h.cleanup();
  }
});

test("transaction finality: RPC returning mismatched signature fails closed before broadcast confirmation", async () => {
  const h = makeWorkerHarness();
  try {
    process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST = "true";
    const intent = h.createIntent("req_mismatched_rpc_sig_01").record;
    const rogueSignature = bs58.encode(Keypair.generate().publicKey.toBytes());

    const worker = h.createWorker({
      adapter: { mode: "live_devnet" },
      rpc: {
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
        simulateTransaction: async () => ({ value: { err: null } }),
        sendRawTransaction: async () => rogueSignature, // Returning mismatched signature!
        confirmTransaction: async () => ({ value: { err: null } }),
      } as any,
    });

    await assert.rejects(
      async () => worker.processPaymentIntent(intent),
      /RPC-returned transaction signature .* does not match locally signed signature/
    );
  } finally {
    delete process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST;
    h.cleanup();
  }
});

test("transaction finality: malformed terminal execution record fails closed", () => {
  const h = makeWorkerHarness();
  try {
    const journalDir = join(h.runtimeDir, "journal");
    mkdirSync(journalDir, { recursive: true });

    // Write a corrupt / malformed confirmed record
    writeFileSync(
      join(journalDir, "req_malformed_01.confirmed.json"),
      JSON.stringify({ status: "confirmed", missingFields: true })
    );

    assert.throws(
      () => readModelAPaymentExecution(h.runtimeDir, "req_malformed_01"),
      /Stored execution record malformed; manual reconciliation required/
    );
  } finally {
    h.cleanup();
  }
});

test("concurrency: cross-process task lock prevents concurrent workers from nonce racing on the same task", () => {
  const h = makeWorkerHarness();
  try {
    const lock1 = new CrossProcessTaskLock();
    const lock2 = new CrossProcessTaskLock();

    const acquired1 = lock1.acquire(h.runtimeDir, h.taskPda.toBase58());
    assert.equal(acquired1, true, "First process must acquire task lock");

    const acquired2 = lock2.acquire(h.runtimeDir, h.taskPda.toBase58());
    assert.equal(acquired2, false, "Second process must be locked out");

    lock1.release();

    const acquired3 = lock2.acquire(h.runtimeDir, h.taskPda.toBase58());
    assert.equal(
      acquired3,
      true,
      "Second process acquires lock after first releases"
    );
    lock2.release();
  } finally {
    h.cleanup();
  }
});

test("strict RPC isolation: simulated mode cannot broadcast to a real network adapter", async () => {
  const h = makeWorkerHarness();
  try {
    const realRpc = new Connection("https://api.devnet.solana.com", "confirmed");
    let broadcastAttempted = false;
    realRpc.sendRawTransaction = async () => {
      broadcastAttempted = true;
      return "unauthorized_real_broadcast";
    };
    realRpc.confirmTransaction = async () => ({
      context: { slot: 100 },
      value: { err: null, confirmationStatus: "confirmed" },
    });
    realRpc.simulateTransaction = async () => ({
      value: { err: null, logs: [], unitsConsumed: 1000 },
    });
    realRpc.getGenesisHash = async () => GENESIS;
    realRpc.getLatestBlockhash = async () => ({
      blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
      lastValidBlockHeight: 1000,
    });
    realRpc.getBlockHeight = async () => 500;
    realRpc.getAccountInfo = async (addr: PublicKey) => {
      if (addr.equals(SYSVAR_CLOCK_PUBKEY)) {
        const buf = Buffer.alloc(40);
        buf.writeBigInt64LE(BigInt(NOW), 32);
        return { data: buf } as any;
      }
      return null;
    };

    const worker = h.createWorker({
      rpc: realRpc,
      adapter: { mode: "simulated" },
    });

    const { record: intent } = h.createIntent("req_strict_isolation_01");

    await assert.rejects(
      async () => worker.processPaymentIntent(intent),
      /Simulated mode cannot broadcast to a real Solana RPC network adapter/
    );

    assert.equal(
      broadcastAttempted,
      false,
      "Real network RPC sendRawTransaction must NEVER be called in simulated mode"
    );
  } finally {
    h.cleanup();
  }
});

test("preview mode: prepares transaction without signing or broadcasting", async () => {
  const h = makeWorkerHarness();
  try {
    let broadcastAttempted = false;
    const mockRpc: any = {
      getGenesisHash: async () => GENESIS,
      getLatestBlockhash: async () => ({
        blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
        lastValidBlockHeight: 1000,
      }),
      getBlockHeight: async () => 500,
      getAccountInfo: async (addr: PublicKey) => {
        if (addr.equals(SYSVAR_CLOCK_PUBKEY)) {
          const buf = Buffer.alloc(40);
          buf.writeBigInt64LE(BigInt(NOW), 32);
          return { data: buf } as any;
        }
        return null;
      },
      sendRawTransaction: async () => {
        broadcastAttempted = true;
        return "mock_sig";
      },
    };

    const worker = h.createWorker({
      rpc: mockRpc,
      adapter: { mode: "preview" },
    });

    const { record: intent } = h.createIntent("req_preview_01");

    const result = await worker.processPaymentIntent(intent);
    assert.equal(result.status, "prepared");
    assert.equal(
      broadcastAttempted,
      false,
      "Preview mode must never invoke broadcast"
    );
  } finally {
    h.cleanup();
  }
});

test("capability isolation: simulated mode rejects live network broadcast capability by construction", async () => {
  const h = makeWorkerHarness();
  try {
    const liveBroadcaster = new LiveDevnetBroadcastCapability({
      sendRawTransaction: async () => "tx",
      confirmTransaction: async () => ({ value: { err: null } }),
    });

    assert.throws(
      () =>
        h.createWorker({
          adapter: {
            mode: "simulated",
            broadcaster: liveBroadcaster,
          },
        }),
      /Simulated mode cannot accept or invoke a live network broadcast capability/
    );
  } finally {
    h.cleanup();
  }
});

test("capability isolation: live devnet mode rejects mock broadcast capability", async () => {
  const h = makeWorkerHarness();
  try {
    process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST = "true";
    const mockBroadcaster = new MockBroadcastCapability();

    assert.throws(
      () =>
        h.createWorker({
          adapter: {
            mode: "live_devnet",
            broadcaster: mockBroadcaster as any,
          },
        }),
      /Live Devnet mode requires an authorized live network broadcast capability/
    );
  } finally {
    delete process.env.AGENTVAULT_ALLOW_LIVE_AUTONOMOUS_BROADCAST;
    h.cleanup();
  }
});

test("capability isolation: preview mode discards broadcaster by construction", async () => {
  const h = makeWorkerHarness();
  try {
    let broadcastCalled = false;
    const mockBroadcaster = new MockBroadcastCapability(async () => {
      broadcastCalled = true;
      return "sig";
    });

    const worker = h.createWorker({
      adapter: {
        mode: "preview",
        broadcaster: mockBroadcaster,
      },
    });

    const { record: intent } = h.createIntent("req_preview_cap_01");
    const result = await worker.processPaymentIntent(intent);

    assert.equal(result.status, "prepared");
    assert.equal(broadcastCalled, false, "Preview mode must never broadcast");
  } finally {
    h.cleanup();
  }
});

test("single-request acceptance mode: processes only matching request and ignores unrelated requests", async () => {
  const h = makeWorkerHarness();
  try {
    // Two intents in inbox: one target, one unrelated
    h.createIntent("req_target_accept_01", { amountBaseUnits: "1000" });
    h.createIntent("req_unrelated_other_02", { amountBaseUnits: "1000" });

    const worker = h.createWorker({
      targetRequest: {
        requestId: "req_target_accept_01",
        taskPda: h.taskPda.toBase58(),
        amountBaseUnits: "1000",
        maxExecutions: 1,
      },
    });

    worker.start();
    const results = await worker.processPendingIntentsOnce();

    assert.equal(results.length, 1, "Must process exactly 1 matching request");
    assert.equal(results[0].requestId, "req_target_accept_01");

    // Verify journal: target is claimed, unrelated is completely untouched
    const targetClaim = join(h.runtimeDir, "journal", "req_target_accept_01.json");
    const unrelatedClaim = join(h.runtimeDir, "journal", "req_unrelated_other_02.json");
    assert.ok(existsSync(targetClaim), "Target request must be claimed");
    assert.ok(!existsSync(unrelatedClaim), "Unrelated request must NEVER be claimed");

    // Worker must have stopped after maxExecutions = 1
    assert.equal(worker.isRunning(), false, "Worker must stop after maxExecutions reached");
  } finally {
    h.cleanup();
  }
});

test("graceful shutdown: stopGracefully stops timer and completes safely", async () => {
  const h = makeWorkerHarness();
  try {
    const worker = h.createWorker();
    worker.start();
    assert.equal(worker.isRunning(), true);

    await worker.stopGracefully();
    assert.equal(worker.isRunning(), false);
  } finally {
    h.cleanup();
  }
});

test("retry prevention: cannot process already claimed or recorded intent", async () => {
  const h = makeWorkerHarness();
  try {
    const intent = h.createIntent("req_no_retry_01").record;
    const journalDir = join(h.runtimeDir, "journal");
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(join(journalDir, "req_no_retry_01.failed.json"), "{}");

    const worker = h.createWorker();
    await assert.rejects(
      () => worker.processPaymentIntent(intent),
      /has already been processed or claimed in journal; retries are prohibited/
    );
  } finally {
    h.cleanup();
  }
});
