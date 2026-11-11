/**
 * 7.6D.5: INACTIVE, independently privileged Model B finality recovery.
 *
 * Not imported by the executable CLI or the API server. Does not hold an agent
 * signing key, prepare a payment, reserve a submission or broadcast anything.
 * Each call reads the existing immutable transaction, checks a deployment-pinned
 * Solana identity, inspects finalized RPC evidence and only then uses the
 * finalizer's guarded PostgreSQL compare-and-set transition.
 *
 * The RPC provider and the finalizer process are trusted inputs: this code
 * does not make database SQL cryptographically verify Solana finality. A
 * compromised finalizer that bypasses this module remains a release blocker.
 */
import { PublicKey } from "@solana/web3.js";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import type { ModelBFinalityRpc } from "./model-b-postgres-chain-inspection";
import { inspectInactiveModelBRecovery } from "./model-b-postgres-inactive-runtime";
import {
  validatePaymentClaim,
  type ModelBPaymentRecord,
  type PaymentRequestPhase,
} from "./model-b-postgres-payment-store";
import {
  reconcileModelBPayment,
  type ReconciliationResult,
} from "./model-b-postgres-reconciliation";
import {
  openModelBFinalizerDatabase,
  type ModelBFinalityService,
} from "./model-b-postgres-runtime-databases";

/** Each value comes from the deployment, never the record or an API request. */
export type TrustedModelBFinalizer = Readonly<{
  genesisHash: string;
  programId: string;
  vault: string;
  rpc: ModelBFinalityRpc;
}>;

export type FinalityRecoveryResult = Readonly<{
  requestId: string;
  action: ReconciliationResult["action"];
  phase: PaymentRequestPhase;
  signature: string | null;
  finalizedSlot: number | null;
  /** Never a permission to broadcast, retry, or make a replacement payment. */
  canReserveSubmission: false;
  canBroadcast: false;
  canRetryPreparation: false;
}>;

function canonicalPublicKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function validateDeployment(deployment: TrustedModelBFinalizer): void {
  if (
    !deployment ||
    !canonicalPublicKey(deployment.genesisHash) ||
    !canonicalPublicKey(deployment.programId) ||
    deployment.programId !== AGENTVAULT_PROGRAM_ID.toBase58() ||
    !canonicalPublicKey(deployment.vault) ||
    !deployment.rpc ||
    typeof deployment.rpc.getGenesisHash !== "function" ||
    typeof deployment.rpc.getSignatureStatuses !== "function" ||
    typeof deployment.rpc.getTransaction !== "function"
  ) {
    throw new Error(
      "MODEL_B_FINALIZER_DENIED: invalid trusted deployment configuration"
    );
  }
}

function assertDeploymentRecord(
  record: ModelBPaymentRecord,
  deployment: TrustedModelBFinalizer
): void {
  validatePaymentClaim(record);
  if (
    record.genesisHash !== deployment.genesisHash ||
    record.programId !== deployment.programId ||
    record.vault !== deployment.vault
  ) {
    throw new Error(
      "MODEL_B_FINALIZER_DENIED: stored payment is outside pinned deployment"
    );
  }
}

/**
 * Accept only the two methods used by reconciliation, not raw PostgreSQL or
 * preparation/submission capabilities. Every read is checked, including a
 * later re-read after a competing worker wins its CAS.
 */
export function createInactiveModelBFinalizerRuntime(
  service: Pick<
    ModelBFinalityService,
    "getForReconciliation" | "applyInspectedStatus"
  >,
  deployment: TrustedModelBFinalizer
) {
  validateDeployment(deployment);
  const scoped = Object.freeze({
    async getForReconciliation(requestId: string) {
      const row = await service.getForReconciliation(requestId);
      if (row) assertDeploymentRecord(row, deployment);
      return row;
    },
    async applyInspectedStatus(
      before: ModelBPaymentRecord,
      observation: Parameters<ModelBFinalityService["applyInspectedStatus"]>[1]
    ) {
      assertDeploymentRecord(before, deployment);
      const updated = await service.applyInspectedStatus(before, observation);
      if (updated) assertDeploymentRecord(updated, deployment);
      return updated;
    },
  });

  return Object.freeze({
    /** Only metadata; inspect never sends, retries, signs, or changes SQL. */
    inspect: (requestId: string) =>
      inspectInactiveModelBRecovery(scoped, requestId),
    /**
     * May write UNRESOLVED or a verified terminal outcome, but ONLY through
     * the guarded CAS and only for an already submission-reserved request.
     */
    async reconcile(requestId: string): Promise<FinalityRecoveryResult> {
      const snapshot = await inspectInactiveModelBRecovery(scoped, requestId);
      if (snapshot.phase === "NOT_FOUND")
        throw new Error("Unknown Model B payment request");
      if (snapshot.phase === "CLAIMED" || snapshot.phase === "PREPARED") {
        throw new Error(
          "MODEL_B_FINALIZER_DENIED: request has no submission reservation"
        );
      }
      const result = await reconcileModelBPayment(
        requestId,
        scoped,
        deployment.rpc
      );
      assertDeploymentRecord(result.record, deployment);
      // Terminal or unresolved records must remain structurally valid after CAS.
      await inspectInactiveModelBRecovery(
        {
          getForReconciliation: async () => result.record,
        },
        requestId
      );
      return Object.freeze({
        requestId,
        action: result.action,
        phase: result.record.phase,
        signature: result.record.signature,
        finalizedSlot: result.record.finalizedSlot ?? null,
        canReserveSubmission: false,
        canBroadcast: false,
        canRetryPreparation: false,
      });
    },
  });
}

/**
 * Dedicated finalizer process ONLY: opens the finalizer credential (and runs
 * the D.1 preflight) without loading the coordinator/reader connection URLs.
 * Does not provide any live entry point or CLI flag.
 */
export async function openInactiveModelBFinalizerRuntime(
  deployment: TrustedModelBFinalizer,
  env: NodeJS.ProcessEnv = process.env
) {
  validateDeployment(deployment); // Before touching PostgreSQL or credentials.
  const connection = await openModelBFinalizerDatabase(env);
  return Object.freeze({
    runtime: createInactiveModelBFinalizerRuntime(
      connection.service,
      deployment
    ),
    close: connection.close,
  });
}
