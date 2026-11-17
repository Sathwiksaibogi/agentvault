import { PublicKey } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { z } from "zod";

import {
  workflowApprovalSchema,
  verifyWorkflowApproval,
  type ApprovalScope,
  type WorkflowApproval,
} from "./signed-workflow";

/**
 * Separate owner-signed workflow protocol for Model B.
 *
 * V1 remains unchanged and is exclusively Model A.
 * V2 explicitly authenticates authorizationModel.
 */
export const workflowApprovalV2Schema = workflowApprovalSchema
  .omit({ version: true })
  .extend({
    version: z.literal(2),
    authorizationModel: z.literal("model-b"),
    expiresAtUnix: z
      .number()
      .int()
      .positive()
      .refine(Number.isSafeInteger, "Unsafe workflow expiry"),
  })
  .strict();

export const signedWorkflowV2Schema = z
  .object({
    workflow: workflowApprovalV2Schema,
    signature: z.string().min(1),
  })
  .strict();

export type WorkflowApprovalV2 = z.infer<typeof workflowApprovalV2Schema>;

export type SignedWorkflowV2 = z.infer<typeof signedWorkflowV2Schema>;

export type VerifiedWorkflowRoute =
  | {
      authorizationModel: "model-a";
      workflow: WorkflowApproval;
    }
  | {
      authorizationModel: "model-b";
      workflow: WorkflowApprovalV2;
    };

/**
 * Deterministic v2 signing message.
 *
 * Do not reuse the v1 domain or change field ordering.
 * This signature is distinct from PaymentApprovalV2.
 */
export function encodeWorkflowV2(input: unknown): Buffer {
  const w = workflowApprovalV2Schema.parse(input);

  const fields = [
    "agentvault:owner-approved-workflow:v2",
    w.version,
    w.authorizationModel,
    w.network,
    w.requestId,
    w.genesisHash,
    w.programId,
    w.vault,
    w.owner,
    w.mint,
    w.assignedAgent,
    w.agentAuthority,
    w.kind,
    w.taskId,
    w.recipient,
    w.amountBaseUnits,
    w.expiresAtUnix,
    w.description,
  ];

  return Buffer.from(JSON.stringify(fields), "utf8");
}

/**
 * Verifies a Model B workflow signed by its Vault owner.
 *
 * The mode is included in the Ed25519 signature message.
 * Changing model-b to model-a invalidates the approval.
 */
export function verifyWorkflowApprovalV2(
  input: unknown,
  expected: ApprovalScope,
  nowUnix = Math.floor(Date.now() / 1000)
): WorkflowApprovalV2 {
  const signed = signedWorkflowV2Schema.parse(input);
  const workflow = signed.workflow;

  if (!Number.isSafeInteger(nowUnix) || nowUnix < 0) {
    throw new Error("Invalid workflow verification time");
  }

  const fields = [
    "network",
    "genesisHash",
    "programId",
    "vault",
    "owner",
    "mint",
  ] as const;

  for (const field of fields) {
    if (workflow[field] !== expected[field]) {
      throw new Error(`Workflow v2 scope mismatch: ${field}`);
    }
  }

  if (workflow.expiresAtUnix <= nowUnix) {
    throw new Error("Workflow v2 approval expired");
  }

  const signature = Buffer.from(signed.signature, "base64");

  if (
    signature.length !== nacl.sign.signatureLength ||
    signature.toString("base64") !== signed.signature
  ) {
    throw new Error("Malformed workflow v2 owner signature");
  }

  const valid = nacl.sign.detached.verify(
    encodeWorkflowV2(workflow),
    signature,
    new PublicKey(workflow.owner).toBytes()
  );

  if (!valid) {
    throw new Error("Invalid workflow v2 owner signature");
  }

  return workflow;
}

/**
 * Select the authorization path only AFTER verifying
 * the exact owner-signed workflow version.
 *
 * V1 => Model A only.
 * V2 => Model B only.
 * Unknown versions => reject.
 */
export function verifySignedWorkflowRoute(
  input: unknown,
  scope: ApprovalScope,
  nowUnix = Math.floor(Date.now() / 1000)
): VerifiedWorkflowRoute {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid signed workflow envelope");
  }

  const envelope = input as { workflow?: unknown };

  if (
    envelope.workflow === null ||
    typeof envelope.workflow !== "object" ||
    Array.isArray(envelope.workflow)
  ) {
    throw new Error("Invalid signed workflow payload");
  }

  const version = (envelope.workflow as Record<string, unknown>).version;

  if (version === 1) {
    return {
      authorizationModel: "model-a",
      workflow: verifyWorkflowApproval(input, scope, nowUnix),
    };
  }

  if (version === 2) {
    return {
      authorizationModel: "model-b",
      workflow: verifyWorkflowApprovalV2(input, scope, nowUnix),
    };
  }

  throw new Error("Unsupported owner-signed workflow version");
}
