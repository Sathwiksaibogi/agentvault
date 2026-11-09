import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as nacl from "tweetnacl";

import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import { encodeWorkflow, type WorkflowApproval } from "./signed-workflow";

import {
  encodePaymentApprovalV2,
  type PaymentApprovalV2,
} from "./payment-approval-v2";

import {
  buildBoundModelBOwnerInstruction,
  type ModelBWorkflowBinding,
} from "./model-b-workflow-binding";

import { claimModelBWorkflow } from "./model-b-request-journal";

import {
  loadPreparedModelBPayment,
  prepareSignedModelBPayment,
} from "./model-b-prepared-payment";

function fixture() {
  const runtimeDir = mkdtempSync(
    join(tmpdir(), "agentvault-model-b-prepared-")
  );

  const owner = Keypair.generate();
  const agentSigner = Keypair.generate();

  const key = () => Keypair.generate().publicKey;

  const vault = key();
  const mint = key();
  const recipient = key();
  const genesisHash = key();

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), agentSigner.publicKey.toBuffer()],
    AGENTVAULT_PROGRAM_ID
  );

  const taskId = Buffer.alloc(8);
  taskId.writeBigUInt64LE(BigInt(7));

  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskId],
    AGENTVAULT_PROGRAM_ID
  );

  const nowUnix = 1_800_000_000;

  const workflow: WorkflowApproval = {
    version: 1,
    network: "devnet",
    requestId: "modelb-persist-001",
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
    description: "Owner-approved compute infrastructure purchase",
  };

  const signWorkflow = (value: WorkflowApproval): string =>
    Buffer.from(
      nacl.sign.detached(encodeWorkflow(value), owner.secretKey)
    ).toString("base64");

  const paymentApproval: PaymentApprovalV2 = {
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
    expiresAtUnix: String(nowUnix + 1800),
    requestId: workflow.requestId,
  };

  const signedWorkflow = {
    workflow,
    signature: signWorkflow(workflow),
  };

  const signatureBase64 = Buffer.from(
    nacl.sign.detached(
      encodePaymentApprovalV2(paymentApproval),
      owner.secretKey
    )
  ).toString("base64");

  const binding: ModelBWorkflowBinding = {
    signedWorkflow,
    paymentApproval,
    signatureBase64,
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

  claimModelBWorkflow(runtimeDir, binding);

  // Construct the exact Anchor instruction argument layout.
  const data = Buffer.alloc(64);

  createHash("sha256")
    .update("global:execute_approved_payment")
    .digest()
    .copy(data, 0, 0, 8);

  data.writeBigUInt64LE(BigInt(1000), 8);
  data.writeBigUInt64LE(BigInt(0), 16);
  data.writeBigInt64LE(BigInt(paymentApproval.expiresAtUnix), 24);

  createHash("sha256")
    .update(workflow.requestId, "utf8")
    .digest()
    .copy(data, 32);

  const treasury = getAssociatedTokenAddressSync(mint, vault, true);

  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);

  const paymentInstruction = new TransactionInstruction({
    programId: AGENTVAULT_PROGRAM_ID,
    data,
    keys: [
      {
        pubkey: agentSigner.publicKey,
        isSigner: true,
        isWritable: false,
      },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: agentPda, isSigner: false, isWritable: false },
      { pubkey: approvedTaskPda, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: false },
      { pubkey: recipientAta, isSigner: false, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
  });

  const transaction = new Transaction({
    feePayer: agentSigner.publicKey,
    recentBlockhash: key().toBase58(),
  }).add(
    createAssociatedTokenAccountIdempotentInstruction(
      agentSigner.publicKey,
      recipientAta,
      recipient,
      mint
    ),
    buildBoundModelBOwnerInstruction(binding),
    paymentInstruction
  );

  transaction.sign(agentSigner);

  return {
    runtimeDir,
    binding,
    transaction,
    agentSigner,
    owner,
    signWorkflow,
    requestId: workflow.requestId,
    claimPath: join(runtimeDir, "journal", `${workflow.requestId}.json`),
    signedPath: join(
      runtimeDir,
      "journal",
      `${workflow.requestId}.signed.json`
    ),
  };
}

function withFixture(fn: (data: ReturnType<typeof fixture>) => void): void {
  const data = fixture();

  try {
    fn(data);
  } finally {
    rmSync(data.runtimeDir, {
      recursive: true,
      force: true,
    });
  }
}

function prepare(data: ReturnType<typeof fixture>) {
  return prepareSignedModelBPayment(
    data.runtimeDir,
    data.binding,
    150,
    data.transaction
  );
}

function load(data: ReturnType<typeof fixture>) {
  return loadPreparedModelBPayment(
    data.runtimeDir,
    data.requestId,
    data.binding.signedWorkflow,
    data.binding.scope
  );
}

