import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { z } from "zod";

const canonicalPubkey = z.string().refine((value) => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}, "Invalid canonical public key");

const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const paymentApprovalV2Schema = z
  .object({
    version: z.literal(2),
    genesisHash: canonicalPubkey,
    programId: canonicalPubkey,
    vault: canonicalPubkey,
    owner: canonicalPubkey,
    mint: canonicalPubkey,
    agent: canonicalPubkey,
    agentAuthority: canonicalPubkey,
    task: canonicalPubkey,
    recipient: canonicalPubkey,
    amountBaseUnits: decimal,
    nonce: decimal,
    expiresAtUnix: decimal,
    requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/),
  })
  .strict();

export type PaymentApprovalV2 = z.infer<typeof paymentApprovalV2Schema>;

const DOMAIN = Buffer.from("agentvault:payment-approval:v2\0", "utf8");

const MAX_U64 = BigInt("18446744073709551615");
const MAX_I64 = BigInt("9223372036854775807");

function asUnsigned(
  value: string,
  maximum: bigint,
  label: string,
  allowZero = false
): bigint {
  const result = BigInt(value);

  if (result > maximum || (!allowZero && result === BigInt(0))) {
    throw new Error(`Invalid ${label} range`);
  }

  return result;
}

function keyBytes(value: string): Buffer {
  return Buffer.from(new PublicKey(value).toBytes());
}

/**
 * Canonical binary approval message.
 *
 * All public keys are exactly 32 bytes.
 * Amount, nonce and expiry are 8-byte little-endian integers.
 * requestId is represented by SHA-256(UTF-8 requestId).
 *
 * This is a new protocol. It does not modify v1 approvals.
 */
export function encodePaymentApprovalV2(input: unknown): Buffer {
  const approval = paymentApprovalV2Schema.parse(input);

  const amount = asUnsigned(approval.amountBaseUnits, MAX_U64, "amount");

  const nonce = asUnsigned(approval.nonce, MAX_U64, "nonce", true);

  const expiresAt = asUnsigned(approval.expiresAtUnix, MAX_I64, "expiry");

  const numeric = Buffer.alloc(24);

  numeric.writeBigUInt64LE(amount, 0);
  numeric.writeBigUInt64LE(nonce, 8);
  numeric.writeBigInt64LE(expiresAt, 16);

  const requestHash = createHash("sha256")
    .update(Buffer.from(approval.requestId, "utf8"))
    .digest();

  return Buffer.concat([
    DOMAIN,
    keyBytes(approval.genesisHash),
    keyBytes(approval.programId),
    keyBytes(approval.vault),
    keyBytes(approval.owner),
    keyBytes(approval.mint),
    keyBytes(approval.agent),
    keyBytes(approval.agentAuthority),
    keyBytes(approval.task),
    keyBytes(approval.recipient),
    numeric,
    requestHash,
  ]);
}

export function verifyPaymentApprovalV2(
  input: unknown,
  signatureBase64: string,
  expectedOwner: PublicKey
): boolean {
  const approval = paymentApprovalV2Schema.parse(input);

  if (!new PublicKey(approval.owner).equals(expectedOwner)) {
    return false;
  }

  const signature = Buffer.from(signatureBase64, "base64");

  if (
    signature.length !== 64 ||
    signature.toString("base64") !== signatureBase64
  ) {
    return false;
  }

  return nacl.sign.detached.verify(
    encodePaymentApprovalV2(approval),
    signature,
    expectedOwner.toBytes()
  );
}
