/**
 * AgentVault 7.6D.9: test-only canonical witness attestation encoding.
 * Call this from independently provisioned witnesses AFTER they independently
 * verify Solana finality. This module does NOT validate RPC or hold keys.
 * Never make a witness key available to a finalizer process.
 */
import { createHmac } from "node:crypto";

export type AttestedPaymentIdentity = {
  requestId: string;
  genesisHash: string;
  programId: string;
  vault: string;
  workflowDigest: string;
  paymentDigest: string;
  signedTransactionSha256: string;
  signature: string;
  lastValidBlockHeight: number;
};

const PREFIX = "AgentVault/ModelB/finality-attestation/v1|";

export function encodeModelBFinalityAttestation(
  identity: AttestedPaymentIdentity,
  outcome: "CONFIRMED" | "FAILED",
  finalizedSlot: number
): Buffer {
  if (
    !Number.isSafeInteger(finalizedSlot) ||
    finalizedSlot < 0 ||
    !Number.isSafeInteger(identity.lastValidBlockHeight) ||
    identity.lastValidBlockHeight < 0 ||
    (outcome !== "CONFIRMED" && outcome !== "FAILED")
  ) {
    throw new Error("Invalid finality attestation outcome or slot");
  }
  const fields = [
    identity.requestId,
    identity.genesisHash,
    identity.programId,
    identity.vault,
    identity.workflowDigest,
    identity.paymentDigest,
    identity.signedTransactionSha256,
    identity.signature,
    String(identity.lastValidBlockHeight),
    outcome,
    String(finalizedSlot),
  ];
  for (const field of fields) {
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      field.includes("\0")
    ) {
      throw new Error("Invalid finality attestation identity");
    }
  }
  return Buffer.from(
    PREFIX +
      fields
        .map((field) => `${Buffer.byteLength(field, "utf8")}:${field}`)
        .join(""),
    "utf8"
  );
}

/** HMAC requires 32 random bytes per independently operated witness. */
export function signModelBFinalityAttestation(
  key: Buffer,
  payload: Buffer
): string {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(payload)) {
    throw new Error("Invalid isolated witness key or payload");
  }
  return createHmac("sha256", key).update(payload).digest("hex");
}
