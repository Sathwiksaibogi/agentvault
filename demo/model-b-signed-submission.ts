import assert from "node:assert/strict";
import bs58 from "bs58";

import { Connection, VersionedTransaction } from "@solana/web3.js";

import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import type { DurableModelBPreparation } from "./model-b-durable-preparation";
import { buildUnsignedModelBPayment } from "./model-b-payment-builder";
import { loadPreparedModelBPayment } from "./model-b-prepared-payment";
import { assertSerializedModelBPayment } from "./model-b-transaction-guard";

export type ModelBSubmissionRpc = Pick<
  Connection,
  | "getGenesisHash"
  | "getBlockHeight"
  | "simulateTransaction"
  | "sendRawTransaction"
  | "confirmTransaction"
>;

export type ModelBSubmissionResult = {
  signature: string;
  status: "confirmed";
};

/**
 * Submit ONLY bytes that already exist in the exclusive Model B journal.
 * This has no key loading, no signing, no new claim and no reconstruction for
 * transmission. All failures leave the original journal in place.
 *
 * Call exactly once from a reviewed, Devnet-only interactive coordinator after
 * post-confirmation chain revalidation and durable preparation. An ambiguous
 * send/confirmation error requires explicit recovery, not an automatic retry.
 *
 * This function is intentionally NOT wired to the preview CLI.
 */
export async function submitSignedModelBPayment(
  runtimeDir: string,
  binding: ModelBWorkflowBinding,
  prepared: DurableModelBPreparation,
  rpc: ModelBSubmissionRpc
): Promise<ModelBSubmissionResult> {
  assert.equal(
    binding.scope.network,
    "devnet",
    "Model B submission is Devnet-only"
  );
  assert.ok(Number.isSafeInteger(prepared.lastValidBlockHeight));
  assert.ok(prepared.lastValidBlockHeight > 0);

  // Load the original claim, exact signed bytes and their authenticated
  // approval digests. This fails closed for missing or modified records.
  const restored = loadPreparedModelBPayment(
    runtimeDir,
    prepared.requestId,
    binding.signedWorkflow,
    binding.scope
  );

  assert.equal(restored.record.requestId, prepared.requestId);
  assert.equal(restored.record.recentBlockhash, prepared.blockhash);
  assert.equal(
    restored.record.lastValidBlockHeight,
    prepared.lastValidBlockHeight,
    "Prepared Model B validity height mismatch"
  );
  assert.ok(
    Buffer.from(restored.raw).equals(prepared.rawTransaction),
    "Prepared Model B bytes differ from durable journal"
  );

  const signature = bs58.encode(
    restored.transaction.signature ?? Buffer.alloc(0)
  );
  assert.equal(
    signature,
    prepared.signature,
    "Prepared Model B signature mismatch"
  );

  // Rebuild ONLY for independent message verification. Never transmit it.
  const { paymentInstruction } = buildUnsignedModelBPayment(
    binding,
    prepared.blockhash
  );
  assertSerializedModelBPayment(restored.transaction, {
    binding,
    paymentInstruction,
  });

  assert.equal(
    await rpc.getGenesisHash(),
    binding.scope.genesisHash,
    "Model B RPC ledger changed before submission"
  );

  const ensureFreshBlockhash = async () => {
    const observedHeight = await rpc.getBlockHeight("confirmed");
    assert.ok(
      Number.isSafeInteger(observedHeight) &&
        observedHeight >= 0 &&
        observedHeight <= prepared.lastValidBlockHeight,
      "Model B prepared blockhash expired"
    );
  };

  await ensureFreshBlockhash();

  // Simulate the original signed bytes with signature verification enabled.
  const exactSigned = VersionedTransaction.deserialize(restored.raw);
  const simulation = await rpc.simulateTransaction(exactSigned, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (simulation.value.err !== null) {
    throw new Error(
      `Saved Model B payment simulation failed: ${JSON.stringify(
        simulation.value.err
      )}`
    );
  }

  // Both checks are made again because RPC calls may take significant time.
  assert.equal(
    await rpc.getGenesisHash(),
    binding.scope.genesisHash,
    "Model B RPC ledger changed during simulation"
  );
  await ensureFreshBlockhash();

  // Broadcast *only* the bytes already saved in the journal.
  // Do not automatically retry on RPC errors or unknown confirmation outcome.
  const returnedSignature = await rpc.sendRawTransaction(restored.raw, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 0,
  });
  assert.equal(returnedSignature, signature, "Model B RPC signature mismatch");

  const confirmation = await rpc.confirmTransaction(
    {
      signature,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    },
    "confirmed"
  );
  assert.equal(
    confirmation.value.err,
    null,
    "Model B transaction failed on-chain; inspect the original journal"
  );

  return { signature, status: "confirmed" };
}