test("persists and restores the exact signed Model B payment", () => {
  withFixture((data) => {
    const { record, path } = prepare(data);

    assert.equal(record.version, 2);
    assert.equal(record.authorizationModel, "model-b");
    assert.equal(record.nonce, "0");
    assert.equal(record.amountBaseUnits, 1000);
    assert.equal(record.taskPda, data.binding.approvedTaskPda.toBase58());
    assert.equal(existsSync(path), true);

    const restored = load(data);

    assert.deepEqual(restored.raw, data.transaction.serialize());

    assert.equal(
      restored.record.transactionSha256,
      createHash("sha256").update(restored.raw).digest("hex")
    );

    assert.ok(restored.transaction.verifySignatures());
  });
});

test("rejects preparing a second transaction for the same request", () => {
  withFixture((data) => {
    prepare(data);

    const original = readFileSync(data.signedPath);

    assert.throws(
      () => prepare(data),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST"
    );

    assert.deepEqual(readFileSync(data.signedPath), original);
  });
});

test("rejects a modified Model B journal approval digest", () => {
  withFixture((data) => {
    const claim = JSON.parse(readFileSync(data.claimPath, "utf8"));

    claim.paymentApprovalDigest = "0".repeat(64);

    writeFileSync(data.claimPath, JSON.stringify(claim, null, 2));

    assert.throws(
      () => prepare(data),
      /Model B payment approval digest mismatch/
    );

    assert.equal(existsSync(data.signedPath), false);
  });
});

test("rejects a Model A claim masquerading as Model B", () => {
  withFixture((data) => {
    const claim = JSON.parse(readFileSync(data.claimPath, "utf8"));

    claim.version = 1;

    writeFileSync(data.claimPath, JSON.stringify(claim));

    assert.throws(() => prepare(data), /Expected a Model B v2 claim/);

    assert.equal(existsSync(data.signedPath), false);
  });
});

test("rejects a transaction containing an extra transfer", () => {
  withFixture((data) => {
    data.transaction.instructions.splice(
      2,
      0,
      SystemProgram.transfer({
        fromPubkey: data.agentSigner.publicKey,
        toPubkey: data.owner.publicKey,
        lamports: 1,
      })
    );

    data.transaction.sign(data.agentSigner);

    assert.throws(
      () => prepare(data),
      /Model B requires exactly three instructions/
    );

    assert.equal(existsSync(data.signedPath), false);
  });
});

test("rejects a payment amount changed after owner approval", () => {
  withFixture((data) => {
    data.transaction.instructions[2].data[8] ^= 1;
    data.transaction.sign(data.agentSigner);

    assert.throws(() => prepare(data));

    assert.equal(existsSync(data.signedPath), false);
  });
});

test("rejects corrupted stored transaction bytes", () => {
  withFixture((data) => {
    prepare(data);

    const record = JSON.parse(readFileSync(data.signedPath, "utf8"));

    const raw = Buffer.from(record.rawTransactionBase64, "base64");

    raw[1] ^= 1;

    record.rawTransactionBase64 = raw.toString("base64");

    writeFileSync(data.signedPath, JSON.stringify(record));

    assert.throws(
      () => load(data),
      /Stored Model B transaction digest mismatch/
    );
  });
});

test("rejects a forged agent signature even if the stored hash is updated", () => {
  withFixture((data) => {
    prepare(data);

    const record = JSON.parse(readFileSync(data.signedPath, "utf8"));

    const raw = Buffer.from(record.rawTransactionBase64, "base64");

    // One-signature transaction: byte 0 is the signature
    // count, followed by the 64-byte agent signature.
    raw[1] ^= 1;

    // Simulate an attacker updating the ordinary file
    // checksum after modifying the signature.
    record.rawTransactionBase64 = raw.toString("base64");
    record.transactionSha256 = createHash("sha256").update(raw).digest("hex");

    writeFileSync(data.signedPath, JSON.stringify(record));

    assert.throws(() => load(data), /Invalid agent signature/);
  });
});

test("rejects a substituted signed workflow during restoration", () => {
  withFixture((data) => {
    prepare(data);

    const original = (
      data.binding.signedWorkflow as {
        workflow: WorkflowApproval;
      }
    ).workflow;

    const changed = {
      ...original,
      description: "Separately signed substituted purchase",
    };

    const substituted = {
      workflow: changed,
      signature: data.signWorkflow(changed),
    };

    assert.throws(
      () =>
        loadPreparedModelBPayment(
          data.runtimeDir,
          data.requestId,
          substituted,
          data.binding.scope
        ),
      /Model B workflow approval digest mismatch/
    );
  });
});
