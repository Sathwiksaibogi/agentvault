import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as nacl from "tweetnacl";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";

import { encodeWorkflow, workflowApprovalSchema } from "./signed-workflow";
import {
  encodeWorkflowV2,
  type WorkflowApprovalV2,
} from "./signed-workflow-v2";
import { computeModelBWorkflowDigest } from "./model-b-workflow-digest";
import { claimApprovedWorkflow } from "./request-journal";
import { prepareSignedPayment } from "./prepared-payment";
import {
  encodePaymentApprovalV2,
  type PaymentApprovalV2,
} from "./payment-approval-v2";
import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import {
  claimModelBWorkflow,
  verifyModelBJournalClaim,
} from "./model-b-request-journal";

function fixture(): {
  binding: ModelBWorkflowBinding;
  signPayment: (approval: PaymentApprovalV2) => string;
  signWorkflow: (workflow: WorkflowApprovalV2) => string;
  owner: Keypair;
} {
  const owner = Keypair.generate();
  const key = () => Keypair.generate().publicKey;
  const programId = key();
  const vault = key();
  const authority = key();
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), authority.toBuffer()],
    programId
  );
  const taskId = Buffer.alloc(8);
  taskId.writeBigUInt64LE(BigInt(7));
  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskId],
    programId
  );
  const nowUnix = 1_800_000_000;
  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId: "modelb-journal-001",
    genesisHash: key().toBase58(),
    programId: programId.toBase58(),
    vault: vault.toBase58(),
    owner: owner.publicKey.toBase58(),
    mint: key().toBase58(),
    assignedAgent: "agent-a",
    agentAuthority: authority.toBase58(),
    kind: "procurement",
    taskId: 7,
    recipient: key().toBase58(),
    amountBaseUnits: 1_000,
    expiresAtUnix: nowUnix + 3_600,
    description: "Owner approved compute resource purchase",
  };
  const signWorkflow = (value: WorkflowApprovalV2) =>
    Buffer.from(
      nacl.sign.detached(encodeWorkflowV2(value), owner.secretKey)
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
    expiresAtUnix: String(nowUnix + 1_800),
    requestId: workflow.requestId,
  };
  const signPayment = (value: PaymentApprovalV2) =>
    Buffer.from(
      nacl.sign.detached(encodePaymentApprovalV2(value), owner.secretKey)
    ).toString("base64");

  return {
    binding: {
      signedWorkflow: { workflow, signature: signWorkflow(workflow) },
      paymentApproval,
      signatureBase64: signPayment(paymentApproval),
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
      taskExpiresAtUnix: String(nowUnix + 7_200),
      nowUnix,
    },
    signPayment,
    signWorkflow,
    owner,
  };
}

function signLegacyModelAWorkflow(
  binding: ModelBWorkflowBinding,
  owner: Keypair
) {
  const v2 = (binding.signedWorkflow as { workflow: WorkflowApprovalV2 })
    .workflow;

  const fields = { ...v2 } as Record<string, unknown>;
  delete fields.authorizationModel;
  fields.version = 1;

  const workflow = workflowApprovalSchema.parse(fields);

  return {
    workflow,
    signature: Buffer.from(
      nacl.sign.detached(encodeWorkflow(workflow), owner.secretKey)
    ).toString("base64"),
  };
}

