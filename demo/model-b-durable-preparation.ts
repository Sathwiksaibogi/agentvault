import assert from "node:assert/strict";
import bs58 from "bs58";

import { Keypair, PublicKey } from "@solana/web3.js";

import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import { signedWorkflowV2Schema } from "./signed-workflow-v2";
import { buildUnsignedModelBPayment } from "./model-b-payment-builder";
import {
  assertExactModelBPayment,
  assertModelBPaymentInstructions,
  assertSerializedModelBPayment,
} from "./model-b-transaction-guard";
import { claimModelBWorkflow } from "./model-b-request-journal";
import {
  loadPreparedModelBPayment,
  prepareSignedModelBPayment,
} from "./model-b-prepared-payment";

export type DurableModelBPreparation = {
  requestId: string;
  signature: string;
  rawTransaction: Buffer;
  blockhash: string;
  lastValidBlockHeight: number;
};

/**
 * The ONLY responsibilities here are durable claim, sign, persist and restore.
 * No RPC calls, simulation, or broadcast are performed.
 *
 * Call ONLY after an interactive confirmation, a fresh on-chain policy recheck,
 * an independently fetched valid blockhash, and verification of the agent key.
 * Once the claim is written, a failure is irreversible without an explicit
 * recovery investigation. Never automatically rerun this function.
 */
export function prepareDurableModelBPayment(
  runtimeDir: string,
  binding: ModelBWorkflowBinding,
  agentSigner: Keypair,
  blockhash: string,
  lastValidBlockHeight: number
): DurableModelBPreparation {
  assert.ok(
    Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0,
    "Invalid Model B blockhash validity height"
  );

  const signed = signedWorkflowV2Schema.parse(binding.signedWorkflow);
  const requestId = signed.workflow.requestId;
  const authority = new PublicKey(signed.workflow.agentAuthority);
  assert.ok(
    agentSigner.publicKey.equals(authority),
    "Model B agent signer mismatch"
  );

  // Build and verify instructions BEFORE creating the exclusive journal claim.
  const { transaction, paymentInstruction } = buildUnsignedModelBPayment(
    binding,
    blockhash
  );
  const expected = { binding, paymentInstruction };
  assertModelBPaymentInstructions(transaction, expected);

  // Exclusive, durable and shared with Model A. On any subsequent failure,
  // leave the claim in place and use the recovery path; never retry signing.
  claimModelBWorkflow(runtimeDir, binding);

  transaction.sign(agentSigner);
  assertExactModelBPayment(transaction, expected);

  prepareSignedModelBPayment(
    runtimeDir,
    binding,
    lastValidBlockHeight,
    transaction
  );

  // Restore and independently validate the exact bytes that would be sent.
  const restored = loadPreparedModelBPayment(
    runtimeDir,
    requestId,
    binding.signedWorkflow,
    binding.scope
  );
  assertSerializedModelBPayment(restored.transaction, expected);

  assert.equal(restored.record.recentBlockhash, blockhash);
  assert.equal(restored.record.lastValidBlockHeight, lastValidBlockHeight);
  assert.equal(restored.record.requestId, requestId);
  assert.ok(restored.transaction.signature, "Missing saved agent signature");

  return {
    requestId,
    signature: bs58.encode(restored.transaction.signature),
    rawTransaction: Buffer.from(restored.raw),
    blockhash,
    lastValidBlockHeight,
  };
}
