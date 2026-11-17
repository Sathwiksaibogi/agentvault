import BN from "bn.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import type { Agentvault } from "../target/types/agentvault";

import {
  signedWorkflowSchema,
  verifyWorkflowApproval,
  type ApprovalScope,
} from "./signed-workflow";

import { assertApprovalDigestMatchesJournal } from "./request-journal";
import { loadPreparedPayment } from "./prepared-payment";
import { assertSerializedAgentVaultPayment } from "./payment-transaction-guard";

export type SavedPaymentState = ApprovalScope & {
  treasury: string;
};

export type VerifiedSavedPayment = {
  requestId: string;
  agent: string;
  agentAuthority: string;
  recipient: string;
  amountBaseUnits: number;
  nonce: string;
  signature: string;
  lastValidBlockHeight: number;
};

export async function verifySavedPaymentIntegrity(
  runtimeDir: string,
  requestId: string,
  state: SavedPaymentState,
  program: anchor.Program<Agentvault>
): Promise<VerifiedSavedPayment> {
  assert.match(requestId, /^[a-zA-Z0-9_-]{8,64}$/);

  assert.strictEqual(
    program.programId.toBase58(),
    state.programId,
    "Program ID mismatch"
  );

  const signedApproval = signedWorkflowSchema.parse(
    JSON.parse(
      readFileSync(join(runtimeDir, "approvals", `${requestId}.json`), "utf8")
    )
  );

  const claim = JSON.parse(
    readFileSync(join(runtimeDir, "journal", `${requestId}.json`), "utf8")
  );

  assert.strictEqual(
    claim.version,
    1,
    "Model B requires separate v2 recovery verification"
  );
  assert.strictEqual(claim.status, "claimed");
  assert.strictEqual(claim.requestId, requestId);
  assert.strictEqual(claim.network, state.network);
  assert.strictEqual(claim.genesisHash, state.genesisHash);
  assert.strictEqual(claim.vault, state.vault);
  assert.strictEqual(claim.owner, state.owner);

  // Bind the current approval file to the original claim.
  assertApprovalDigestMatchesJournal(signedApproval, claim.approvalDigest);

  const claimTime = Math.floor(Date.parse(claim.claimedAt) / 1000);

  assert.ok(
    Number.isSafeInteger(claimTime) && claimTime > 0,
    "Invalid historical claim time"
  );

  // Historical verification: an approval may have
  // expired after the payment was originally claimed.
  const workflow = verifyWorkflowApproval(signedApproval, state, claimTime);

  assert.strictEqual(workflow.requestId, requestId);
  assert.strictEqual(claim.agent, workflow.assignedAgent);
  assert.strictEqual(claim.recipient, workflow.recipient);
  assert.strictEqual(claim.amountBaseUnits, workflow.amountBaseUnits);

  const { record, transaction } = loadPreparedPayment(runtimeDir, requestId);

  assert.strictEqual(record.network, state.network);
  assert.strictEqual(record.agentAuthority, workflow.agentAuthority);
  assert.strictEqual(record.agent, workflow.assignedAgent);
  assert.strictEqual(record.amountBaseUnits, workflow.amountBaseUnits);

  const vault = new PublicKey(state.vault);
  const mint = new PublicKey(state.mint);
  const treasury = new PublicKey(state.treasury);
  const authority = new PublicKey(workflow.agentAuthority);
  const recipient = new PublicKey(workflow.recipient);

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), authority.toBuffer()],
    program.programId
  );

  const taskId = new BN(workflow.taskId);

  const [taskPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("task"),
      agentPda.toBuffer(),
      taskId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  assert.strictEqual(
    record.taskPda,
    taskPda.toBase58(),
    "Prepared payment task PDA mismatch"
  );

  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const paymentInstruction = await program.methods
    .executeTaskPayment(new BN(workflow.amountBaseUnits), new BN(record.nonce))
    .accountsPartial({
      agentAuthority: authority,
      vault,
      agent: agentPda,
      task: taskPda,
      tokenMint: mint,
      treasury,
      recipient,
      recipientToken: recipientAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  // Compare the complete compiled transaction message
  // against the canonical owner-authorized payment.
  assertSerializedAgentVaultPayment(transaction, {
    agentAuthority: authority,
    recipient,
    mint,
    paymentInstruction,
  });

  assert.ok(transaction.signature);

  return {
    requestId,
    agent: workflow.assignedAgent,
    agentAuthority: workflow.agentAuthority,
    recipient: workflow.recipient,
    amountBaseUnits: workflow.amountBaseUnits,
    nonce: record.nonce,
    signature: bs58.encode(transaction.signature),
    lastValidBlockHeight: record.lastValidBlockHeight,
  };
}
