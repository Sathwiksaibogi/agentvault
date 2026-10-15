import * as anchor from "@anchor-lang/core";
import BN from "bn.js";

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Connection, PublicKey } from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import type { Agentvault } from "../target/types/agentvault";

import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";

import {
  signedWorkflowSchema,
  verifyWorkflowApproval,
} from "./signed-workflow";

import { loadPreparedPayment } from "./prepared-payment";

import { assertSerializedAgentVaultPayment } from "./payment-transaction-guard";

async function main() {
  const requestId = process.argv[2];

  assert.ok(
    requestId && /^[a-zA-Z0-9_-]{8,64}$/.test(requestId),
    "Usage: verify-saved-payment.ts <request-id>"
  );

  // Read the previously saved transaction.
  const prepared = loadPreparedPayment(RUNTIME_DIR, requestId);

  const { record, transaction } = prepared;

  // Read the original owner approval.
  const signedApproval = signedWorkflowSchema.parse(
    JSON.parse(
      readFileSync(join(RUNTIME_DIR, "approvals", `${requestId}.json`), "utf8")
    )
  );

  const state = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "state.json"), "utf8")
  );

  const claim = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "journal", `${requestId}.json`), "utf8")
  );

  assert.strictEqual(record.network, NETWORK);

  const claimTime = Math.floor(Date.parse(claim.claimedAt) / 1000);

  assert.ok(Number.isSafeInteger(claimTime));

  // Reverify the owner signature using the historical
  // claim time recorded in our trusted local journal.
  const workflow = verifyWorkflowApproval(
    signedApproval,
    {
      network: NETWORK,
      genesisHash: state.genesisHash,
      programId: state.programId,
      vault: state.vault,
      owner: state.owner,
      mint: state.mint,
    },
    claimTime
  );

  assert.strictEqual(workflow.requestId, requestId);
  assert.strictEqual(record.agentAuthority, workflow.agentAuthority);
  assert.strictEqual(record.amountBaseUnits, workflow.amountBaseUnits);
  assert.strictEqual(record.agent, workflow.assignedAgent);

  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
  ) as Agentvault;

  // Connection object is needed to construct Anchor's
  // Program, but no RPC request is made by this script.
  const program = new anchor.Program<Agentvault>(idl, {
    connection: new Connection(RPC_URL, "confirmed"),
  });

  assert.strictEqual(program.programId.toBase58(), state.programId);

  const vaultPda = new PublicKey(state.vault);
  const mint = new PublicKey(state.mint);
  const treasury = new PublicKey(state.treasury);
  const authority = new PublicKey(workflow.agentAuthority);
  const recipient = new PublicKey(workflow.recipient);

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vaultPda.toBuffer(), authority.toBuffer()],
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

  assert.strictEqual(record.taskPda, taskPda.toBase58());

  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Reconstruct the exact payment instruction from
  // the owner approval and saved on-chain nonce.
  const paymentInstruction = await program.methods
    .executeTaskPayment(new BN(workflow.amountBaseUnits), new BN(record.nonce))
    .accountsPartial({
      agentAuthority: authority,
      vault: vaultPda,
      agent: agentPda,
      task: taskPda,
      tokenMint: mint,
      treasury,
      recipient,
      recipientToken: recipientAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  // This is the corrected compiled-message guard.
  assertSerializedAgentVaultPayment(transaction, {
    agentAuthority: authority,
    recipient,
    mint,
    paymentInstruction,
  });

  console.log("\n=== SAVED PAYMENT VERIFICATION PASSED ===");
  console.log("Request:", requestId);
  console.log("Agent:", workflow.assignedAgent);
  console.log("Amount:", record.amountBaseUnits);
  console.log("Nonce:", record.nonce);
  console.log("Owner signature: VERIFIED");
  console.log("Saved signature: VERIFIED");
  console.log("Compiled message: VERIFIED");
  console.log("\nMODE: OFFLINE VERIFICATION");
  console.log("No payment broadcast.");
}

main().catch((error) => {
  console.error(
    "Saved payment verification failed:",
    error instanceof Error ? error.message : error
  );

  process.exitCode = 1;
});
