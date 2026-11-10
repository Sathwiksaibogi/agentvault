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

export type ModelBPaymentRecord = ClaimModelBPayment & {
  phase: PaymentRequestPhase;
  signedTransaction: Buffer | null;
  signedTransactionSha256: string | null;
  signature: string | null;
  lastValidBlockHeight: number | null;
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
};

const RESULT_FIELDS = `
  request_id, genesis_hash, program_id, vault, workflow_digest, payment_digest,
  phase, signed_tx_bytes, signed_tx_sha256, tx_signature, last_valid_block_height
`;

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
  };
}

function notAllowed(action: string): never {
  throw new Error(
    `${action} rejected: request missing or already transitioned`
  );
}

export class PostgresModelBPaymentStore {
  constructor(private readonly db: Queryable) {}

  /** INSERT is atomic across independent database clients/hosts. */
  async claim(input: ClaimModelBPayment): Promise<ModelBPaymentRecord> {
    validatePaymentClaim(input);
    const result = await this.db.query<DbRow>(
      `INSERT INTO agentvault_model_b_payment_requests
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

  /** Can transition the original claim to PREPARED just once. */
  async persistSignedPayment(
    input: SignedModelBPayment
  ): Promise<ModelBPaymentRecord> {
    const { bytes, sha256 } = validateSignedPayment(input);
    const result = await this.db.query<DbRow>(
      `UPDATE agentvault_model_b_payment_requests
       SET phase = 'PREPARED', signed_tx_bytes = $2,
           signed_tx_sha256 = $3, tx_signature = $4,
           last_valid_block_height = $5
       WHERE request_id = $1 AND phase = 'CLAIMED'
       RETURNING ${RESULT_FIELDS}`,
      [
        input.requestId,
        bytes,
        sha256,
        input.signature,
        input.lastValidBlockHeight,
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
      `UPDATE agentvault_model_b_payment_requests
       SET phase = 'SUBMISSION_RESERVED'
       WHERE request_id = $1 AND phase = 'PREPARED'
       RETURNING ${RESULT_FIELDS}`,
      [requestId]
    );
    if (result.rowCount !== 1) notAllowed("Payment submission reservation");
    return rowToRecord(result.rows[0]);
  }

  /** Only read-only reconciliation may call this with a verified chain result. */
  async recordChainStatus(
    requestId: string,
    signature: string,
    observed: "CONFIRMED" | "FAILED" | "UNRESOLVED"
  ): Promise<ModelBPaymentRecord> {
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
}
