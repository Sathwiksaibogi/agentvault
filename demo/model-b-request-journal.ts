import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";

import { computeModelBWorkflowDigest } from "./model-b-workflow-digest";
import {
  buildBoundModelBOwnerInstruction,
  type ModelBWorkflowBinding,
} from "./model-b-workflow-binding";
import {
  encodePaymentApprovalV2,
  paymentApprovalV2Schema,
} from "./payment-approval-v2";
import type { ApprovalScope } from "./signed-workflow";
import { signedWorkflowV2Schema } from "./signed-workflow-v2";

/** Model B claims live at the SAME request-id path as Model A claims. */
export type ModelBJournalRecord = {
  version: 2;
  authorizationModel: "model-b";
  status: "claimed";
  requestId: string;
  network: string;
  genesisHash: string;
  programId: string;
  vault: string;
  owner: string;
  mint: string;
  agent: string;
  agentAuthority: string;
  agentPda: string;
  taskPda: string;
  recipient: string;
  amountBaseUnits: number;
  nonce: string;
  approvalExpiresAtUnix: string;
  taskExpiresAtUnix: string;
  workflowApprovalDigest: string;
  paymentApprovalDigest: string;
  claimedAt: string;
};

/** Domain-separated SHA-256 of the exact v2 binary message AND signature. */
export function computeModelBPaymentApprovalDigest(
  approvalInput: unknown,
  signatureBase64: string
): string {
  const signature = Buffer.from(signatureBase64, "base64");
  assert.ok(
    signature.length === 64 && signature.toString("base64") === signatureBase64,
    "Malformed Model B owner signature encoding"
  );

  return createHash("sha256")
    .update("agentvault:model-b-approval-digest:v1\0", "utf8")
    .update(encodePaymentApprovalV2(approvalInput))
    .update(signature)
    .digest("hex");
}

/** Claim ONLY after both owner approvals and live task context match. */
export function claimModelBWorkflow(
  runtimeDir: string,
  binding: ModelBWorkflowBinding
): { path: string; record: ModelBJournalRecord } {
  // Verify workflow v2, payment v2, PDAs, nonce and expiry FIRST.
  buildBoundModelBOwnerInstruction(binding);

  const signed = signedWorkflowV2Schema.parse(binding.signedWorkflow);
  const workflow = signed.workflow;
  const approval = paymentApprovalV2Schema.parse(binding.paymentApproval);

  const record: ModelBJournalRecord = {
    version: 2,
    authorizationModel: "model-b",
    status: "claimed",
    requestId: workflow.requestId,
    network: workflow.network,
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
    agent: workflow.assignedAgent,
    agentAuthority: workflow.agentAuthority,
    agentPda: binding.agentPda.toBase58(),
    taskPda: binding.approvedTaskPda.toBase58(),
    recipient: workflow.recipient,
    amountBaseUnits: workflow.amountBaseUnits,
    nonce: approval.nonce,
    approvalExpiresAtUnix: approval.expiresAtUnix,
    taskExpiresAtUnix: binding.taskExpiresAtUnix,
    workflowApprovalDigest: computeModelBWorkflowDigest(signed),
    paymentApprovalDigest: computeModelBPaymentApprovalDigest(
      approval,
      binding.signatureBase64
    ),
    claimedAt: new Date(binding.nowUnix * 1000).toISOString(),
  };

  const journalDir = join(runtimeDir, "journal");
  mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  const path = join(journalDir, `${workflow.requestId}.json`);

  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Request ${workflow.requestId} already claimed`);
    }
    throw error;
  }

  try {
    writeFileSync(fd, JSON.stringify(record, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  const directoryFd = openSync(journalDir, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
  return { path, record };
}

/**
 * Recovery-side verification uses the RECORDED claim time, not live nonce
 * or current task expiry. It never authorizes a new transaction.
 */
export function verifyModelBJournalClaim(
  runtimeDir: string,
  requestId: string,
  signedWorkflowInput: unknown,
  paymentApprovalInput: unknown,
  signatureBase64: string,
  scope: ApprovalScope
): ModelBJournalRecord {
  assert.match(requestId, /^[a-zA-Z0-9_-]{8,64}$/);

  const record = JSON.parse(
    readFileSync(join(runtimeDir, "journal", `${requestId}.json`), "utf8")
  ) as ModelBJournalRecord;

  assert.equal(record.version, 2, "Expected a Model B v2 claim");
  assert.equal(record.authorizationModel, "model-b");
  assert.equal(record.status, "claimed");
  assert.equal(record.requestId, requestId);

  const claimMillis = Date.parse(record.claimedAt);
  assert.ok(
    Number.isSafeInteger(claimMillis) &&
      claimMillis > 0 &&
      claimMillis % 1000 === 0,
    "Invalid Model B historical claim time"
  );
  const claimUnix = claimMillis / 1000;

  const signed = signedWorkflowV2Schema.parse(signedWorkflowInput);
  const workflow = signed.workflow;
  const approval = paymentApprovalV2Schema.parse(paymentApprovalInput);

  assert.equal(
    computeModelBWorkflowDigest(signed),
    record.workflowApprovalDigest,
    "Model B workflow approval digest mismatch"
  );
  assert.equal(
    computeModelBPaymentApprovalDigest(approval, signatureBase64),
    record.paymentApprovalDigest,
    "Model B payment approval digest mismatch"
  );

  // Reuse both v2 signature and binding checks at the original claim time.
  // Do not compare to the current on-chain nonce: a confirmed payment advances it.
  buildBoundModelBOwnerInstruction({
    signedWorkflow: signed,
    paymentApproval: approval,
    signatureBase64,
    scope,
    agentPda: new PublicKey(record.agentPda),
    approvedTaskPda: new PublicKey(record.taskPda),
    nextNonce: record.nonce,
    taskExpiresAtUnix: record.taskExpiresAtUnix,
    nowUnix: claimUnix,
  });

  const fields = {
    requestId: workflow.requestId,
    network: workflow.network,
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
    agent: workflow.assignedAgent,
    agentAuthority: workflow.agentAuthority,
    agentPda: approval.agent,
    taskPda: approval.task,
    recipient: workflow.recipient,
    amountBaseUnits: workflow.amountBaseUnits,
    nonce: approval.nonce,
    approvalExpiresAtUnix: approval.expiresAtUnix,
  };

  for (const field of Object.keys(fields) as (keyof typeof fields)[]) {
    assert.equal(
      record[field],
      fields[field],
      `Model B journal ${field} mismatch`
    );
  }

  return record;
}
