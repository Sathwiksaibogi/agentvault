import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { strict as assert } from "node:assert";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  encodeWorkflow,
  signedWorkflowSchema,
  verifyWorkflowApproval,
  type ApprovalScope,
} from "./signed-workflow";

import {
  validateWorkflowProposal,
  type AiProposal,
  type TrustedWorkflow,
} from "./workflow-policy";

const MAX_RECEIPT_AGE_SECONDS = 3600;
const REQUEST_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

const receiptSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().regex(REQUEST_PATTERN),
    approvalDigest: z.string().regex(/^[0-9a-f]{64}$/),
    issuedAtUnix: z.number().int().positive(),
    expiresAtUnix: z.number().int().positive(),
    proposal: z
      .object({
        decision: z.literal("PAY"),
        amountBaseUnits: z.number().int().positive(),
        reason: z.string().min(1).max(500),
      })
      .strict(),
    macHex: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type AiDecisionReceipt = z.infer<typeof receiptSchema>;
type ReceiptBody = Omit<AiDecisionReceipt, "macHex">;

function secretKey(hex: string): Buffer {
  assert.match(
    hex,
    /^[a-fA-F0-9]{64}$/,
    "AGENTVAULT_DECISION_HMAC_KEY must be 32 random bytes in hex"
  );

  return Buffer.from(hex, "hex");
}

function receiptMac(body: ReceiptBody, key: Buffer): string {
  const message = JSON.stringify([
    "agentvault:ai-decision-receipt:v1",
    body.version,
    body.requestId,
    body.approvalDigest,
    body.issuedAtUnix,
    body.expiresAtUnix,
    body.proposal.decision,
    body.proposal.amountBaseUnits,
    body.proposal.reason,
  ]);

  return createHmac("sha256", key).update(message).digest("hex");
}

function approvalContext(
  signedInput: unknown,
  scope: ApprovalScope,
  nowUnix: number
) {
  assert.ok(Number.isSafeInteger(nowUnix) && nowUnix > 0);

  const signed = signedWorkflowSchema.parse(signedInput);

  // Authenticate the owner and the network/program/vault scope.
  const workflow = verifyWorkflowApproval(signed, scope, nowUnix);

  assert.match(workflow.requestId, REQUEST_PATTERN);

  const approvalDigest = createHash("sha256")
    .update(encodeWorkflow(workflow))
    .update(Buffer.from(signed.signature, "base64"))
    .digest("hex");

  const trusted: TrustedWorkflow = {
    requestId: workflow.requestId,
    assignedAgent: workflow.assignedAgent,
    kind: workflow.kind,
    taskId: workflow.taskId,
    amountBaseUnits: workflow.amountBaseUnits,
    description: workflow.description,
  };

  return { workflow, approvalDigest, trusted };
}

function receiptPath(runtimeDir: string, requestId: string) {
  assert.match(requestId, REQUEST_PATTERN);

  return join(runtimeDir, "ai-decisions", `${requestId}.json`);
}

export function saveAiDecisionReceipt(
  runtimeDir: string,
  signedApproval: unknown,
  scope: ApprovalScope,
  proposal: AiProposal,
  keyHex: string,
  nowUnix: number
) {
  const key = secretKey(keyHex);

  const { workflow, approvalDigest, trusted } = approvalContext(
    signedApproval,
    scope,
    nowUnix
  );

  // Never save an unauthorized or rejected proposal
  // as a payment authorization.
  const result = validateWorkflowProposal(
    trusted,
    workflow.assignedAgent,
    proposal
  );

  assert.ok(
    result.approved === true,
    "Cannot save a rejected AI payment proposal"
  );

  assert.equal(proposal.decision, "PAY");

  const body: ReceiptBody = {
    version: 1,
    requestId: workflow.requestId,
    approvalDigest,
    issuedAtUnix: nowUnix,
    expiresAtUnix: Math.min(
      nowUnix + MAX_RECEIPT_AGE_SECONDS,
      workflow.expiresAtUnix
    ),
    proposal: {
      decision: "PAY",
      amountBaseUnits: proposal.amountBaseUnits,
      reason: proposal.reason,
    },
  };

  assert.ok(body.expiresAtUnix > nowUnix, "Approval already expired");

  const receipt = receiptSchema.parse({
    ...body,
    macHex: receiptMac(body, key),
  });

  const dir = join(runtimeDir, "ai-decisions");

  mkdirSync(dir, {
    recursive: true,
    mode: 0o700,
  });

  const path = receiptPath(runtimeDir, workflow.requestId);

  // Exclusive creation prevents silent replacement.
  const fd = openSync(path, "wx", 0o600);

  try {
    writeFileSync(fd, JSON.stringify(receipt, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // Flush the new directory entry on Linux.
  const directoryFd = openSync(dir, "r");

  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }

  return { path, receipt };
}

export function loadAiDecisionReceipt(
  runtimeDir: string,
  signedApproval: unknown,
  scope: ApprovalScope,
  keyHex: string,
  nowUnix: number
): AiProposal {
  const key = secretKey(keyHex);

  const { workflow, approvalDigest, trusted } = approvalContext(
    signedApproval,
    scope,
    nowUnix
  );

  const path = receiptPath(runtimeDir, workflow.requestId);

  const receipt = receiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));

  const { macHex, ...body } = receipt;

  const expectedMac = Buffer.from(receiptMac(body, key), "hex");

  const suppliedMac = Buffer.from(macHex, "hex");

  assert.ok(
    timingSafeEqual(suppliedMac, expectedMac),
    "AI decision receipt MAC mismatch"
  );

  assert.equal(
    receipt.requestId,
    workflow.requestId,
    "AI decision request mismatch"
  );

  assert.equal(
    receipt.approvalDigest,
    approvalDigest,
    "AI decision belongs to a different owner approval"
  );

  assert.ok(
    receipt.issuedAtUnix <= nowUnix,
    "AI decision receipt issued in the future"
  );

  assert.ok(receipt.expiresAtUnix > nowUnix, "AI decision receipt expired");

  assert.ok(
    receipt.expiresAtUnix <= receipt.issuedAtUnix + MAX_RECEIPT_AGE_SECONDS,
    "AI decision receipt exceeds maximum lifetime"
  );

  assert.ok(
    receipt.expiresAtUnix <= workflow.expiresAtUnix,
    "AI decision receipt outlives owner approval"
  );

  // Revalidate the proposal against the authenticated workflow.
  const result = validateWorkflowProposal(
    trusted,
    workflow.assignedAgent,
    receipt.proposal
  );

  assert.ok(
    result.approved === true,
    "Cached AI proposal failed policy validation"
  );

  return receipt.proposal;
}
