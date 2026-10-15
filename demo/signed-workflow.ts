import { PublicKey } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { z } from "zod";

import { MAX_PAYMENT_AMOUNT } from "./workflow-policy";

const publicKeySchema = z.string().refine((value) => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}, "Invalid public key");

export const workflowApprovalSchema = z
  .object({
    version: z.literal(1),
    network: z.enum(["localnet", "devnet"]),
    requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/),

    // Bind approval to one chain, program, and Vault.
    genesisHash: publicKeySchema,
    programId: publicKeySchema,
    vault: publicKeySchema,
    owner: publicKeySchema,
    mint: publicKeySchema,

    // Bind approval to one agent and task.
    assignedAgent: z.enum(["agent-a", "agent-b"]),
    agentAuthority: publicKeySchema,
    kind: z.enum(["procurement", "operations"]),
    taskId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),

    // Bind the payment's exact destination and amount.
    recipient: publicKeySchema,
    amountBaseUnits: z.number().int().positive().max(MAX_PAYMENT_AMOUNT),

    expiresAtUnix: z.number().int().positive(),
    description: z.string().min(8).max(300),
  })
  .strict();

export const signedWorkflowSchema = z
  .object({
    workflow: workflowApprovalSchema,
    signature: z.string().min(1),
  })
  .strict();

export type WorkflowApproval = z.infer<typeof workflowApprovalSchema>;

export type SignedWorkflow = z.infer<typeof signedWorkflowSchema>;

export type ApprovalScope = Pick<
  WorkflowApproval,
  "network" | "genesisHash" | "programId" | "vault" | "owner" | "mint"
>;

// IMPORTANT:
// This is our deterministic signature message format.
// Changing the order or representation creates a new
// signing protocol and invalidates existing signatures.
export function encodeWorkflow(input: WorkflowApproval): Uint8Array {
  const w = workflowApprovalSchema.parse(input);

  const fields = [
    "agentvault:owner-approved-workflow:v1",
    w.version,
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

export function verifyWorkflowApproval(
  input: unknown,
  expected: ApprovalScope,
  nowUnix = Math.floor(Date.now() / 1000)
): WorkflowApproval {
  const signed = signedWorkflowSchema.parse(input);
  const workflow = signed.workflow;

  // 1. Verify the signed workflow belongs to our
  // selected chain, deployed program, and treasury.
  const scopeFields = [
    "network",
    "genesisHash",
    "programId",
    "vault",
    "owner",
    "mint",
  ] as const;

  for (const field of scopeFields) {
    if (workflow[field] !== expected[field]) {
      throw new Error(`Approval scope mismatch: ${field}`);
    }
  }

  // 2. Reject expired approvals.
  if (workflow.expiresAtUnix <= nowUnix) {
    throw new Error("Workflow approval expired");
  }

  // 3. Decode and validate signature representation.
  const signature = Buffer.from(signed.signature, "base64");

  if (
    signature.length !== 64 ||
    signature.toString("base64") !== signed.signature
  ) {
    throw new Error("Malformed owner signature");
  }

  // 4. Cryptographically verify the owner's signature.
  const isValid = nacl.sign.detached.verify(
    encodeWorkflow(workflow),
    signature,
    new PublicKey(workflow.owner).toBytes()
  );

  if (!isValid) {
    throw new Error("Invalid owner signature");
  }

  return workflow;
}
