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
import test from "node:test";
import bs58 from "bs58";

import { Keypair, PublicKey } from "@solana/web3.js";

import { prepareDurableModelBPayment } from "./model-b-durable-preparation";
import { loadPreparedModelBPayment } from "./model-b-prepared-payment";
import { signModelBOwnerApprovalPackage } from "./model-b-owner-approval";
import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import type { WorkflowApprovalV2 } from "./signed-workflow-v2";
import type { PaymentApprovalV2 } from "./payment-approval-v2";

function fixture() {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agentvault-model-b-durable-"));
  const owner = Keypair.generate();
  const agentSigner = Keypair.generate();
  const pubkey = () => Keypair.generate().publicKey;
  const vault = pubkey();
  const mint = pubkey();
  const recipient = pubkey();
  const genesisHash = pubkey();
  const taskIdBytes = Buffer.alloc(8);
  taskIdBytes.writeBigUInt64LE(BigInt(7));
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), agentSigner.publicKey.toBuffer()],
    AGENTVAULT_PROGRAM_ID
  );
  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskIdBytes],
    AGENTVAULT_PROGRAM_ID
  );
  const nowUnix = 1_800_000_000;
  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId: "modelb-durable-001",
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
    description: "Owner-approved infrastructure purchase",
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
  const context = {
    scope: {
      network: workflow.network,
      genesisHash: workflow.genesisHash,
      programId: workflow.programId,
      vault: workflow.vault,
      owner: workflow.owner,
      mint: workflow.mint,
    },
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
    context
  );
  const binding: ModelBWorkflowBinding = { ...context, ...signed };
  const blockhash = pubkey().toBase58();
  const height = 150;
  const journalPath = join(runtimeDir, "journal", `${workflow.requestId}.json`);
  const signedPath = join(
    runtimeDir,
    "journal",
    `${workflow.requestId}.signed.json`
  );
  return {
    runtimeDir,
    owner,
    agentSigner,
    binding,
    blockhash,
    height,
    journalPath,
    signedPath,
    requestId: workflow.requestId,
  };
}

function withFixture(run: (f: ReturnType<typeof fixture>) => void): void {
  const f = fixture();
  try {
    run(f);
  } finally {
    rmSync(f.runtimeDir, { recursive: true, force: true });
  }
}

function prepare(f: ReturnType<typeof fixture>) {
  return prepareDurableModelBPayment(
    f.runtimeDir,
    f.binding,
    f.agentSigner,
    f.blockhash,
    f.height
  );
}

test("claims, signs, durably stores and restores exact Model B bytes", () => {
  withFixture((f) => {
    const result = prepare(f);
    assert.equal(result.requestId, f.requestId);
    assert.equal(result.blockhash, f.blockhash);
    assert.equal(result.lastValidBlockHeight, f.height);
    assert.ok(existsSync(f.journalPath));
    assert.ok(existsSync(f.signedPath));

    const claim = JSON.parse(readFileSync(f.journalPath, "utf8"));
    assert.equal(claim.version, 2);
    assert.equal(claim.authorizationModel, "model-b");
    assert.equal(claim.status, "claimed");

    const restored = loadPreparedModelBPayment(
      f.runtimeDir,
      f.requestId,
      f.binding.signedWorkflow,
      f.binding.scope
    );
    assert.deepEqual(result.rawTransaction, restored.raw);
    assert.equal(
      result.signature,
      bs58.encode(restored.transaction.signature!)
    );
    assert.equal(
      restored.record.transactionSha256,
      createHash("sha256").update(result.rawTransaction).digest("hex")
    );
  });
});

test("rejects wrong agent key before writing a claim", () => {
  withFixture((f) => {
    assert.throws(
      () =>
        prepareDurableModelBPayment(
          f.runtimeDir,
          f.binding,
          Keypair.generate(),
          f.blockhash,
          f.height
        ),
      /Model B agent signer mismatch/
    );
    assert.equal(existsSync(f.journalPath), false);
  });
});

test("rejects invalid blockhash validity height before writing a claim", () => {
  withFixture((f) => {
    assert.throws(
      () =>
        prepareDurableModelBPayment(
          f.runtimeDir,
          f.binding,
          f.agentSigner,
          f.blockhash,
          0
        ),
      /Invalid Model B blockhash validity height/
    );
    assert.equal(existsSync(f.journalPath), false);
  });
});

test("rejects changed on-chain nonce before writing a claim", () => {
  withFixture((f) => {
    assert.throws(
      () =>
        prepareDurableModelBPayment(
          f.runtimeDir,
          { ...f.binding, nextNonce: "1" },
          f.agentSigner,
          f.blockhash,
          f.height
        ),
      /Model B binding mismatch: nonce/
    );
    assert.equal(existsSync(f.journalPath), false);
  });
});

test("rejects forged owner payment signature before writing a claim", () => {
  withFixture((f) => {
    assert.throws(
      () =>
        prepareDurableModelBPayment(
          f.runtimeDir,
          {
            ...f.binding,
            signatureBase64: Buffer.alloc(64, 7).toString("base64"),
          },
          f.agentSigner,
          f.blockhash,
          f.height
        ),
      /Invalid Model B owner signature/
    );
    assert.equal(existsSync(f.journalPath), false);
  });
});

test("rejects duplicate preparation and preserves original signed bytes", () => {
  withFixture((f) => {
    prepare(f);
    const beforeClaim = readFileSync(f.journalPath);
    const beforeSigned = readFileSync(f.signedPath);
    assert.throws(() => prepare(f), /already claimed/);
    assert.deepEqual(readFileSync(f.journalPath), beforeClaim);
    assert.deepEqual(readFileSync(f.signedPath), beforeSigned);
  });
});

test("conflicting prepared file fails closed and leaves journal claimed", () => {
  withFixture((f) => {
    mkdirSync(join(f.runtimeDir, "journal"), { recursive: true });
    writeFileSync(f.signedPath, "occupied");
    assert.throws(
      () => prepare(f),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST"
    );
    assert.equal(readFileSync(f.signedPath, "utf8"), "occupied");
    assert.equal(existsSync(f.journalPath), true);
  });
});
