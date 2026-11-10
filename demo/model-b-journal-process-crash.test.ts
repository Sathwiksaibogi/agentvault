import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import { claimModelBWorkflow } from "./model-b-request-journal";
import { prepareDurableModelBPayment } from "./model-b-durable-preparation";
import { loadPreparedModelBPayment } from "./model-b-prepared-payment";
import {
  inspectModelBRecovery,
  type ModelBRecoveryRpc,
} from "./model-b-read-only-recovery";
import { signModelBOwnerApprovalPackage } from "./model-b-owner-approval";
import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import type { WorkflowApprovalV2 } from "./signed-workflow-v2";
import type { PaymentApprovalV2 } from "./payment-approval-v2";

/**
 * No live RPC, no real signing keys, no payment submission and no repo files.
 * These tests establish local file-system crash semantics only. They do not
 * establish distributed locking, multi-host atomicity or exactly-once RPC send.
 */
function fixture() {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agentvault-76c1-"));
  const owner = Keypair.generate();
  const agentSigner = Keypair.generate();
  const key = () => Keypair.generate().publicKey;
  const vault = key();
  const mint = key();
  const recipient = key();
  const genesisHash = key();
  const taskBytes = Buffer.alloc(8);
  taskBytes.writeBigUInt64LE(BigInt(7));
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), agentSigner.publicKey.toBuffer()],
    AGENTVAULT_PROGRAM_ID
  );
  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskBytes],
    AGENTVAULT_PROGRAM_ID
  );
  const nowUnix = 1_800_000_000;
  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId: "modelb-crash-race-001",
    genesisHash: genesisHash.toBase58(),
    programId: AGENTVAULT_PROGRAM_ID.toBase58(),
    vault: vault.toBase58(),
    owner: owner.publicKey.toBase58(),
    mint: mint.toBase58(),
    assignedAgent: "agent-a",
    agentAuthority: agentSigner.publicKey.toBase58(),
    kind: "procurement",
    taskId: 7,
    recipient: recipient.toBase58(),
    amountBaseUnits: 1000,
    expiresAtUnix: nowUnix + 3600,
    description: "Synthetic test-only recovery check",
  };
  const payment: PaymentApprovalV2 = {
    version: 2,
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
    agent: agentPda.toBase58(),
    agentAuthority: workflow.agentAuthority,
    task: approvedTaskPda.toBase58(),
    recipient: workflow.recipient,
    amountBaseUnits: "1000",
    nonce: "0",
    expiresAtUnix: String(nowUnix + 1200),
    requestId: workflow.requestId,
  };
  const scope = {
    network: workflow.network,
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
  };
  const signingContext = {
    scope,
    agentPda,
    approvedTaskPda,
    nextNonce: "0",
    taskExpiresAtUnix: String(nowUnix + 7200),
    nowUnix,
  };
  const signed = signModelBOwnerApprovalPackage(
    workflow,
    payment,
    owner,
    signingContext
  );
  const binding: ModelBWorkflowBinding = { ...signingContext, ...signed };
  const claimPath = join(runtimeDir, "journal", `${workflow.requestId}.json`);
  const signedPath = join(
    runtimeDir,
    "journal",
    `${workflow.requestId}.signed.json`
  );
  const approvalPath = join(
    runtimeDir,
    "approvals",
    `${workflow.requestId}.json`
  );
  const blockhash = key().toBase58();
  const lastValidBlockHeight = 150;
  return {
    runtimeDir,
    workflow,
    scope,
    binding,
    agentSigner,
    claimPath,
    signedPath,
    approvalPath,
    blockhash,
    lastValidBlockHeight,
  };
}

type Fixture = ReturnType<typeof fixture>;

async function withFixture(fn: (f: Fixture) => Promise<void> | void) {
  const f = fixture();
  try {
    await fn(f);
  } finally {
    rmSync(f.runtimeDir, { recursive: true, force: true });
  }
}

