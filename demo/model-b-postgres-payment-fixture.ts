/** Test-only authentic Model B payment fixture (never imported by live runtime). */
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as nacl from "tweetnacl";

import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import { buildUnsignedModelBPayment } from "./model-b-payment-builder";
import {
  encodeWorkflowV2,
  type WorkflowApprovalV2,
} from "./signed-workflow-v2";
import {
  encodePaymentApprovalV2,
  type PaymentApprovalV2,
} from "./payment-approval-v2";
import { computeModelBWorkflowDigest } from "./model-b-workflow-digest";
import { computeModelBPaymentApprovalDigest } from "./model-b-request-journal";
import type {
  ClaimModelBPayment,
  ModelBPaymentRecord,
  AuthorizedSignedModelBPayment,
} from "./model-b-postgres-payment-store";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function signatureBase58(bytes: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let value = "";
  while (n > BigInt(0)) {
    value = BASE58[Number(n % BigInt(58))] + value;
    n /= BigInt(58);
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    value = "1" + value;
  }
  return value || "1";
}

export function makeModelBPostgresFixture(
  requestId = "modelb-authentic-001",
  nowUnix = Math.floor(Date.now() / 1000)
) {
  const owner = Keypair.generate();
  const agentSigner = Keypair.generate();
  const vault = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const genesisHash = Keypair.generate().publicKey;
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), agentSigner.publicKey.toBuffer()],
    AGENTVAULT_PROGRAM_ID
  );
  const taskIdBytes = Buffer.alloc(8);
  taskIdBytes.writeBigUInt64LE(BigInt(7));
  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskIdBytes],
    AGENTVAULT_PROGRAM_ID
  );
  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId,
    genesisHash: genesisHash.toBase58(),
    programId: AGENTVAULT_PROGRAM_ID.toBase58(),
    vault: vault.toBase58(),
    owner: owner.publicKey.toBase58(),
    mint: mint.toBase58(),
    assignedAgent: "agent-a",
    agentAuthority: agentSigner.publicKey.toBase58(),
    kind: "procurement",
    taskId: 7,
    recipient: recipient.toBase58(),
    amountBaseUnits: 1000,
    expiresAtUnix: nowUnix + 1800,
    description: "Owner-approved cloud infrastructure payment",
  };
  const signedWorkflow = {
    workflow,
    signature: Buffer.from(
      nacl.sign.detached(encodeWorkflowV2(workflow), owner.secretKey)
    ).toString("base64"),
  };
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
    expiresAtUnix: String(nowUnix + 900),
    requestId,
  };
  const signatureBase64 = Buffer.from(
    nacl.sign.detached(
      encodePaymentApprovalV2(paymentApproval),
      owner.secretKey
    )
  ).toString("base64");
  const binding = {
    signedWorkflow,
    paymentApproval,
    signatureBase64,
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
    taskExpiresAtUnix: String(nowUnix + 3600),
    nowUnix,
  };
  const unsigned = buildUnsignedModelBPayment(
    binding,
    Keypair.generate().publicKey.toBase58()
  );
  unsigned.transaction.sign(agentSigner);
  const signedTransaction = Buffer.from(unsigned.transaction.serialize());
  const signature = signatureBase58(unsigned.transaction.signature!);
  const claim: ClaimModelBPayment = {
    requestId,
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    workflowDigest: computeModelBWorkflowDigest(signedWorkflow),
    paymentDigest: computeModelBPaymentApprovalDigest(
      paymentApproval,
      signatureBase64
    ),
  };
  const payment: AuthorizedSignedModelBPayment = {
    requestId,
    signedTransaction,
    signature,
    lastValidBlockHeight: 9000,
    binding,
  };
  const record: ModelBPaymentRecord = {
    ...claim,
    phase: "SUBMISSION_RESERVED",
    signedTransaction,
    signedTransactionSha256: createHash("sha256")
      .update(signedTransaction)
      .digest("hex"),
    signature,
    lastValidBlockHeight: 9000,
    finalizedSlot: null,
    finalityObservedAt: null,
  };
  return { owner, agentSigner, binding, claim, payment, record };
}
