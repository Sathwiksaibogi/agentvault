import { PublicKey, type TransactionInstruction } from "@solana/web3.js";

import { paymentApprovalV2Schema } from "./payment-approval-v2";

import { verifyWorkflowApproval, type ApprovalScope } from "./signed-workflow";

import { buildModelBOwnerVerificationInstruction } from "./model-b-ed25519";

export type ModelBWorkflowBinding = {
  signedWorkflow: unknown;
  paymentApproval: unknown;
  signatureBase64: string;
  scope: ApprovalScope;

  agentPda: PublicKey;
  approvedTaskPda: PublicKey;

  nextNonce: string;
  taskExpiresAtUnix: string;
  nowUnix: number;
};

export function buildBoundModelBOwnerInstruction(
  input: ModelBWorkflowBinding
): TransactionInstruction {
  // Verify the existing v1 workflow signature first.
  const workflow = verifyWorkflowApproval(
    input.signedWorkflow,
    input.scope,
    input.nowUnix
  );

  const approval = paymentApprovalV2Schema.parse(input.paymentApproval);

  const programId = new PublicKey(workflow.programId);
  const vault = new PublicKey(workflow.vault);
  const authority = new PublicKey(workflow.agentAuthority);

  // Derive the expected agent PDA from signed v1 fields.
  const [expectedAgent] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), authority.toBuffer()],
    programId
  );

  if (!expectedAgent.equals(input.agentPda)) {
    throw new Error("Model B agent PDA mismatch");
  }

  // Critically, use the Model B seed, never "task".
  const taskIdBytes = Buffer.alloc(8);
  taskIdBytes.writeBigUInt64LE(BigInt(workflow.taskId));

  const [expectedTask] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), input.agentPda.toBuffer(), taskIdBytes],
    programId
  );

  if (!expectedTask.equals(input.approvedTaskPda)) {
    throw new Error("Model B approved-task PDA mismatch");
  }

  if (
    !/^(0|[1-9][0-9]*)$/.test(input.nextNonce) ||
    BigInt(input.nextNonce) > BigInt("18446744073709551615")
  ) {
    throw new Error("Invalid on-chain Model B nonce");
  }

  const expectedFields = {
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
    agent: input.agentPda.toBase58(),
    agentAuthority: workflow.agentAuthority,
    task: input.approvedTaskPda.toBase58(),
    recipient: workflow.recipient,
    amountBaseUnits: String(workflow.amountBaseUnits),
    nonce: input.nextNonce,
    requestId: workflow.requestId,
  };

  for (const field of Object.keys(
    expectedFields
  ) as (keyof typeof expectedFields)[]) {
    if (approval[field] !== expectedFields[field]) {
      throw new Error(`Model B binding mismatch: ${field}`);
    }
  }

  if (
    !Number.isSafeInteger(input.nowUnix) ||
    !/^[0-9]+$/.test(input.taskExpiresAtUnix)
  ) {
    throw new Error("Invalid Model B time context");
  }

  const expiresAt = BigInt(approval.expiresAtUnix);
  const now = BigInt(input.nowUnix);

  if (
    expiresAt <= now ||
    expiresAt > BigInt(workflow.expiresAtUnix) ||
    expiresAt > BigInt(input.taskExpiresAtUnix)
  ) {
    throw new Error("Model B approval expiry invalid");
  }

  // Reject noncanonical base64 before using the bridge.
  if (typeof input.signatureBase64 !== "string") {
    throw new Error("Malformed Model B signature");
  }

  const signature = Buffer.from(input.signatureBase64, "base64");

  if (
    signature.length !== 64 ||
    signature.toString("base64") !== input.signatureBase64
  ) {
    throw new Error("Malformed Model B signature");
  }

  // The existing bridge cryptographically verifies
  // the exact owner signature and creates the native
  // Ed25519 verification instruction.
  return buildModelBOwnerVerificationInstruction(approval, signature);
}
