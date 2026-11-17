import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
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
import { z } from "zod";

import type { AiProposal } from "./workflow-policy";
import { validateWorkflowProposal } from "./workflow-policy";
import { signedWorkflowV2Schema } from "./signed-workflow-v2";
import { paymentApprovalV2Schema } from "./payment-approval-v2";
import {
  buildBoundModelBOwnerInstruction,
  type ModelBWorkflowBinding,
} from "./model-b-workflow-binding";
import { computeModelBWorkflowDigest } from "./model-b-workflow-digest";
import { computeModelBPaymentApprovalDigest } from "./model-b-request-journal";

const RECEIPT_TTL_SECONDS = 900;
const DOMAIN = "agentvault:model-b-ai-decision:v1";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const proposalSchema = z
  .object({
    decision: z.literal("PAY"),
    amountBaseUnits: z.number().int().positive(),
    reason: z.string().min(1).max(500),
  })
  .strict();

const receiptPayloadSchema = z
  .object({
    version: z.literal(2),
    authorizationModel: z.literal("model-b"),
    requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/),
    workflowApprovalDigest: digestSchema,
    paymentApprovalDigest: digestSchema,
    proposal: proposalSchema,
    createdAtUnix: z.number().int().nonnegative(),
    expiresAtUnix: z.number().int().positive(),
  })
  .strict();

const receiptSchema = receiptPayloadSchema
  .extend({
    mac: digestSchema,
  })
  .strict();

type ReceiptPayload = z.infer<typeof receiptPayloadSchema>;

type ModelBAiContext = {
  requestId: string;
  workflowApprovalDigest: string;
  paymentApprovalDigest: string;
  amountBaseUnits: number;
  expiresAtUnix: number;
};

function validateHmacKey(keyHex: string): Buffer {
  assert.ok(
    typeof keyHex === "string" && /^[0-9a-f]{64}$/i.test(keyHex),
    "Model B AI HMAC key must be 32 random bytes in hex"
  );

  return Buffer.from(keyHex, "hex");
}

function receiptMac(value: ReceiptPayload, key: Buffer): string {
  // Fixed field order prevents ambiguity from JSON
  // property ordering or object serialization.
  const message = JSON.stringify([
    DOMAIN,
    value.version,
    value.authorizationModel,
    value.requestId,
    value.workflowApprovalDigest,
    value.paymentApprovalDigest,
    value.proposal.decision,
    value.proposal.amountBaseUnits,
    value.proposal.reason,
    value.createdAtUnix,
    value.expiresAtUnix,
  ]);

  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

function validateProposal(
  workflow: z.infer<typeof signedWorkflowV2Schema>["workflow"],
  proposalInput: unknown
): z.infer<typeof proposalSchema> {
  const proposal = proposalSchema.parse(proposalInput);

  const result = validateWorkflowProposal(
    {
      requestId: workflow.requestId,
      assignedAgent: workflow.assignedAgent,
      kind: workflow.kind,
      taskId: workflow.taskId,
      amountBaseUnits: workflow.amountBaseUnits,
      description: workflow.description,
    },
    workflow.assignedAgent,
    proposal
  );

  if (result.approved === false) {
    throw new Error(`Model B AI policy rejected: ${result.code}`);
  }

  return proposal;
}

function authenticateContext(binding: ModelBWorkflowBinding): ModelBAiContext {
  // Cryptographically validate both owner signatures,
  // the explicit Model B route, PDAs, amount and nonce.
  buildBoundModelBOwnerInstruction(binding);

  const signed = signedWorkflowV2Schema.parse(binding.signedWorkflow);

  const payment = paymentApprovalV2Schema.parse(binding.paymentApproval);

  const expiresAtUnix = Math.min(
    binding.nowUnix + RECEIPT_TTL_SECONDS,
    signed.workflow.expiresAtUnix,
    Number(payment.expiresAtUnix)
  );

  assert.ok(
    Number.isSafeInteger(binding.nowUnix) &&
      Number.isSafeInteger(expiresAtUnix) &&
      expiresAtUnix > binding.nowUnix,
    "Invalid Model B AI decision expiry"
  );

  return {
    requestId: signed.workflow.requestId,
    workflowApprovalDigest: computeModelBWorkflowDigest(signed),
    paymentApprovalDigest: computeModelBPaymentApprovalDigest(
      payment,
      binding.signatureBase64
    ),
    amountBaseUnits: signed.workflow.amountBaseUnits,
    expiresAtUnix,
  };
}

function receiptPath(runtimeDir: string, requestId: string): string {
  return join(runtimeDir, "ai-decisions", `${requestId}.model-b.json`);
}

function assertNoCrossModelOrClaim(
  runtimeDir: string,
  requestId: string
): void {
  assert.ok(
    !existsSync(join(runtimeDir, "ai-decisions", `${requestId}.json`)),
    "Model A AI receipt already uses this request ID"
  );

  assert.ok(
    !existsSync(join(runtimeDir, "journal", `${requestId}.json`)),
    "Request already claimed; use payment recovery"
  );
}

function loadReceipt(
  path: string,
  context: ModelBAiContext,
  binding: ModelBWorkflowBinding,
  key: Buffer
): AiProposal {
  const stored = receiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));

  const { mac, ...payload } = stored;

  const expectedMac = Buffer.from(receiptMac(payload, key), "hex");

  const actualMac = Buffer.from(mac, "hex");

  assert.ok(
    timingSafeEqual(actualMac, expectedMac),
    "Model B AI receipt MAC mismatch"
  );

  assert.equal(
    stored.requestId,
    context.requestId,
    "Model B AI receipt request mismatch"
  );

  assert.equal(
    stored.workflowApprovalDigest,
    context.workflowApprovalDigest,
    "Model B AI workflow digest mismatch"
  );

  assert.equal(
    stored.paymentApprovalDigest,
    context.paymentApprovalDigest,
    "Model B AI payment digest mismatch"
  );

  assert.ok(
    stored.createdAtUnix <= binding.nowUnix,
    "Model B AI receipt created in the future"
  );

  assert.ok(
    stored.expiresAtUnix > binding.nowUnix,
    "Model B AI receipt expired"
  );

  assert.ok(
    stored.expiresAtUnix <= stored.createdAtUnix + RECEIPT_TTL_SECONDS,
    "Model B AI receipt validity too long"
  );

  assert.ok(
    stored.expiresAtUnix <= context.expiresAtUnix,
    "Model B AI receipt outlives owner approval"
  );

  const workflow = signedWorkflowV2Schema.parse(
    binding.signedWorkflow
  ).workflow;

  return validateProposal(workflow, stored.proposal);
}

