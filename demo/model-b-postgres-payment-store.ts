/**
 * Inactive 7.6C.2 PostgreSQL coordination foundation for Model B payments.
 *
 * NOT connected to execute-ai-workflow-model-b.ts or any live payment path.
 * A successful CAS reservation authorizes at most ONE caller to attempt one
 * send. If that caller crashes or RPC is ambiguous, NEVER reserve/send again.
 * Inspect the original signature on-chain and reconcile read-only instead.
 */
import { createHash } from "node:crypto";
import { PublicKey, Transaction } from "@solana/web3.js";
import { assertSerializedModelBPayment } from "./model-b-transaction-guard";
import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import { signedWorkflowV2Schema } from "./signed-workflow-v2";
import { paymentApprovalV2Schema } from "./payment-approval-v2";
import { computeModelBWorkflowDigest } from "./model-b-workflow-digest";
import { computeModelBPaymentApprovalDigest } from "./model-b-request-journal";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type PaymentRequestPhase =
  | "CLAIMED"
  | "PREPARED"
  | "SUBMISSION_RESERVED"
  | "UNRESOLVED"
  | "CONFIRMED"
  | "FAILED";

export type ClaimModelBPayment = {
  requestId: string;
  genesisHash: string;
  programId: string;
  vault: string;
  workflowDigest: string;
  paymentDigest: string;
};

export type SignedModelBPayment = {
  requestId: string;
  signedTransaction: Uint8Array;
  signature: string;
  lastValidBlockHeight: number;
};

/** Mandatory cryptographic authorization context for the only persistence entry point. */
export type AuthorizedSignedModelBPayment = SignedModelBPayment & {
  binding: ModelBWorkflowBinding;
};

export type ModelBPaymentRecord = ClaimModelBPayment & {
  phase: PaymentRequestPhase;
  signedTransaction: Buffer | null;
  signedTransactionSha256: string | null;
  signature: string | null;
  lastValidBlockHeight: number | null;
  /** Available from getForReconciliation() after the additive finality migration. */
  finalizedSlot?: number | null;
  finalityObservedAt?: Date | null;
};

type DbRow = {
  request_id: string;
  genesis_hash: string;
  program_id: string;
  vault: string;
  workflow_digest: string;
  payment_digest: string;
  phase: PaymentRequestPhase;
  signed_tx_bytes: Buffer | null;
  signed_tx_sha256: string | null;
  tx_signature: string | null;
  last_valid_block_height: string | number | null;
  finalized_slot?: string | number | null;
  finality_observed_at?: Date | null;
};

const RESULT_FIELDS = `
  request_id, genesis_hash, program_id, vault, workflow_digest, payment_digest,
  phase, signed_tx_bytes, signed_tx_sha256, tx_signature, last_valid_block_height
`;

// Only for the additive 7.6C.5 migration; earlier stores need not have columns.
const FINALITY_RESULT_FIELDS = `${RESULT_FIELDS}, finalized_slot, finality_observed_at`;

function assertRequestId(requestId: string): void {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
    throw new Error("Invalid Model B request ID");
  }
}

