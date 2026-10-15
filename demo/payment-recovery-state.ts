import { strict as assert } from "node:assert";

export type ObservedSignatureStatus = {
  err: unknown | null;
  confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
};

export type RecoveryState =
  | "CONFIRMED"
  | "FAILED_ON_CHAIN"
  | "OBSERVED_UNCONFIRMED"
  | "PENDING"
  | "EXPIRED_UNRESOLVED";

export function classifyPayment(
  status: ObservedSignatureStatus | null,
  currentBlockHeight: number,
  lastValidBlockHeight: number
): RecoveryState {
  assert.ok(
    Number.isSafeInteger(currentBlockHeight) && currentBlockHeight >= 0
  );

  assert.ok(
    Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0
  );

  if (status !== null) {
    const sufficientlyConfirmed =
      status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized";

    if (sufficientlyConfirmed) {
      return status.err == null ? "CONFIRMED" : "FAILED_ON_CHAIN";
    }

    // Includes processed-only transactions, even when
    // an RPC node temporarily reports an execution error.
    return "OBSERVED_UNCONFIRMED";
  }

  if (currentBlockHeight <= lastValidBlockHeight) {
    return "PENDING";
  }

  return "EXPIRED_UNRESOLVED";
}
