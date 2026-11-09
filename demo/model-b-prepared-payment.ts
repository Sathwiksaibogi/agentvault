import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { PublicKey, Transaction } from "@solana/web3.js";

import type { PaymentApprovalV2 } from "./payment-approval-v2";
import type { ApprovalScope } from "./signed-workflow";
import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";

import {
  verifyModelBJournalClaim,
  type ModelBJournalRecord,
} from "./model-b-request-journal";

import {
  assertExactModelBPayment,
  assertSerializedModelBPayment,
} from "./model-b-transaction-guard";

export type PreparedModelBPaymentRecord = {
  version: 2;
  authorizationModel: "model-b";
  status: "prepared";
  requestId: string;
  network: string;
  workflowApprovalDigest: string;
  paymentApprovalDigest: string;
  agentAuthority: string;
  taskPda: string;
  amountBaseUnits: number;
  nonce: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  transactionSignatureBase64: string;
  rawTransactionBase64: string;
  transactionSha256: string;
};

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function readModelBClaim(
  runtimeDir: string,
  requestId: string
): ModelBJournalRecord {
  assert.match(requestId, REQUEST_ID_PATTERN);

  const claim = JSON.parse(
    readFileSync(join(runtimeDir, "journal", `${requestId}.json`), "utf8")
  ) as ModelBJournalRecord;

  assert.equal(claim.version, 2, "Expected Model B journal");
  assert.equal(claim.authorizationModel, "model-b");
  assert.equal(claim.status, "claimed");
  assert.equal(claim.requestId, requestId);

  return claim;
}

function approvalFromClaim(claim: ModelBJournalRecord): PaymentApprovalV2 {
  return {
    version: 2,
    genesisHash: claim.genesisHash,
    programId: claim.programId,
    vault: claim.vault,
    owner: claim.owner,
    mint: claim.mint,
    agent: claim.agentPda,
    agentAuthority: claim.agentAuthority,
    task: claim.taskPda,
    recipient: claim.recipient,
    amountBaseUnits: String(claim.amountBaseUnits),
    nonce: claim.nonce,
    expiresAtUnix: claim.approvalExpiresAtUnix,
    requestId: claim.requestId,
  };
}

function assertRecordMatchesClaim(
  record: PreparedModelBPaymentRecord,
  claim: ModelBJournalRecord
): void {
  assert.equal(record.version, 2);
  assert.equal(record.authorizationModel, "model-b");
  assert.equal(record.status, "prepared");

  assert.equal(record.requestId, claim.requestId);
  assert.equal(record.network, claim.network);
  assert.equal(record.workflowApprovalDigest, claim.workflowApprovalDigest);
  assert.equal(record.paymentApprovalDigest, claim.paymentApprovalDigest);

  assert.equal(record.agentAuthority, claim.agentAuthority);
  assert.equal(record.taskPda, claim.taskPda);
  assert.equal(record.amountBaseUnits, claim.amountBaseUnits);
  assert.equal(record.nonce, claim.nonce);

  assert.ok(
    Number.isSafeInteger(record.lastValidBlockHeight) &&
      record.lastValidBlockHeight > 0,
    "Invalid last valid block height"
  );
}

/**
 * Persist only a fully verified, agent-signed Model B
 * transaction. Requires an existing v2 journal claim.
 */
