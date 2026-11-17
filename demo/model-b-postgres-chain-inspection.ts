/**
 * 7.6C.4: READ-ONLY, conservative Model B chain finality inspection.
 *
 * Does not call recordChainStatus, acquire submission permission, send a
 * transaction, modify a journal, or write to PostgreSQL. Suitable only as
 * an input to a separately reviewed reconciliation workflow.
 */
import {
  validatePaymentClaim,
  validateSignedPayment,
  type ModelBPaymentRecord,
} from "./model-b-postgres-payment-store";

type ChainSignatureStatus = {
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  slot: number;
  err: unknown | null;
};

type ChainTransaction = {
  slot: number;
  transaction: { signatures: string[] };
  meta: { err: unknown | null } | null;
};

/** Structural subset of @solana/web3.js Connection. Never sends transactions. */
export type ModelBFinalityRpc = {
  getGenesisHash(): Promise<string>;
  getSignatureStatuses(
    signatures: string[],
    config: { searchTransactionHistory: true }
  ): Promise<{ value: (ChainSignatureStatus | null)[] }>;
  getTransaction(
    signature: string,
    config: { commitment: "finalized"; maxSupportedTransactionVersion: 0 }
  ): Promise<ChainTransaction | null>;
};

export type ModelBFinalityObservation =
  | {
      status: "UNRESOLVED";
      requestId: string;
      signature: string;
      reason: string;
    }
  | {
      status: "CONFIRMED" | "FAILED";
      requestId: string;
      signature: string;
      finalizedSlot: number;
    };

function unresolved(
  record: ModelBPaymentRecord,
  reason: string
): ModelBFinalityObservation {
  return {
    status: "UNRESOLVED",
    requestId: record.requestId,
    signature: record.signature!,
    reason,
  };
}

/**
 * Only finalized, matching status AND transaction records can yield a
 * terminal observation. Any missing, malformed, contradictory, or unfinalized
 * evidence leaves the request unresolved. RPC exceptions propagate; callers
 * must leave the payment state unchanged on errors.
 *
 * Do NOT equate this observation with permission to rebroadcast/re-sign.
 */
export async function inspectModelBFinality(
  record: ModelBPaymentRecord,
  rpc: ModelBFinalityRpc
): Promise<ModelBFinalityObservation> {
  if (record.phase !== "SUBMISSION_RESERVED" && record.phase !== "UNRESOLVED") {
    throw new Error(
      "Only submitted or unresolved records can be chain-inspected"
    );
  }
  validatePaymentClaim(record);
  if (
    !record.signedTransaction ||
    !record.signature ||
    record.lastValidBlockHeight === null ||
    !record.signedTransactionSha256
  ) {
    throw new Error("Record lacks an immutable signed payment");
  }
  const verified = validateSignedPayment({
    requestId: record.requestId,
    signedTransaction: record.signedTransaction,
    signature: record.signature,
    lastValidBlockHeight: record.lastValidBlockHeight,
  });
  if (verified.sha256 !== record.signedTransactionSha256) {
    throw new Error("Stored signed transaction digest mismatch");
  }

  // The stored signed transaction signature is the canonical identity.
  const before = await rpc.getGenesisHash();
  if (before !== record.genesisHash) {
    throw new Error("RPC genesis differs from claimed payment ledger");
  }
  const statuses = await rpc.getSignatureStatuses([record.signature], {
    searchTransactionHistory: true,
  });
  if (
    !statuses ||
    !Array.isArray(statuses.value) ||
    statuses.value.length !== 1
  ) {
    return unresolved(record, "RPC status response is incomplete");
  }
  const status = statuses.value[0];
  if (!status || status.confirmationStatus !== "finalized") {
    return unresolved(record, "Signature has no finalized status");
  }
  if (!Number.isSafeInteger(status.slot) || status.slot < 0) {
    return unresolved(record, "Finalized signature slot is invalid");
  }
  const chainTx = await rpc.getTransaction(record.signature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  if (!chainTx || !chainTx.meta) {
    return unresolved(record, "Finalized transaction receipt is unavailable");
  }
  if (
    !Number.isSafeInteger(chainTx.slot) ||
    chainTx.slot !== status.slot ||
    !chainTx.transaction ||
    !Array.isArray(chainTx.transaction.signatures) ||
    chainTx.transaction.signatures[0] !== record.signature
  ) {
    return unresolved(
      record,
      "Transaction does not match finalized signature and slot"
    );
  }
  // RPC error fields are required even for successful transactions (null).
  // Missing fields from two malformed responses must NOT masquerade as
  // matching finalized on-chain errors.
  if (status.err === undefined || chainTx.meta.err === undefined) {
    return unresolved(record, "Finalized error metadata is missing");
  }
  // Different RPC endpoints/commitments must not supply contradictory errors.
  if (JSON.stringify(status.err) !== JSON.stringify(chainTx.meta.err)) {
    return unresolved(
      record,
      "Finalized status and transaction error disagree"
    );
  }
  const after = await rpc.getGenesisHash();
  if (after !== record.genesisHash) {
    throw new Error("RPC genesis changed while inspecting the payment");
  }
  return {
    status: status.err === null ? "CONFIRMED" : "FAILED",
    requestId: record.requestId,
    signature: record.signature,
    finalizedSlot: status.slot,
  };
}
