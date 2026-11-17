import assert from "node:assert/strict";
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
import * as nacl from "tweetnacl";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  signModelBOwnerApprovalPackage,
  saveModelBOwnerApprovalPackage,
  loadModelBOwnerApprovalPackage,
} from "./model-b-owner-approval";

import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import type { PaymentApprovalV2 } from "./payment-approval-v2";
import { encodeWorkflow, workflowApprovalSchema } from "./signed-workflow";
import type { WorkflowApprovalV2 } from "./signed-workflow-v2";

type Context = Omit<
  ModelBWorkflowBinding,
  "signedWorkflow" | "paymentApproval" | "signatureBase64"
>;

function fixture() {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agentvault-model-b-owner-"));

  const owner = Keypair.generate();
  const authority = Keypair.generate();
  const key = () => Keypair.generate().publicKey;

  const programId = key();
  const vault = key();
  const mint = key();
  const recipient = key();
  const genesisHash = key();

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), authority.publicKey.toBuffer()],
    programId
  );

  const taskId = Buffer.alloc(8);
  taskId.writeBigUInt64LE(BigInt(7));

  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskId],
    programId
  );

  const nowUnix = 1_800_000_000;
  const requestId = "modelb-owner-001";

  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId,
    genesisHash: genesisHash.toBase58(),
    programId: programId.toBase58(),
    vault: vault.toBase58(),
    owner: owner.publicKey.toBase58(),
    mint: mint.toBase58(),
    assignedAgent: "agent-a",
    agentAuthority: authority.publicKey.toBase58(),
    kind: "procurement",
    taskId: 7,
    recipient: recipient.toBase58(),
    amountBaseUnits: 1000,
    expiresAtUnix: nowUnix + 3600,
    description: "Purchase approved infrastructure services",
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
    expiresAtUnix: String(nowUnix + 1800),
    requestId,
  };

  const context: Context = {
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

  const sign = () =>
    signModelBOwnerApprovalPackage(workflow, payment, owner, context);

  return {
    runtimeDir,
    requestId,
    owner,
    workflow,
    payment,
    context,
    sign,
  };
}

function withFixture(fn: (value: ReturnType<typeof fixture>) => void): void {
  const value = fixture();

  try {
    fn(value);
  } finally {
    rmSync(value.runtimeDir, {
      recursive: true,
      force: true,
    });
  }
}

test("signs, persists and restores both exact owner approvals", () => {
  withFixture((f) => {
    const approval = f.sign();

    const paths = saveModelBOwnerApprovalPackage(
      f.runtimeDir,
      approval,
      f.context
    );

    assert.ok(existsSync(paths.workflowPath));
    assert.ok(existsSync(paths.paymentPath));

    const restored = loadModelBOwnerApprovalPackage(
      f.runtimeDir,
      f.requestId,
      f.context
    );

    assert.deepEqual(restored, approval);
    assert.equal(
      restored.signedWorkflow.workflow.authorizationModel,
      "model-b"
    );
  });
});

test("rejects signing with another owner's wallet", () => {
  withFixture((f) => {
    assert.throws(
      () =>
        signModelBOwnerApprovalPackage(
          f.workflow,
          f.payment,
          Keypair.generate(),
          f.context
        ),
      /not the Vault owner/
    );
  });
});

test("rejects a mismatched payment amount before saving", () => {
  withFixture((f) => {
    assert.throws(
      () =>
        signModelBOwnerApprovalPackage(
          f.workflow,
          { ...f.payment, amountBaseUnits: "1001" },
          f.owner,
          f.context
        ),
      /Model B binding mismatch: amountBaseUnits/
    );
  });
});

test("rejects a stale on-chain nonce", () => {
  withFixture((f) => {
    assert.throws(
      () =>
        signModelBOwnerApprovalPackage(f.workflow, f.payment, f.owner, {
          ...f.context,
          nextNonce: "1",
        }),
      /Model B binding mismatch: nonce/
    );
  });
});