function saveOwnerWorkflow(f: Fixture) {
  mkdirSync(dirname(f.approvalPath), { recursive: true, mode: 0o700 });
  writeFileSync(f.approvalPath, JSON.stringify(f.binding.signedWorkflow), {
    flag: "wx",
    mode: 0o600,
  });
}

function offlineRecoveryRpc(
  f: Fixture,
  status: unknown,
  observedHeight: number
) {
  const calls = { genesis: 0, status: 0, height: 0 };
  const rpc = {
    async getGenesisHash() {
      calls.genesis++;
      return f.scope.genesisHash;
    },
    async getSignatureStatuses() {
      calls.status++;
      return { value: [status] };
    },
    async getBlockHeight() {
      calls.height++;
      return observedHeight;
    },
  } as unknown as ModelBRecoveryRpc;
  return { rpc, calls };
}

function prepare(f: Fixture) {
  return prepareDurableModelBPayment(
    f.runtimeDir,
    f.binding,
    f.agentSigner,
    f.blockhash,
    f.lastValidBlockHeight
  );
}

function spawnWorker(
  fixturePath: string,
  cwd: string
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  const workerPath = join(cwd, "demo", "model-b-claim-race-worker.ts");
  assert.ok(existsSync(workerPath), "Missing test-only Model B claim worker");
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", workerPath, fixturePath], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exit) => resolve({ exit, stdout, stderr }));
  });
}

test("a crash after durable claim but before signing permanently locks the request", async () => {
  await withFixture((f) => {
    // Simulate the process stopping immediately after the fsynced exclusive claim.
    claimModelBWorkflow(f.runtimeDir, f.binding);
    const before = readFileSync(f.claimPath);
    assert.equal(existsSync(f.signedPath), false);
    assert.throws(() => prepare(f), /already claimed/);
    assert.deepEqual(readFileSync(f.claimPath), before);
    assert.equal(existsSync(f.signedPath), false);
    assert.deepEqual(readdirSync(dirname(f.claimPath)), [
      `${f.workflow.requestId}.json`,
    ]);
  });
});

test("claim-only recovery fails before any RPC call and cannot make replacement bytes", async () => {
  await withFixture(async (f) => {
    claimModelBWorkflow(f.runtimeDir, f.binding);
    saveOwnerWorkflow(f);
    const before = readFileSync(f.claimPath);
    const mock = offlineRecoveryRpc(f, null, 100);
    await assert.rejects(
      inspectModelBRecovery(
        f.runtimeDir,
        f.workflow.requestId,
        f.scope,
        mock.rpc
      ),
      /ENOENT/
    );
    assert.deepEqual(mock.calls, { genesis: 0, status: 0, height: 0 });
    assert.equal(existsSync(f.signedPath), false);
    assert.deepEqual(readFileSync(f.claimPath), before);
  });
});

test("after a post-persistence crash, recovery sees exact original bytes as pending", async () => {
  await withFixture(async (f) => {
    const prepared = prepare(f);
    saveOwnerWorkflow(f);
    const beforeClaim = readFileSync(f.claimPath);
    const beforeSigned = readFileSync(f.signedPath);
    const mock = offlineRecoveryRpc(f, null, 100);
    const inspected = await inspectModelBRecovery(
      f.runtimeDir,
      f.workflow.requestId,
      f.scope,
      mock.rpc
    );
    assert.equal(inspected.recoveryState, "PENDING");
    assert.equal(inspected.signature, prepared.signature);
    assert.equal(inspected.savedBytes, prepared.rawTransaction.length);
    assert.deepEqual(mock.calls, { genesis: 2, status: 1, height: 1 });
    assert.deepEqual(readFileSync(f.claimPath), beforeClaim);
    assert.deepEqual(readFileSync(f.signedPath), beforeSigned);
    assert.throws(() => prepare(f), /already claimed/);
  });
});

