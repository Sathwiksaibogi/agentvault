import { PublicKey } from "@solana/web3.js";

const MAX_U64 = BigInt("18446744073709551615");
const MAX_I64 = BigInt("9223372036854775807");

export interface PaymentApprovalV2 {
  version: 2;
  genesisHash: string;
  programId: string;
  vault: string;
  owner: string;
  mint: string;
  agent: string;
  agentAuthority: string;
  task: string;
  recipient: string;
  amountBaseUnits: string;
  nonce: string;
  expiresAtUnix: string;
  requestId: string;
}

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

function keyBytes(value: string): Uint8Array {
  const key = new PublicKey(value);
  if (key.toBase58() !== value) throw new Error("Noncanonical public key");
  return key.toBytes();
}

/**
 * Encodes PaymentApprovalV2 into canonical binary format for Phantom signMessage.
 * Exactly matches demo/payment-approval-v2.ts byte-for-byte.
 */
export async function encodePaymentApprovalV2Browser(
  approval: PaymentApprovalV2
): Promise<Uint8Array> {
  const amount = asUnsigned(approval.amountBaseUnits, MAX_U64, "amount");
  const nonce = asUnsigned(approval.nonce, MAX_U64, "nonce", true);
  const expiresAt = asUnsigned(approval.expiresAtUnix, MAX_I64, "expiry");

  const numeric = new Uint8Array(24);
  const view = new DataView(numeric.buffer, numeric.byteOffset, numeric.byteLength);
  view.setBigUint64(0, amount, true);
  view.setBigUint64(8, nonce, true);
  view.setBigInt64(16, expiresAt, true);

  const requestHashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(approval.requestId)
  );
  const requestHash = new Uint8Array(requestHashBuffer);

  const domainBytes = new TextEncoder().encode("agentvault:payment-approval:v2\0");

  const parts = [
    domainBytes,
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
  ];

  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
