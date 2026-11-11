/**
 * 7.6D.3: INACTIVE PostgreSQL-backed Model B broadcast boundary.
 *
 * NOT imported by the executable Model B CLI. This module provides a narrowly
 * opt-in test harness for reviewing the future broadcast sequence. It is NOT a
 * production activation switch: real credentials, the trusted live policy
 * reader, finalizer isolation, and a reviewed Devnet-only runner are missing.
 *
 * The only irreversible transition is PREPARED -> SUBMISSION_RESERVED. Every
 * network error after that transition is ambiguous: NEVER broadcast again,
 * regenerate the transaction, or reset the request to PREPARED. Recover via
 * read-only inspection and an independently privileged finalizer.
 */
import { VersionedTransaction, type Connection } from "@solana/web3.js";
import { signedWorkflowV2Schema } from "./signed-workflow-v2";
import {
  validateAuthorizedModelBPayment,
  type AuthorizedSignedModelBPayment,
} from "./model-b-postgres-payment-store";
import {
  reserveOriginalModelBSubmissionOnce,
  type ModelBPreparationBackend,
} from "./model-b-postgres-durable-preparation";

export type ModelBPostgresBroadcastRpc = Pick<
  Connection,
  | "getGenesisHash"
  | "getBlockHeight"
  | "simulateTransaction"
  | "sendRawTransaction"
>;

export type ModelBPostgresBroadcastControls = {
  /** No runtime or CLI route supplies this opt-in. Only a fake-RPC test does. */
  mode?: "disabled" | "test-harness";
  /** Independent trusted deployment configuration; NOT derived from the signer. */
  trustedDevnetGenesisHash: string;
  /** Must query fresh Solana policy. A test harness may supply a fake checker. */
  assertFreshOnChainPolicy: () => Promise<void>;
};

export type ModelBPostgresBroadcastResult = {
  requestId: string;
  signature: string;
  status: "rpc_accepted_not_finalized";
};

/**
 * Simulate with signature verification BEFORE taking the irreversible permit.
 * The permit is one-winner across workers and is committed BEFORE one send.
 * No extra broadcast, confirmation-based retry, or write of fake finality.
 *
 * Security warning: mode=test-harness is ONLY for injected fake RPC tests. It
 * is not a production capability or adequate authorization for a live RPC.
 */
export async function exerciseModelBPostgresBroadcastBoundary(
  store: ModelBPreparationBackend,
  payment: AuthorizedSignedModelBPayment,
  rpc: ModelBPostgresBroadcastRpc,
  controls: ModelBPostgresBroadcastControls
): Promise<ModelBPostgresBroadcastResult> {
  if (controls?.mode !== "test-harness") {
    throw new Error(
      "MODEL_B_POSTGRES_BROADCAST_DISABLED: no live runtime integration"
    );
  }
  if (typeof controls.assertFreshOnChainPolicy !== "function") {
    throw new Error(
      "MODEL_B_POSTGRES_BROADCAST_DENIED: missing trusted policy reader"
    );
  }
  const { bytes } = validateAuthorizedModelBPayment(payment);
  const binding = payment.binding;
  const signedWorkflow = signedWorkflowV2Schema.parse(binding.signedWorkflow);
  if (
    binding.scope.network !== "devnet" ||
    signedWorkflow.workflow.network !== "devnet" ||
    !controls.trustedDevnetGenesisHash ||
    binding.scope.genesisHash !== controls.trustedDevnetGenesisHash ||
    signedWorkflow.workflow.genesisHash !== controls.trustedDevnetGenesisHash
  ) {
    throw new Error(
      "MODEL_B_POSTGRES_BROADCAST_DENIED: Devnet ledger is not trusted"
    );
  }

  const assertTrustedLedger = async (): Promise<void> => {
    const actual = await rpc.getGenesisHash();
    if (actual !== controls.trustedDevnetGenesisHash) {
      throw new Error("MODEL_B_POSTGRES_BROADCAST_DENIED: RPC ledger changed");
    }
  };
  const assertValidBlockHeight = async (): Promise<void> => {
    const height = await rpc.getBlockHeight("confirmed");
    if (
      !Number.isSafeInteger(height) ||
      height < 0 ||
      height > payment.lastValidBlockHeight
    ) {
      throw new Error(
        "MODEL_B_POSTGRES_BROADCAST_DENIED: original blockhash expired"
      );
    }
  };

  await controls.assertFreshOnChainPolicy();
  await assertTrustedLedger();
  await assertValidBlockHeight();

  // Simulate ORIGINAL signed bytes. Never rebuild or sign a substitute.
  const simulated = VersionedTransaction.deserialize(bytes);
  const result = await rpc.simulateTransaction(simulated, {
    commitment: "confirmed",
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  if (!result || !result.value || result.value.err !== null) {
    throw new Error(
      "MODEL_B_POSTGRES_BROADCAST_DENIED: signature-verified simulation failed"
    );
  }

  // Recheck after potentially slow simulation, and before irrevocable CAS.
  await assertTrustedLedger();
  await assertValidBlockHeight();
  await controls.assertFreshOnChainPolicy();

  // If SQL commits but the reply is lost, this throws and MUST NOT be retried.
  const permit = await reserveOriginalModelBSubmissionOnce(store, payment);
  if (
    !permit.signedTransaction.equals(bytes) ||
    permit.signature !== payment.signature ||
    permit.requestId !== payment.requestId ||
    permit.lastValidBlockHeight !== payment.lastValidBlockHeight
  ) {
    throw new Error(
      "MODEL_B_POSTGRES_BROADCAST_DENIED: reserved identity changed"
    );
  }

  // Exactly one application-level call. maxRetries=0; a transport/provider
  // can still have its own behavior. Any ambiguous result requires recovery.
  const returnedSignature = await rpc.sendRawTransaction(
    Buffer.from(permit.signedTransaction),
    { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 }
  );
  if (returnedSignature !== permit.signature) {
    throw new Error(
      "MODEL_B_POSTGRES_BROADCAST_UNCERTAIN: RPC signature mismatch; inspect only"
    );
  }
  // RPC acceptance does NOT establish on-chain confirmation or finalization.
  return {
    requestId: permit.requestId,
    signature: permit.signature,
    status: "rpc_accepted_not_finalized",
  };
}