test("expired, unobserved saved transaction remains unresolved and cannot be recreated", async () => {
  await withFixture(async (f) => {
    prepare(f);
    saveOwnerWorkflow(f);
    const signedBytes = readFileSync(f.signedPath);
    const mock = offlineRecoveryRpc(f, null, f.lastValidBlockHeight + 1);
    const inspected = await inspectModelBRecovery(
      f.runtimeDir,
      f.workflow.requestId,
      f.scope,
      mock.rpc
    );
    assert.equal(inspected.recoveryState, "EXPIRED_UNRESOLVED");
    assert.deepEqual(readFileSync(f.signedPath), signedBytes);
    assert.throws(() => prepare(f), /already claimed/);
  });
});

test("corrupted saved bytes fail closed before a recovery status lookup", async () => {
  await withFixture(async (f) => {
    prepare(f);
    saveOwnerWorkflow(f);
    const signed = JSON.parse(readFileSync(f.signedPath, "utf8"));
    const raw = Buffer.from(signed.rawTransactionBase64, "base64");
    raw[raw.length - 1] ^= 1;
    signed.rawTransactionBase64 = raw.toString("base64");
    writeFileSync(f.signedPath, JSON.stringify(signed));
    const mock = offlineRecoveryRpc(f, null, 100);
    await assert.rejects(
      inspectModelBRecovery(
        f.runtimeDir,
        f.workflow.requestId,
        f.scope,
        mock.rpc
      ),
      /digest mismatch/i
    );
    assert.deepEqual(mock.calls, { genesis: 0, status: 0, height: 0 });
  });
});

test("separate OS processes have exactly one winning claim on the same local filesystem", async () => {
  await withFixture(async (f) => {
    const fixturePath = join(f.runtimeDir, "race-fixture.json");
    // Public approvals only: never serialize owner or agent private keys.
    const input = {
      runtimeDir: f.runtimeDir,
      signedWorkflow: f.binding.signedWorkflow,
      paymentApproval: f.binding.paymentApproval,
      signatureBase64: f.binding.signatureBase64,
      scope: f.binding.scope,
      agentPda: f.binding.agentPda.toBase58(),
      approvedTaskPda: f.binding.approvedTaskPda.toBase58(),
      nextNonce: f.binding.nextNonce,
      taskExpiresAtUnix: f.binding.taskExpiresAtUnix,
      nowUnix: f.binding.nowUnix,
    };
    writeFileSync(fixturePath, JSON.stringify(input), {
      flag: "wx",
      mode: 0o600,
    });
    // Each process validates the same signed owner approvals before O_EXCL.
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => spawnWorker(fixturePath, process.cwd()))
    );
    const wins = outcomes.filter(
      (o) => o.exit === 0 && o.stdout.includes("CLAIM_OK")
    );
    const denied = outcomes.filter(
      (o) => o.exit === 2 && o.stdout.includes("CLAIM_EXISTS")
    );
    assert.equal(
      wins.length,
      1,
      `Expected one winner: ${JSON.stringify(outcomes)}`
    );
    assert.equal(
      denied.length,
      4,
      `Expected four existing-claim denials: ${JSON.stringify(outcomes)}`
    );
    const claim = JSON.parse(readFileSync(f.claimPath, "utf8"));
    assert.equal(claim.version, 2);
    assert.equal(claim.authorizationModel, "model-b");
    assert.equal(claim.requestId, f.workflow.requestId);
    assert.equal(claim.status, "claimed");
    assert.equal(existsSync(f.signedPath), false);
    assert.throws(() => prepare(f), /already claimed/);
  });
});

test("read-only restoration after a simulated restart never changes journal bytes", async () => {
  await withFixture((f) => {
    const prepared = prepare(f);
    const claimBefore = readFileSync(f.claimPath);
    const signedBefore = readFileSync(f.signedPath);
    const restored = loadPreparedModelBPayment(
      f.runtimeDir,
      f.workflow.requestId,
      f.binding.signedWorkflow,
      f.scope
    );
    assert.deepEqual(restored.raw, prepared.rawTransaction);
    assert.deepEqual(readFileSync(f.claimPath), claimBefore);
    assert.deepEqual(readFileSync(f.signedPath), signedBefore);
  });
});