function saveReceipt(
  runtimeDir: string,
  binding: ModelBWorkflowBinding,
  context: ModelBAiContext,
  key: Buffer,
  proposalInput: unknown
): AiProposal {
  const workflow = signedWorkflowV2Schema.parse(
    binding.signedWorkflow
  ).workflow;

  const proposal = validateProposal(workflow, proposalInput);

  const payload = receiptPayloadSchema.parse({
    version: 2,
    authorizationModel: "model-b",
    requestId: context.requestId,
    workflowApprovalDigest: context.workflowApprovalDigest,
    paymentApprovalDigest: context.paymentApprovalDigest,
    proposal,
    createdAtUnix: binding.nowUnix,
    expiresAtUnix: context.expiresAtUnix,
  });

  const record = {
    ...payload,
    mac: receiptMac(payload, key),
  };

  assertNoCrossModelOrClaim(runtimeDir, context.requestId);

  const directory = join(runtimeDir, "ai-decisions");

  mkdirSync(directory, {
    recursive: true,
    mode: 0o700,
  });

  const fd = openSync(receiptPath(runtimeDir, context.requestId), "wx", 0o600);

  try {
    writeFileSync(fd, JSON.stringify(record, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  const directoryFd = openSync(directory, "r");

  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }

  return proposal;
}

/**
 * Model B only. Never reads or writes Model A receipts.
 *
 * The binding must contain fresh, trusted on-chain
 * context provided by the caller.
 */
export async function resolveModelBAiDecision(
  runtimeDir: string,
  binding: ModelBWorkflowBinding,
  keyHex: string,
  evaluateWithGemini: () => Promise<AiProposal>
): Promise<{
  proposal: AiProposal;
  source: "cache" | "gemini";
}> {
  const key = validateHmacKey(keyHex);
  const context = authenticateContext(binding);

  assertNoCrossModelOrClaim(runtimeDir, context.requestId);

  const path = receiptPath(runtimeDir, context.requestId);

  if (existsSync(path)) {
    // Invalid receipts stop execution. Never silently
    // regenerate an AI decision after a cache error.
    return {
      proposal: loadReceipt(path, context, binding, key),
      source: "cache",
    };
  }

  const proposal = await evaluateWithGemini();

  const saved = saveReceipt(runtimeDir, binding, context, key, proposal);

  return {
    proposal: saved,
    source: "gemini",
  };
}