test("rejects workflow changes after owner signing", () => {
  withFixture((f) => {
    const approval = f.sign();

    const changed = {
      ...approval,
      signedWorkflow: {
        ...approval.signedWorkflow,
        workflow: {
          ...approval.signedWorkflow.workflow,
          description: "Unauthorized description replacement",
        },
      },
    };

    assert.throws(
      () => saveModelBOwnerApprovalPackage(f.runtimeDir, changed, f.context),
      /Invalid workflow v2 owner signature/
    );
  });
});

test("rejects a forged payment signature", () => {
  withFixture((f) => {
    const approval = f.sign();

    assert.throws(
      () =>
        saveModelBOwnerApprovalPackage(
          f.runtimeDir,
          {
            ...approval,
            signatureBase64: Buffer.alloc(64, 7).toString("base64"),
          },
          f.context
        ),
      /Invalid Model B owner signature/
    );
  });
});

test("does not overwrite an existing approval package", () => {
  withFixture((f) => {
    const approval = f.sign();

    const paths = saveModelBOwnerApprovalPackage(
      f.runtimeDir,
      approval,
      f.context
    );

    const originalWorkflow = readFileSync(paths.workflowPath);
    const originalPayment = readFileSync(paths.paymentPath);

    assert.throws(
      () => saveModelBOwnerApprovalPackage(f.runtimeDir, approval, f.context),
      /Request already has an approval artifact/
    );

    assert.deepEqual(readFileSync(paths.workflowPath), originalWorkflow);

    assert.deepEqual(readFileSync(paths.paymentPath), originalPayment);
  });
});

test("rejects an incomplete approval package without repairing it", () => {
  withFixture((f) => {
    const approval = f.sign();
    const directory = join(f.runtimeDir, "approvals");
    const paymentPath = join(directory, `${f.requestId}.payment.json`);

    mkdirSync(directory, { recursive: true });

    writeFileSync(paymentPath, '{"incomplete":true}');

    assert.throws(
      () =>
        loadModelBOwnerApprovalPackage(f.runtimeDir, f.requestId, f.context),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );

    assert.throws(
      () => saveModelBOwnerApprovalPackage(f.runtimeDir, approval, f.context),
      /Request already has an approval artifact/
    );

    assert.equal(readFileSync(paymentPath, "utf8"), '{"incomplete":true}');
  });
});

test("refuses to reuse an existing journal request ID", () => {
  withFixture((f) => {
    const approval = f.sign();
    const directory = join(f.runtimeDir, "journal");

    mkdirSync(directory, { recursive: true });

    writeFileSync(
      join(directory, `${f.requestId}.json`),
      '{"status":"claimed"}'
    );

    assert.throws(
      () => saveModelBOwnerApprovalPackage(f.runtimeDir, approval, f.context),
      /Request ID already exists in payment journal/
    );
  });
});

test("rejects an actual signed Model A workflow in a Model B package", () => {
  withFixture((f) => {
    const approval = f.sign();

    const fields = {
      ...f.workflow,
    } as Record<string, unknown>;

    delete fields.authorizationModel;
    fields.version = 1;

    const legacyWorkflow = workflowApprovalSchema.parse(fields);

    const legacySigned = {
      workflow: legacyWorkflow,
      signature: Buffer.from(
        nacl.sign.detached(encodeWorkflow(legacyWorkflow), f.owner.secretKey)
      ).toString("base64"),
    };

    assert.throws(() =>
      saveModelBOwnerApprovalPackage(
        f.runtimeDir,
        {
          ...approval,
          signedWorkflow:
            legacySigned as unknown as typeof approval.signedWorkflow,
        },
        f.context
      )
    );
  });
});

test("rejects a payment approval that has already expired", () => {
  withFixture((f) => {
    assert.throws(
      () =>
        signModelBOwnerApprovalPackage(f.workflow, f.payment, f.owner, {
          ...f.context,
          nowUnix: Number(f.payment.expiresAtUnix),
        }),
      /Model B approval expiry invalid/
    );
  });
});