function assertDigest(digest: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Invalid ${name}: expected lowercase SHA-256 hex`);
  }
}

function assertKey(value: string, name: string): void {
  try {
    if (new PublicKey(value).toBase58() === value) return;
  } catch {
    // Fall through to uniform error.
  }
  throw new Error(`Invalid ${name}`);
}

export function validatePaymentClaim(input: ClaimModelBPayment): void {
  assertRequestId(input.requestId);
  assertKey(input.genesisHash, "genesis hash");
  assertKey(input.programId, "program ID");
  assertKey(input.vault, "vault");
  assertDigest(input.workflowDigest, "workflow digest");
  assertDigest(input.paymentDigest, "payment digest");
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Small dependency-free base58 encoding for transaction signature comparison. */
function base58(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let result = "";
  while (value > BigInt(0)) {
    result = B58[Number(value % BigInt(58))] + result;
    value /= BigInt(58);
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result || "1";
}

export function validateSignedPayment(input: SignedModelBPayment): {
  bytes: Buffer;
  sha256: string;
} {
  assertRequestId(input.requestId);
  const bytes = Buffer.from(input.signedTransaction);
  if (bytes.length === 0 || bytes.length > 1232) {
    throw new Error("Signed transaction length is invalid");
  }
  if (
    !Number.isSafeInteger(input.lastValidBlockHeight) ||
    input.lastValidBlockHeight < 0
  ) {
    throw new Error("Invalid transaction last-valid block height");
  }
  let tx: Transaction;
  try {
    tx = Transaction.from(bytes);
  } catch {
    throw new Error("Invalid serialized legacy Solana transaction");
  }
  if (
    !tx.signature ||
    base58(tx.signature) !== input.signature ||
    !tx.verifySignatures(true)
  ) {
    throw new Error(
      "Saved transaction does not match a valid signed signature"
    );
  }
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Fail closed BEFORE executing SQL: verify owner signatures, workflow/approval
 * binding, canonical signed Model B message, and exact claim digests.
 * The supplied context's nowUnix is untrusted; use the actual wall clock for
 * approval expiry. Live on-chain nonce/policy still belongs to the separate
 * pre-confirmation gate, not this offline storage method.
 */
export function validateAuthorizedModelBPayment(
  input: AuthorizedSignedModelBPayment
): {
  bytes: Buffer;
  sha256: string;
  claim: ClaimModelBPayment;
} {
  if (!input || !input.binding) {
    throw new Error(
      "Model B owner-approval binding is required before persistence"
    );
  }
  const { bytes, sha256 } = validateSignedPayment(input);
  if (input.lastValidBlockHeight <= 0) {
    throw new Error(
      "Model B payment requires a positive last-valid block height"
    );
  }
  const binding = input.binding;
  const workflow = signedWorkflowV2Schema.parse(binding.signedWorkflow);
  const approval = paymentApprovalV2Schema.parse(binding.paymentApproval);
  if (
    workflow.workflow.requestId !== input.requestId ||
    approval.requestId !== input.requestId
  ) {
    throw new Error("Model B signed approvals do not match request ID");
  }
  // Even if a caller supplies an old nowUnix, expired approvals cannot be
  // prepared as fresh payments. Recovery never uses this method.
  const currentBinding: ModelBWorkflowBinding = {
    ...binding,
    nowUnix: Math.floor(Date.now() / 1000),
  };
  const transaction = Transaction.from(bytes);
  if (transaction.instructions.length !== 3) {
    throw new Error("Model B requires exactly three instructions");
  }
  assertSerializedModelBPayment(transaction, {
    binding: currentBinding,
    paymentInstruction: transaction.instructions[2],
  });
  const claim: ClaimModelBPayment = {
    requestId: input.requestId,
    genesisHash: workflow.workflow.genesisHash,
    programId: workflow.workflow.programId,
    vault: workflow.workflow.vault,
    workflowDigest: computeModelBWorkflowDigest(workflow),
    paymentDigest: computeModelBPaymentApprovalDigest(
      approval,
      binding.signatureBase64
    ),
  };
  validatePaymentClaim(claim);
  return { bytes, sha256, claim };
}

function rowToRecord(row: DbRow): ModelBPaymentRecord {
  if (
    !row ||
    ![
      "CLAIMED",
      "PREPARED",
      "SUBMISSION_RESERVED",
      "UNRESOLVED",
      "CONFIRMED",
      "FAILED",
    ].includes(row.phase)
  ) {
    throw new Error("Invalid payment record from PostgreSQL");
  }
  const height =
    row.last_valid_block_height === null
      ? null
      : Number(row.last_valid_block_height);
  if (height !== null && (!Number.isSafeInteger(height) || height < 0)) {
    throw new Error("Invalid payment block height from PostgreSQL");
  }
  if (row.signed_tx_bytes !== null) {
    const digest = createHash("sha256")
      .update(row.signed_tx_bytes)
      .digest("hex");
    if (digest !== row.signed_tx_sha256) {
      throw new Error("Corrupt stored signed transaction digest");
    }
  }
  const hasFinalityColumns = Object.prototype.hasOwnProperty.call(
    row,
    "finalized_slot"
  );
  const finalizedSlot =
    row.finalized_slot === null || row.finalized_slot === undefined
      ? null
      : Number(row.finalized_slot);
  if (
    hasFinalityColumns &&
    ((finalizedSlot !== null &&
      (!Number.isSafeInteger(finalizedSlot) || finalizedSlot < 0)) ||
      (row.phase === "CONFIRMED" || row.phase === "FAILED") !==
        (finalizedSlot !== null) ||
      (finalizedSlot !== null) !==
        (row.finality_observed_at instanceof Date &&
          Number.isFinite(row.finality_observed_at.getTime())))
  ) {
    throw new Error("Invalid finalized payment evidence from PostgreSQL");
  }
  return {
    requestId: row.request_id,
    genesisHash: row.genesis_hash,
    programId: row.program_id,
    vault: row.vault,
    workflowDigest: row.workflow_digest,
    paymentDigest: row.payment_digest,
    phase: row.phase,
    signedTransaction: row.signed_tx_bytes
      ? Buffer.from(row.signed_tx_bytes)
      : null,
    signedTransactionSha256: row.signed_tx_sha256,
    signature: row.tx_signature,
    lastValidBlockHeight: height,
    ...(hasFinalityColumns
      ? {
          finalizedSlot,
          finalityObservedAt: row.finality_observed_at ?? null,
        }
      : {}),
  };
}

function notAllowed(action: string): never {
  throw new Error(
    `${action} rejected: request missing or already transitioned`
  );
}

export class PostgresModelBPaymentStore {
  constructor(
    private readonly db: Queryable,
    private readonly guardedWrites = false
  ) {}

  /** INSERT is atomic across independent database clients/hosts. */
  async claim(input: ClaimModelBPayment): Promise<ModelBPaymentRecord> {
    validatePaymentClaim(input);
    const result = await this.db.query<DbRow>(
      this.guardedWrites
        ? `SELECT ${RESULT_FIELDS} FROM agentvault_model_b_claim_guarded($1,$2,$3,$4,$5,$6)`
        : `INSERT INTO agentvault_model_b_payment_requests
        (request_id, genesis_hash, program_id, vault, workflow_digest, payment_digest)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (request_id) DO NOTHING
       RETURNING ${RESULT_FIELDS}`,
      [
        input.requestId,
        input.genesisHash,
        input.programId,
        input.vault,
        input.workflowDigest,
        input.paymentDigest,
      ]
    );
    if (result.rowCount !== 1) notAllowed("Payment claim");
    return rowToRecord(result.rows[0]);
  }

  /**
   * The ONLY supported CLAIMED -> PREPARED API. Requires cryptographically
   * verified owner-signed Model B approvals and an exact signed payment.
   * Signed arbitrary SOL transfers are NEVER accepted by this method.
   * Callers must still check live on-chain policy and reserve funds separately.
   */
  async persistSignedPayment(
    input: AuthorizedSignedModelBPayment
  ): Promise<ModelBPaymentRecord> {
    const { bytes, sha256, claim } = validateAuthorizedModelBPayment(input);
    const result = await this.db.query<DbRow>(
      this.guardedWrites
        ? `SELECT ${RESULT_FIELDS} FROM agentvault_model_b_prepare_guarded($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`
        : `UPDATE agentvault_model_b_payment_requests
       SET phase = 'PREPARED', signed_tx_bytes = $2,
           signed_tx_sha256 = $3, tx_signature = $4,
           last_valid_block_height = $5
       WHERE request_id = $1 AND phase = 'CLAIMED'
         AND genesis_hash = $6 AND program_id = $7 AND vault = $8
         AND workflow_digest = $9 AND payment_digest = $10
       RETURNING ${RESULT_FIELDS}`,
      [
        input.requestId,
        bytes,
        sha256,
        input.signature,
        input.lastValidBlockHeight,
        claim.genesisHash,
        claim.programId,
        claim.vault,
        claim.workflowDigest,
        claim.paymentDigest,
      ]
    );
    if (result.rowCount !== 1) notAllowed("Payment persistence");
    return rowToRecord(result.rows[0]);
  }

  /**
   * The only entry point that returns a ONE-SHOT submission permit.
   * A failed/ambiguous response cannot be retried: use get() for inspection.
   * Must be committed BEFORE calling sendRawTransaction exactly once.
   */
  async reserveOneSubmission(requestId: string): Promise<ModelBPaymentRecord> {
    assertRequestId(requestId);
    const result = await this.db.query<DbRow>(
      this.guardedWrites
        ? `SELECT ${RESULT_FIELDS} FROM agentvault_model_b_reserve_guarded($1)`
        : `UPDATE agentvault_model_b_payment_requests
       SET phase = 'SUBMISSION_RESERVED'
       WHERE request_id = $1 AND phase = 'PREPARED'
       RETURNING ${RESULT_FIELDS}`,
      [requestId]
    );
    if (result.rowCount !== 1) notAllowed("Payment submission reservation");
    return rowToRecord(result.rows[0]);
  }

  /**
   * LEGACY/INACTIVE low-level API. Never call from the production runtime.
   * The 7.6C.5 migration blocks terminal transitions without finality evidence.
   * Use reconcileModelBPayment() instead.
   * @deprecated
   */
  async recordChainStatus(
    requestId: string,
    signature: string,
    observed: "CONFIRMED" | "FAILED" | "UNRESOLVED"
  ): Promise<ModelBPaymentRecord> {
    if (this.guardedWrites) {
      throw new Error(
        "Deprecated status writer disabled for guarded PostgreSQL store"
      );
    }
    assertRequestId(requestId);
    if (!signature || typeof signature !== "string") {
      throw new Error("Missing observed payment signature");
    }
    const result = await this.db.query<DbRow>(
      `UPDATE agentvault_model_b_payment_requests
       SET phase = $3
       WHERE request_id = $1 AND tx_signature = $2
         AND (phase = 'SUBMISSION_RESERVED' OR
           (phase = 'UNRESOLVED' AND $3 IN ('CONFIRMED', 'FAILED')))
       RETURNING ${RESULT_FIELDS}`,
      [requestId, signature, observed]
    );
    if (result.rowCount !== 1) notAllowed("Payment status transition");
    return rowToRecord(result.rows[0]);
  }

  /** Read-only. Never use this method to create a new payment submission. */
  async get(requestId: string): Promise<ModelBPaymentRecord | null> {
    assertRequestId(requestId);
    const result = await this.db.query<DbRow>(
      `SELECT ${RESULT_FIELDS}
       FROM agentvault_model_b_payment_requests WHERE request_id = $1`,
      [requestId]
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  /**
   * Read using the additive 7.6C.5 finality schema. This cannot submit any
   * transaction and must not be used before the migration is applied.
   */
  async getForReconciliation(
    requestId: string
  ): Promise<ModelBPaymentRecord | null> {
    assertRequestId(requestId);
    const result = await this.db.query<DbRow>(
      `SELECT ${FINALITY_RESULT_FIELDS}
       FROM agentvault_model_b_payment_requests WHERE request_id = $1`,
      [requestId]
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  /**
   * Internal CAS used ONLY after inspectModelBFinality() in the trusted
   * reconciliation service. It rejects stale identity/signed-byte snapshots.
   * Passing a status directly here is NOT a substitute for chain inspection.
   * The additive SQL constraint enforces that terminal writes have slot evidence.
   * NEVER use this to authorize a new submission.
   */
  async applyInspectedStatus(
    expected: ModelBPaymentRecord,
    observation: {
      status: "UNRESOLVED" | "CONFIRMED" | "FAILED";
      requestId: string;
      signature: string;
      finalizedSlot?: number;
    }
  ): Promise<ModelBPaymentRecord | null> {
    validatePaymentClaim(expected);
    if (
      !["SUBMISSION_RESERVED", "UNRESOLVED"].includes(expected.phase) ||
      !expected.signature ||
      !expected.signedTransaction ||
      expected.signedTransactionSha256 === null ||
      expected.lastValidBlockHeight === null
    ) {
      throw new Error("Payment is not eligible for finality reconciliation");
    }
    const checked = validateSignedPayment({
      requestId: expected.requestId,
      signedTransaction: expected.signedTransaction,
      signature: expected.signature,
      lastValidBlockHeight: expected.lastValidBlockHeight,
    });
    if (checked.sha256 !== expected.signedTransactionSha256) {
      throw new Error("Corrupt saved payment cannot be reconciled");
    }
    if (
      observation.requestId !== expected.requestId ||
      observation.signature !== expected.signature
    ) {
      throw new Error("Finality observation does not match saved payment");
    }
    const terminal = observation.status !== "UNRESOLVED";
    if (
      (terminal &&
        (!Number.isSafeInteger(observation.finalizedSlot) ||
          observation.finalizedSlot! < 0)) ||
      (!terminal && observation.finalizedSlot !== undefined)
    ) {
      throw new Error("Invalid finalized slot for payment observation");
    }
    const result = await this.db.query<DbRow>(
      this.guardedWrites
        ? `SELECT ${FINALITY_RESULT_FIELDS} FROM agentvault_model_b_reconcile_guarded($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`
        : `UPDATE agentvault_model_b_payment_requests
       SET phase = $11,
           finalized_slot = $12,
           finality_observed_at = CASE WHEN $12::bigint IS NULL
             THEN NULL ELSE clock_timestamp() END
       WHERE request_id = $1 AND genesis_hash = $2 AND program_id = $3
         AND vault = $4 AND workflow_digest = $5 AND payment_digest = $6
         AND signed_tx_sha256 = $7 AND tx_signature = $8
         AND last_valid_block_height = $9 AND signed_tx_bytes = $10
         AND (
           (phase = 'SUBMISSION_RESERVED' AND $11::text IN
             ('UNRESOLVED', 'CONFIRMED', 'FAILED'))
           OR (phase = 'UNRESOLVED' AND $11::text IN ('CONFIRMED', 'FAILED'))
         )
       RETURNING ${FINALITY_RESULT_FIELDS}`,
      [
        expected.requestId,
        expected.genesisHash,
        expected.programId,
        expected.vault,
        expected.workflowDigest,
        expected.paymentDigest,
        expected.signedTransactionSha256,
        expected.signature,
        expected.lastValidBlockHeight,
        expected.signedTransaction,
        observation.status,
        terminal ? observation.finalizedSlot : null,
      ]
    );
    if (result.rowCount === 0) return null; // CAS lost; re-read to classify race.
    if (result.rowCount !== 1) throw new Error("Unexpected CAS row count");
    return rowToRecord(result.rows[0]);
  }
}

/**
 * For 7.6C.8+ private schemas only. All writes route through SECURITY DEFINER
 * functions with individually restricted EXECUTE grants. Never use the legacy
 * table-writing store with a production runtime identity.
 *
 * IMPORTANT: this does NOT verify Solana approvals or RPC finality inside SQL.
 * The TypeScript validation and trusted read-only inspector remain mandatory.
 */
export class GuardedPostgresModelBPaymentStore extends PostgresModelBPaymentStore {
  constructor(db: Queryable) {
    super(db, true);
  }
}
