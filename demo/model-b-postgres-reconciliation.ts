/**
 * AgentVault 7.6C.5: inactive Model B finality -> PostgreSQL reconciliation.
 * This is the ONLY intended application entry point for status writes.
 * It never creates, signs, simulates, reserves, or sends a transaction.
 */
import {
  inspectModelBFinality,
  type ModelBFinalityObservation,
  type ModelBFinalityRpc,
} from "./model-b-postgres-chain-inspection";
import {
  PostgresModelBPaymentStore,
  type ModelBPaymentRecord,
} from "./model-b-postgres-payment-store";

export type ReconciliationResult = {
  action: "UPDATED" | "UNCHANGED" | "ALREADY_TERMINAL";
  record: ModelBPaymentRecord;
  observation: ModelBFinalityObservation | null;
};

function sameIdentity(a: ModelBPaymentRecord, b: ModelBPaymentRecord): boolean {
  return (
    a.requestId === b.requestId &&
    a.genesisHash === b.genesisHash &&
    a.programId === b.programId &&
    a.vault === b.vault &&
    a.workflowDigest === b.workflowDigest &&
    a.paymentDigest === b.paymentDigest &&
    a.signature !== null &&
    a.signature === b.signature &&
    a.signedTransactionSha256 !== null &&
    a.signedTransactionSha256 === b.signedTransactionSha256 &&
    a.lastValidBlockHeight !== null &&
    a.lastValidBlockHeight === b.lastValidBlockHeight &&
    a.signedTransaction !== null &&
    b.signedTransaction !== null &&
    a.signedTransaction.equals(b.signedTransaction)
  );
}

function isTerminal(record: ModelBPaymentRecord): boolean {
  return record.phase === "CONFIRMED" || record.phase === "FAILED";
}

/**
 * A missing request is NOT a new claim. A lost CAS is handled by reading the
 * existing row; it never triggers a send/retry. Persist a terminal outcome
 * only after finalized chain evidence is checked by inspectModelBFinality.
 *
 * The RPC is an explicitly trusted external dependency. No worker should
 * expose the store's low-level SQL methods as untrusted HTTP endpoints.
 */
export async function reconcileModelBPayment(
  requestId: string,
  store: Pick<
    PostgresModelBPaymentStore,
    "getForReconciliation" | "applyInspectedStatus"
  >,
  rpc: ModelBFinalityRpc
): Promise<ReconciliationResult> {
  const before = await store.getForReconciliation(requestId);
  if (!before) throw new Error("Unknown Model B payment request");
  if (isTerminal(before)) {
    // Already terminal: no network reads or writes, and never downgrade.
    return { action: "ALREADY_TERMINAL", record: before, observation: null };
  }
  if (before.phase !== "SUBMISSION_RESERVED" && before.phase !== "UNRESOLVED") {
    throw new Error(
      "Payment cannot be reconciled before submission is reserved"
    );
  }

  // All exceptions propagate and leave database state unchanged.
  const observation = await inspectModelBFinality(before, rpc);
  if (
    observation.requestId !== before.requestId ||
    observation.signature !== before.signature
  ) {
    throw new Error("Chain evidence was substituted during inspection");
  }
  if (observation.status === "UNRESOLVED" && before.phase === "UNRESOLVED") {
    return { action: "UNCHANGED", record: before, observation };
  }

  const updated = await store.applyInspectedStatus(before, observation);
  if (updated) {
    return { action: "UPDATED", record: updated, observation };
  }

  // Competing worker may have written a consistent observation first.
  // Never overwrite an already finalized outcome, nor adopt a different
  // immutable payment identity after a stale read.
  const latest = await store.getForReconciliation(requestId);
  if (!latest || !sameIdentity(before, latest)) {
    throw new Error(
      "RECONCILIATION_CONFLICT: immutable payment identity changed"
    );
  }
  if (isTerminal(latest)) {
    if (
      observation.status === "UNRESOLVED" ||
      (observation.status === latest.phase &&
        latest.finalizedSlot === observation.finalizedSlot)
    ) {
      return { action: "ALREADY_TERMINAL", record: latest, observation };
    }
    throw new Error("RECONCILIATION_CONFLICT: finalized observations disagree");
  }
  if (latest.phase === "UNRESOLVED" && observation.status === "UNRESOLVED") {
    return { action: "UNCHANGED", record: latest, observation };
  }
  // Any other CAS miss indicates unexpected state or conflicting application
  // behavior. Do not spin, retry, or attempt a transaction submission.
  throw new Error("RECONCILIATION_CONFLICT: state changed during inspection");
}