export function prepareSignedModelBPayment(
  runtimeDir: string,
  binding: ModelBWorkflowBinding,
  lastValidBlockHeight: number,
  transaction: Transaction
): { path: string; record: PreparedModelBPaymentRecord } {
  const workflow = (
    binding.signedWorkflow as {
      workflow: { requestId: string };
    }
  ).workflow;

  const requestId = workflow.requestId;

  const claim = verifyModelBJournalClaim(
    runtimeDir,
    requestId,
    binding.signedWorkflow,
    binding.paymentApproval,
    binding.signatureBase64,
    binding.scope
  );

  assert.ok(
    Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0,
    "Invalid blockhash validity height"
  );

  assert.ok(transaction.recentBlockhash, "Missing blockhash");

  // Validate the exact three-instruction transaction.
  // The payment instruction cannot authorize arbitrary
  // data: the guard separately checks its discriminator,
  // account metas, and canonical signed payment fields.
  assertExactModelBPayment(transaction, {
    binding,
    paymentInstruction: transaction.instructions[2],
  });

  const raw = transaction.serialize({
    requireAllSignatures: true,
    verifySignatures: true,
  });

  assert.ok(transaction.signature);

  const record: PreparedModelBPaymentRecord = {
    version: 2,
    authorizationModel: "model-b",
    status: "prepared",
    requestId,
    network: claim.network,
    workflowApprovalDigest: claim.workflowApprovalDigest,
    paymentApprovalDigest: claim.paymentApprovalDigest,
    agentAuthority: claim.agentAuthority,
    taskPda: claim.taskPda,
    amountBaseUnits: claim.amountBaseUnits,
    nonce: claim.nonce,
    recentBlockhash: transaction.recentBlockhash,
    lastValidBlockHeight,
    transactionSignatureBase64: Buffer.from(transaction.signature).toString(
      "base64"
    ),
    rawTransactionBase64: raw.toString("base64"),
    transactionSha256: sha256(raw),
  };

  const journalDir = join(runtimeDir, "journal");
  const path = join(journalDir, `${requestId}.signed.json`);

  // Same namespace as Model A. Never overwrite a
  // previously prepared transaction for this request.
  const fd = openSync(path, "wx", 0o600);

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
 * Read-only restoration of EXACT signed bytes.
 *
 * The owner signature is recovered from the existing
 * Ed25519 instruction, not regenerated or replaced.
 */
export function loadPreparedModelBPayment(
  runtimeDir: string,
  requestId: string,
  signedWorkflow: unknown,
  scope: ApprovalScope
): {
  record: PreparedModelBPaymentRecord;
  transaction: Transaction;
  raw: Buffer;
} {
  const claim = readModelBClaim(runtimeDir, requestId);

  const record = JSON.parse(
    readFileSync(
      join(runtimeDir, "journal", `${requestId}.signed.json`),
      "utf8"
    )
  ) as PreparedModelBPaymentRecord;

  assertRecordMatchesClaim(record, claim);

  const raw = Buffer.from(record.rawTransactionBase64, "base64");

  assert.equal(
    raw.toString("base64"),
    record.rawTransactionBase64,
    "Malformed serialized Model B transaction"
  );

  assert.equal(
    sha256(raw),
    record.transactionSha256,
    "Stored Model B transaction digest mismatch"
  );

  const transaction = Transaction.from(raw);

  assert.equal(transaction.instructions.length, 3);

  // Canonical Ed25519 instruction data:
  // signature occupies bytes [48, 112).
  const ed25519Data = transaction.instructions[1].data;

  assert.ok(
    ed25519Data.length >= 112,
    "Malformed saved Model B Ed25519 instruction"
  );

  const ownerSignatureBase64 = Buffer.from(
    ed25519Data.subarray(48, 112)
  ).toString("base64");

  const paymentApproval = approvalFromClaim(claim);

  // Cryptographically verify BOTH original owner
  // signatures against the historical journal claim.
  verifyModelBJournalClaim(
    runtimeDir,
    requestId,
    signedWorkflow,
    paymentApproval,
    ownerSignatureBase64,
    scope
  );

  const claimUnix = Date.parse(claim.claimedAt) / 1000;

  const binding: ModelBWorkflowBinding = {
    signedWorkflow,
    paymentApproval,
    signatureBase64: ownerSignatureBase64,
    scope,
    agentPda: new PublicKey(claim.agentPda),
    approvedTaskPda: new PublicKey(claim.taskPda),
    nextNonce: claim.nonce,
    taskExpiresAtUnix: claim.taskExpiresAtUnix,
    nowUnix: claimUnix,
  };

  // Reconstruct the canonical message and compare the
  // COMPLETE message signed by the agent.
  assertSerializedModelBPayment(transaction, {
    binding,
    paymentInstruction: transaction.instructions[2],
  });

  assert.equal(transaction.recentBlockhash, record.recentBlockhash);

  assert.ok(transaction.signature);

  assert.equal(
    Buffer.from(transaction.signature).toString("base64"),
    record.transactionSignatureBase64,
    "Stored Model B agent signature mismatch"
  );

  return { record, transaction, raw };
}
