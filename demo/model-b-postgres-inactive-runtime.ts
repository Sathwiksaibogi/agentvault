/**
 * 7.6D.4: INACTIVE Model B PostgreSQL coordinator and read-only recovery.
 *
 * Not imported by execute-ai-workflow-model-b.ts, the executable CLI, or an
 * HTTP handler. Does NOT sign, reserve submission, simulate or broadcast.
 * A coordinator has no finalizer credential or finality write operation; a
 * reader has no claim/prepare/submit operation.
 *
 * Security boundary: trustedChecks must be supplied from vetted, fresh Solana
 * state at the eventual service integration. A caller-controlled callback is
 * NOT equivalent to a trusted policy check. This module is not a live switch.
 */
import { createHash } from "node:crypto";
import {
  validateAuthorizedModelBPayment,
  validatePaymentClaim,
  validateSignedPayment,
  type AuthorizedSignedModelBPayment,
  type ModelBPaymentRecord,
  type PaymentRequestPhase,
} from "./model-b-postgres-payment-store";
import { signedWorkflowV2Schema } from "./signed-workflow-v2";
import {
  prepareModelBPaymentDurably,
  type ModelBPreparationBackend,
} from "./model-b-postgres-durable-preparation";
import {
  openModelBCoordinatorDatabase,
  openModelBReaderDatabase,
  type ModelBReadService,
} from "./model-b-postgres-runtime-databases";

export type TrustedModelBPreparationChecks = {
  /** Deployment-pinned and not derived from the payment or owner approval. */
  trustedDevnetGenesisHash: string;
  getGenesisHash(): Promise<string>;
  getBlockHeight(commitment: "confirmed"): Promise<number>;
  /** Must independently re-fetch and validate ALL current on-chain policy. */
  assertFreshOnChainPolicy(): Promise<void>;
};

export type ModelBRecoverySnapshot = Readonly<{
  requestId: string;
  phase: PaymentRequestPhase | "NOT_FOUND";
  signature: string | null;
  lastValidBlockHeight: number | null;
  finalizedSlot: number | null;
  nextAction: "NONE" | "MANUAL_REVIEW" | "INSPECT_FINALITY" | "TERMINAL";
  canRetryPreparation: false;
  canReserveSubmission: false;
  canBroadcast: false;
}>;

function assertRequestId(requestId: string): void {
  if (
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)
  ) {
    throw new Error("Invalid Model B recovery request ID");
  }
}

/**
 * Single read only: return metadata, not transaction bytes or approval secrets.
 * Missing, CLAIMED, PREPARED and SUBMISSION_RESERVED never authorize retry.
 * Structural corruption fails closed rather than returning a misleading phase.
 */
export async function inspectInactiveModelBRecovery(
  reader: Pick<ModelBReadService, "getForReconciliation">,
  requestId: string
): Promise<ModelBRecoverySnapshot> {
  assertRequestId(requestId);
  const record = await reader.getForReconciliation(requestId);
  if (!record) {
    return Object.freeze({
      requestId,
      phase: "NOT_FOUND",
      signature: null,
      lastValidBlockHeight: null,
      finalizedSlot: null,
      nextAction: "NONE",
      canRetryPreparation: false,
      canReserveSubmission: false,
      canBroadcast: false,
    });
  }
  if (record.requestId !== requestId) {
    throw new Error("MODEL_B_RECOVERY_CORRUPT: request identity mismatch");
  }
  validatePaymentClaim(record);
  const knownPhases: PaymentRequestPhase[] = [
    "CLAIMED",
    "PREPARED",
    "SUBMISSION_RESERVED",
    "UNRESOLVED",
    "CONFIRMED",
    "FAILED",
  ];
  if (!knownPhases.includes(record.phase)) {
    throw new Error("MODEL_B_RECOVERY_CORRUPT: unknown payment phase");
  }
  if (record.phase === "CLAIMED") {
    if (
      record.signature !== null ||
      record.signedTransaction !== null ||
      record.signedTransactionSha256 !== null ||
      record.lastValidBlockHeight !== null
    ) {
      throw new Error(
        "MODEL_B_RECOVERY_CORRUPT: CLAIMED record has transaction data"
      );
    }
  } else {
    if (
      !record.signature ||
      !record.signedTransaction ||
      !record.signedTransactionSha256 ||
      record.lastValidBlockHeight === null
    ) {
      throw new Error(
        "MODEL_B_RECOVERY_CORRUPT: missing immutable signed payment"
      );
    }
    const verified = validateSignedPayment({
      requestId,
      signature: record.signature,
      signedTransaction: record.signedTransaction,
      lastValidBlockHeight: record.lastValidBlockHeight,
    });
    if (
      record.signedTransactionSha256 !== verified.sha256 ||
      createHash("sha256").update(record.signedTransaction).digest("hex") !==
        verified.sha256
    ) {
      throw new Error(
        "MODEL_B_RECOVERY_CORRUPT: signed transaction digest differs"
      );
    }
  }
  if (
    (record.phase === "CONFIRMED" || record.phase === "FAILED") &&
    (!Number.isSafeInteger(record.finalizedSlot) ||
      (record.finalizedSlot ?? -1) < 0)
  ) {
    throw new Error(
      "MODEL_B_RECOVERY_CORRUPT: terminal status lacks finalized slot"
    );
  }
  const nextAction =
    record.phase === "CLAIMED" || record.phase === "PREPARED"
      ? "MANUAL_REVIEW"
      : record.phase === "SUBMISSION_RESERVED" || record.phase === "UNRESOLVED"
      ? "INSPECT_FINALITY"
      : "TERMINAL";
  return Object.freeze({
    requestId,
    phase: record.phase,
    signature: record.signature,
    lastValidBlockHeight: record.lastValidBlockHeight,
    finalizedSlot: record.finalizedSlot ?? null,
    nextAction,
    canRetryPreparation: false,
    canReserveSubmission: false,
    canBroadcast: false,
  });
}