function inTemporaryJournal(fn: (runtimeDir: string) => void): void {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agentvault-model-b-"));
  try {
    fn(runtimeDir);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function verify(runtimeDir: string, binding: ModelBWorkflowBinding) {
  const signed = binding.signedWorkflow as { workflow: WorkflowApprovalV2 };
  return verifyModelBJournalClaim(
    runtimeDir,
    signed.workflow.requestId,
    binding.signedWorkflow,
    binding.paymentApproval,
    binding.signatureBase64,
    binding.scope
  );
}

test("claims a versioned Model B journal with both approval digests", () => {
  inTemporaryJournal((dir) => {
    const { binding } = fixture();
    const { record, path } = claimModelBWorkflow(dir, binding);
    assert.equal(record.version, 2);
    assert.equal(record.authorizationModel, "model-b");
    assert.match(record.workflowApprovalDigest, /^[0-9a-f]{64}$/);
    assert.equal(
      record.workflowApprovalDigest,
      computeModelBWorkflowDigest(binding.signedWorkflow)
    );
    assert.match(record.paymentApprovalDigest, /^[0-9a-f]{64}$/);
    assert.notEqual(
      record.workflowApprovalDigest,
      record.paymentApprovalDigest
    );
    assert.deepEqual(
      verify(dir, binding),
      JSON.parse(readFileSync(path, "utf8"))
    );
  });
});

test("rejects a duplicate claim and preserves the original journal", () => {
  inTemporaryJournal((dir) => {
    const { binding } = fixture();
    const { path } = claimModelBWorkflow(dir, binding);
    const before = readFileSync(path);
    assert.throws(() => claimModelBWorkflow(dir, binding), /already claimed/);
    assert.deepEqual(readFileSync(path), before);
  });
});

test("rejects a forged v2 signature before writing a claim", () => {
  inTemporaryJournal((dir) => {
    const { binding } = fixture();
    const forged = Buffer.alloc(64, 1).toString("base64");
    assert.throws(
      () => claimModelBWorkflow(dir, { ...binding, signatureBase64: forged }),
      /Invalid Model B owner signature/
    );
    const workflow = (
      binding.signedWorkflow as { workflow: WorkflowApprovalV2 }
    ).workflow;
    assert.equal(
      existsSync(join(dir, "journal", `${workflow.requestId}.json`)),
      false
    );
  });
});

test("rejects a different, valid v2 signature during recovery inspection", () => {
  inTemporaryJournal((dir) => {
    const { binding, signPayment } = fixture();
    claimModelBWorkflow(dir, binding);
    const changed = {
      ...(binding.paymentApproval as PaymentApprovalV2),
      expiresAtUnix: String(binding.nowUnix + 1_500),
    };
    assert.throws(
      () =>
        verify(dir, {
          ...binding,
          paymentApproval: changed,
          signatureBase64: signPayment(changed),
        }),
      /payment approval digest mismatch/
    );
  });
});

test("rejects a different, valid v2 workflow during recovery inspection", () => {
  inTemporaryJournal((dir) => {
    const { binding, signWorkflow } = fixture();
    claimModelBWorkflow(dir, binding);
    const signed = binding.signedWorkflow as { workflow: WorkflowApprovalV2 };
    const changed = {
      ...signed.workflow,
      description: "A new, separately signed description",
    };
    assert.throws(
      () =>
        verify(dir, {
          ...binding,
          signedWorkflow: {
            workflow: changed,
            signature: signWorkflow(changed),
          },
        }),
      /workflow approval digest mismatch/
    );
  });
});

test("verifies historical claim without reading current task nonce", () => {
  inTemporaryJournal((dir) => {
    const { binding } = fixture();
    claimModelBWorkflow(dir, binding);
    const saved = verify(dir, binding);
    assert.equal(saved.nonce, "0");
    assert.equal(
      saved.claimedAt,
      new Date(binding.nowUnix * 1000).toISOString()
    );
    // No live RPC or new payment authorization occurs during inspection.
  });
});

test("a Model A claim locks the same request ID against Model B", () => {
  inTemporaryJournal((dir) => {
    const { binding, owner } = fixture();
    const signedLegacy = signLegacyModelAWorkflow(binding, owner);

    claimApprovedWorkflow(dir, signedLegacy, binding.scope, binding.nowUnix);

    assert.throws(() => claimModelBWorkflow(dir, binding), /already claimed/);
  });
});

test("rejects a valid signed v1 workflow before creating a Model B claim", () => {
  inTemporaryJournal((dir) => {
    const { binding, owner } = fixture();
    const signedLegacy = signLegacyModelAWorkflow(binding, owner);

    assert.throws(() =>
      claimModelBWorkflow(dir, {
        ...binding,
        signedWorkflow: signedLegacy,
      })
    );

    const v2 = (binding.signedWorkflow as { workflow: WorkflowApprovalV2 })
      .workflow;

    assert.equal(
      existsSync(join(dir, "journal", `${v2.requestId}.json`)),
      false
    );
  });
});

test("Model A prepared-payment path rejects a Model B journal", () => {
  inTemporaryJournal((dir) => {
    const { binding } = fixture();
    const { record } = claimModelBWorkflow(dir, binding);
    assert.throws(
      () =>
        prepareSignedPayment(
          dir,
          record.requestId,
          "agent-a",
          new PublicKey(record.agentAuthority),
          new PublicKey(record.taskPda),
          record.amountBaseUnits,
          record.nonce,
          100,
          new Transaction()
        ),
      /Model B claims cannot use Model A payment persistence/
    );
    assert.equal(
      existsSync(join(dir, "journal", `${record.requestId}.signed.json`)),
      false
    );
  });
});
