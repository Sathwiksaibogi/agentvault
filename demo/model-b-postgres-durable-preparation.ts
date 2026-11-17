/**
 * 7.6D.2: INACTIVE Model B PostgreSQL preparation / one-shot reservation.
 *
 * This module does not load agent keys, sign, simulate, contact Solana RPC,
 * or broadcast. It is intentionally NOT imported by the live Model B CLI.
 * The caller must enforce fresh on-chain policy and valid block height before
 * preparing or separately reserving a submission.
 *
 * A CLAIMED row can be stranded by a crash and MUST NOT be recreated. A
 * SUBMISSION_RESERVED row can be stranded by a crash and MUST NOT be retried:
 * inspect the original signature and reconcile through the isolated finalizer.
 */
import {
  validateAuthorizedModelBPayment,
  validateSignedPayment,
  type AuthorizedSignedModelBPayment,
  type ClaimModelBPayment,
  type ModelBPaymentRecord,
} from "./model-b-postgres-payment-store";
import type { ModelBPrepareService } from "./model-b-postgres-runtime-databases";

/** No raw SQL, client, finalizer, or broadcaster is accepted here. */
export type ModelBPreparationBackend = Pick<
  ModelBPrepareService,
  | "claim"
  | "persistSignedPayment"
  | "getForReconciliation"
  | "reserveOneSubmission"
>;

export type ReservedOriginalModelBPayment = {
  requestId: string;
  signature: string;
  signedTransaction: Buffer;
  lastValidBlockHeight: number;
  /** SQL reservation has committed; exactly one broadcast may be attempted. */
  phase: "SUBMISSION_RESERVED";
};

function assertClaimIdentity(
  record: ModelBPaymentRecord,
  claim: ClaimModelBPayment
): void {
  for (const key of [
    "requestId",
    "genesisHash",
    "programId",
    "vault",
    "workflowDigest",
    "paymentDigest",
  ] as const) {
    if (record[key] !== claim[key]) {
      throw new Error(
        `MODEL_B_PAYMENT_CONFLICT: persisted ${key} differs from approval`
      );
    }
  }
}

function assertExactSignedRecord(
  record: ModelBPaymentRecord,
  payment: AuthorizedSignedModelBPayment,
  claim: ClaimModelBPayment,
  sha256: string,
  bytes: Buffer
): void {
  assertClaimIdentity(record, claim);
  if (
    !record.signedTransaction ||
    !record.signedTransaction.equals(bytes) ||
    record.signedTransactionSha256 !== sha256 ||
    record.signature !== payment.signature ||
    record.lastValidBlockHeight !== payment.lastValidBlockHeight
  ) {
    throw new Error(
      "MODEL_B_PAYMENT_CONFLICT: stored transaction identity differs from approval"
    );
  }
  // Re-verify the bytes returned by storage; don't rely on a digest alone.
  const stored = validateSignedPayment({
    requestId: record.requestId,
    signedTransaction: record.signedTransaction,
    signature: record.signature,
    lastValidBlockHeight: record.lastValidBlockHeight,
  });
  if (stored.sha256 !== sha256) {
    throw new Error(
      "MODEL_B_PAYMENT_CONFLICT: stored signed transaction was corrupted"
    );
  }
}

/**
 * Authorize before writing a CLAIMED row; no arbitrary signed SOL transfer
 * can create a durable request through this adapter. Never retry this entire
 * operation after an exception: the claim might already have committed.
 */
export async function prepareModelBPaymentDurably(
  store: ModelBPreparationBackend,
  payment: AuthorizedSignedModelBPayment
): Promise<ModelBPaymentRecord> {
  const { bytes, sha256, claim } = validateAuthorizedModelBPayment(payment);
  const claimed = await store.claim(claim);
  assertClaimIdentity(claimed, claim);
  if (
    claimed.phase !== "CLAIMED" ||
    claimed.signedTransaction !== null ||
    claimed.signature !== null ||
    claimed.signedTransactionSha256 !== null ||
    claimed.lastValidBlockHeight !== null
  ) {
    throw new Error("MODEL_B_PAYMENT_CONFLICT: unexpected claim state");
  }

  // Store validates the owner approvals AGAIN immediately before SQL and
  // uses the copied transaction bytes, not the caller's mutable Uint8Array.
  const prepared = await store.persistSignedPayment({
    ...payment,
    signedTransaction: Buffer.from(bytes),
  });
  if (prepared.phase !== "PREPARED") {
    throw new Error("MODEL_B_PAYMENT_CONFLICT: unexpected preparation state");
  }
  assertExactSignedRecord(prepared, payment, claim, sha256, bytes);
  return prepared;
}

/**
 * Irreversible one-shot reservation. The caller must independently ensure
 * that current chain policy, blockhash validity, user intent, and simulation
 * allow broadcasting. Neither this function nor its return value broadcasts.
 *
 * On ANY DB exception, ambiguous response, crash, or post-CAS verification
 * failure, do not call this again: read-only recovery is the only path.
 */
export async function reserveOriginalModelBSubmissionOnce(
  store: ModelBPreparationBackend,
  payment: AuthorizedSignedModelBPayment
): Promise<ReservedOriginalModelBPayment> {
  const { bytes, sha256, claim } = validateAuthorizedModelBPayment(payment);
  const before = await store.getForReconciliation(payment.requestId);
  if (!before || before.phase !== "PREPARED") {
    throw new Error(
      "MODEL_B_SUBMISSION_LOCKED: request is missing or not prepared"
    );
  }
  assertExactSignedRecord(before, payment, claim, sha256, bytes);

  // The SQL transition PREPARED -> SUBMISSION_RESERVED is a one-winner CAS.
  const reserved = await store.reserveOneSubmission(payment.requestId);
  if (reserved.phase !== "SUBMISSION_RESERVED") {
    throw new Error("MODEL_B_PAYMENT_CONFLICT: unexpected reservation state");
  }
  assertExactSignedRecord(reserved, payment, claim, sha256, bytes);
  return {
    requestId: reserved.requestId,
    signature: reserved.signature!,
    signedTransaction: Buffer.from(reserved.signedTransaction!),
    lastValidBlockHeight: reserved.lastValidBlockHeight!,
    phase: "SUBMISSION_RESERVED",
  };
}

/** Read-only restart view; never signs, replaces, reserves or resubmits. */
export async function inspectDurableModelBPayment(
  store: Pick<ModelBPrepareService, "getForReconciliation">,
  requestId: string
): Promise<ModelBPaymentRecord | null> {
  return store.getForReconciliation(requestId);
}