async function verifyFreshPreparation(
  payment: AuthorizedSignedModelBPayment,
  checks: TrustedModelBPreparationChecks
): Promise<void> {
  // Authenticate the signed payment and its owner approvals before any RPC or
  // DB access. Parse the workflow before reading previously unknown fields.
  validateAuthorizedModelBPayment(payment);
  const workflow = signedWorkflowV2Schema.parse(
    payment.binding.signedWorkflow
  ).workflow;
  const trustedGenesis = checks?.trustedDevnetGenesisHash;
  if (
    !trustedGenesis ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trustedGenesis) ||
    payment.binding.scope.network !== "devnet" ||
    workflow.network !== "devnet" ||
    payment.binding.scope.genesisHash !== trustedGenesis ||
    workflow.genesisHash !== trustedGenesis
  ) {
    throw new Error("MODEL_B_RUNTIME_DENIED: untrusted Devnet configuration");
  }
  if (
    typeof checks.assertFreshOnChainPolicy !== "function" ||
    typeof checks.getBlockHeight !== "function" ||
    typeof checks.getGenesisHash !== "function"
  ) {
    throw new Error("MODEL_B_RUNTIME_DENIED: trusted chain checks missing");
  }
  const assertLedgerAndHeight = async (): Promise<void> => {
    if ((await checks.getGenesisHash()) !== trustedGenesis) {
      throw new Error("MODEL_B_RUNTIME_DENIED: RPC ledger mismatch");
    }
    const height = await checks.getBlockHeight("confirmed");
    if (
      !Number.isSafeInteger(height) ||
      height < 0 ||
      height > payment.lastValidBlockHeight
    ) {
      throw new Error("MODEL_B_RUNTIME_DENIED: original blockhash expired");
    }
  };
  await assertLedgerAndHeight();
  await checks.assertFreshOnChainPolicy();
  await assertLedgerAndHeight();
  await checks.assertFreshOnChainPolicy();
  // Verify owner signature once more before opening the irreversible claim.
  validateAuthorizedModelBPayment(payment);
}

/**
 * A testable, narrow adapter. Does NOT expose reserveOneSubmission, raw SQL,
 * finalizer writes, agent keys or RPC send. Never retries a failed claim.
 */
export function createInactiveModelBCoordinatorRuntime(
  backend: ModelBPreparationBackend,
  checks: TrustedModelBPreparationChecks
) {
  return Object.freeze({
    async prepare(
      payment: AuthorizedSignedModelBPayment
    ): Promise<ModelBPaymentRecord> {
      await verifyFreshPreparation(payment, checks);
      return prepareModelBPaymentDurably(backend, payment);
    },
    inspect: (requestId: string) =>
      inspectInactiveModelBRecovery(backend, requestId),
  });
}

/** Reader-only adapter, including after a coordinator process exits. */
export function createInactiveModelBReaderRecoveryRuntime(
  reader: Pick<ModelBReadService, "getForReconciliation">
) {
  return Object.freeze({
    inspect: (requestId: string) =>
      inspectInactiveModelBRecovery(reader, requestId),
  });
}

/**
 * Separate process factory: only opens the coordinator credential, and its
 * startup role/grant preflight must pass. Not imported by any executable CLI.
 */
export async function openInactiveModelBCoordinatorRuntime(
  checks: TrustedModelBPreparationChecks,
  env: NodeJS.ProcessEnv = process.env
) {
  const connection = await openModelBCoordinatorDatabase(env);
  return Object.freeze({
    runtime: createInactiveModelBCoordinatorRuntime(connection.service, checks),
    close: connection.close,
  });
}

/** A different process with only the reader login; cannot prepare or send. */
export async function openInactiveModelBReaderRecoveryRuntime(
  env: NodeJS.ProcessEnv = process.env
) {
  const connection = await openModelBReaderDatabase(env);
  return Object.freeze({
    runtime: createInactiveModelBReaderRecoveryRuntime(connection.service),
    close: connection.close,
  });
}
