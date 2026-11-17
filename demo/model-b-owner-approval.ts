import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { Keypair, PublicKey } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { z } from "zod";

import {
  encodeWorkflowV2,
  signedWorkflowV2Schema,
  workflowApprovalV2Schema,
  type SignedWorkflowV2,
} from "./signed-workflow-v2";

import {
  encodePaymentApprovalV2,
  paymentApprovalV2Schema,
  type PaymentApprovalV2,
} from "./payment-approval-v2";

import {
  buildBoundModelBOwnerInstruction,
  type ModelBWorkflowBinding,
} from "./model-b-workflow-binding";

type BindingContext = Omit<
  ModelBWorkflowBinding,
  "signedWorkflow" | "paymentApproval" | "signatureBase64"
>;

export type ModelBOwnerApprovalPackage = {
  signedWorkflow: SignedWorkflowV2;
  paymentApproval: PaymentApprovalV2;
  signatureBase64: string;
};

const requestIdPattern = /^[a-zA-Z0-9_-]{8,64}$/;

const paymentFileSchema = z
  .object({
    version: z.literal(2),
    authorizationModel: z.literal("model-b"),
    paymentApproval: paymentApprovalV2Schema,
    signatureBase64: z.string().min(1),
  })
  .strict();

function verifyPackage(
  approval: ModelBOwnerApprovalPackage,
  context: BindingContext
): void {
  const workflow = signedWorkflowV2Schema.parse(approval.signedWorkflow);

  assert.equal(workflow.workflow.authorizationModel, "model-b");

  // This verifies both owner signatures, all signed fields,
  // exact PDAs, current nonce, expiry and payment scope.
  buildBoundModelBOwnerInstruction({
    ...context,
    signedWorkflow: workflow,
    paymentApproval: approval.paymentApproval,
    signatureBase64: approval.signatureBase64,
  });
}

/**
 * Call ONLY after live on-chain policy validation and
 * interactive owner confirmation.
 */
export function signModelBOwnerApprovalPackage(
  workflowInput: unknown,
  paymentInput: unknown,
  owner: Keypair,
  context: BindingContext
): ModelBOwnerApprovalPackage {
  const workflow = workflowApprovalV2Schema.parse(workflowInput);
  const paymentApproval = paymentApprovalV2Schema.parse(paymentInput);

  assert.ok(
    owner.publicKey.equals(new PublicKey(workflow.owner)),
    "Model B signing key is not the Vault owner"
  );

  assert.equal(
    workflow.owner,
    context.scope.owner,
    "Model B owner scope mismatch"
  );

  const workflowSignature = nacl.sign.detached(
    encodeWorkflowV2(workflow),
    owner.secretKey
  );

  const paymentSignature = nacl.sign.detached(
    encodePaymentApprovalV2(paymentApproval),
    owner.secretKey
  );

  const result: ModelBOwnerApprovalPackage = {
    signedWorkflow: {
      workflow,
      signature: Buffer.from(workflowSignature).toString("base64"),
    },
    paymentApproval,
    signatureBase64: Buffer.from(paymentSignature).toString("base64"),
  };

  verifyPackage(result, context);

  return result;
}

function writeExclusiveJson(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);

  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Store payment approval first, signed workflow second.
 *
 * If interrupted between writes, execution must reject
 * the incomplete pair. Never silently repair or overwrite.
 */
export function saveModelBOwnerApprovalPackage(
  runtimeDir: string,
  approval: ModelBOwnerApprovalPackage,
  context: BindingContext
): { workflowPath: string; paymentPath: string } {
  verifyPackage(approval, context);

  const requestId = approval.signedWorkflow.workflow.requestId;

  assert.match(requestId, requestIdPattern);

  const approvalDir = join(runtimeDir, "approvals");
  const journalPath = join(runtimeDir, "journal", `${requestId}.json`);

  const workflowPath = join(approvalDir, `${requestId}.json`);

  const paymentPath = join(approvalDir, `${requestId}.payment.json`);

  assert.ok(
    !existsSync(journalPath),
    "Request ID already exists in payment journal"
  );

  assert.ok(
    !existsSync(workflowPath) && !existsSync(paymentPath),
    "Request already has an approval artifact"
  );

  mkdirSync(approvalDir, {
    recursive: true,
    mode: 0o700,
  });

  writeExclusiveJson(paymentPath, {
    version: 2,
    authorizationModel: "model-b",
    paymentApproval: approval.paymentApproval,
    signatureBase64: approval.signatureBase64,
  });

  writeExclusiveJson(workflowPath, approval.signedWorkflow);

  const fd = openSync(approvalDir, "r");

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  return { workflowPath, paymentPath };
}

/**
 * Load and verify both owner signatures.
 * Never fall back to a Model A approval.
 */
export function loadModelBOwnerApprovalPackage(
  runtimeDir: string,
  requestId: string,
  context: BindingContext
): ModelBOwnerApprovalPackage {
  assert.match(requestId, requestIdPattern);

  const workflow = signedWorkflowV2Schema.parse(
    JSON.parse(
      readFileSync(join(runtimeDir, "approvals", `${requestId}.json`), "utf8")
    )
  );

  const payment = paymentFileSchema.parse(
    JSON.parse(
      readFileSync(
        join(runtimeDir, "approvals", `${requestId}.payment.json`),
        "utf8"
      )
    )
  );

  assert.equal(workflow.workflow.requestId, requestId);
  assert.equal(payment.paymentApproval.requestId, requestId);

  const result: ModelBOwnerApprovalPackage = {
    signedWorkflow: workflow,
    paymentApproval: payment.paymentApproval,
    signatureBase64: payment.signatureBase64,
  };

  verifyPackage(result, context);

  return result;
}
