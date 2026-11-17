/**
 * 7.6D.10: INACTIVE independent Model B finality witness.
 *
 * A witness reads its own immutable payment record and its own RPC provider;
 * it NEVER signs a finality claim received from a coordinator or finalizer.
 * The current HMAC/SQL gate is TEST-ONLY; a real deployment needs independent
 * RPC operators and asymmetric verification / separately audited key custody.
 */
import { PublicKey } from "@solana/web3.js";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import {
  inspectModelBFinality,
  type ModelBFinalityRpc,
} from "./model-b-postgres-chain-inspection";
import {
  validatePaymentClaim,
  type ModelBPaymentRecord,
} from "./model-b-postgres-payment-store";
import {
  encodeModelBFinalityAttestation,
  signModelBFinalityAttestation,
  type AttestedPaymentIdentity,
} from "./model-b-finality-attestation-codec";

export type WitnessId = "observer_a" | "observer_b";
export type WitnessDeployment = Readonly<{
  genesisHash: string;
  programId: string;
  vault: string;
  rpc: ModelBFinalityRpc;
}>;

export type WitnessDecision = Readonly<
  | {
      witnessId: WitnessId;
      requestId: string;
      status: "UNRESOLVED";
      reason: string;
      mac: null;
      finalizedSlot: null;
    }
  | {
      witnessId: WitnessId;
      requestId: string;
      signature: string;
      status: "CONFIRMED" | "FAILED";
      mac: string;
      finalizedSlot: number;
    }
>;

function canonicalKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function assertWitnessDeployment(deployment: WitnessDeployment): void {
  if (
    !deployment ||
    !canonicalKey(deployment.genesisHash) ||
    !canonicalKey(deployment.programId) ||
    deployment.programId !== AGENTVAULT_PROGRAM_ID.toBase58() ||
    !canonicalKey(deployment.vault) ||
    !deployment.rpc ||
    typeof deployment.rpc.getGenesisHash !== "function" ||
    typeof deployment.rpc.getSignatureStatuses !== "function" ||
    typeof deployment.rpc.getTransaction !== "function"
  ) {
    throw new Error("WITNESS_DENIED: invalid independently pinned deployment");
  }
}

/**
 * The witness must be passed ONLY the result of its own read-only database
 * lookup; the caller cannot supply a status, slot, or claimed RPC receipt.
 * Refuse on missing, disputed, unfinalized or changed-chain evidence.
 */
export async function inspectAndAttestModelBFinality(
  witnessId: WitnessId,
  key: Buffer,
  record: ModelBPaymentRecord,
  deployment: WitnessDeployment
): Promise<WitnessDecision> {
  if (witnessId !== "observer_a" && witnessId !== "observer_b") {
    throw new Error("WITNESS_DENIED: invalid witness identity");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("WITNESS_DENIED: witness key must be 32 private bytes");
  }
  assertWitnessDeployment(deployment);
  validatePaymentClaim(record);
  if (
    record.genesisHash !== deployment.genesisHash ||
    record.programId !== deployment.programId ||
    record.vault !== deployment.vault
  ) {
    throw new Error("WITNESS_DENIED: payment differs from pinned deployment");
  }
  // Local copy prevents an RPC callback from altering signed bytes while the
  // asynchronous finality inspector is inspecting the record.
  const snapshot: ModelBPaymentRecord = {
    ...record,
    signedTransaction: record.signedTransaction
      ? Buffer.from(record.signedTransaction)
      : null,
  };
  const observation = await inspectModelBFinality(snapshot, deployment.rpc);
  if (observation.status === "UNRESOLVED") {
    return Object.freeze({
      witnessId,
      requestId: snapshot.requestId,
      status: "UNRESOLVED" as const,
      reason: observation.reason,
      mac: null,
      finalizedSlot: null,
    });
  }

  // No caller-supplied terminal outcome is accepted. This is the result from
  // the witness's own RPC view of signature history AND finalized receipt.
  if (
    snapshot.lastValidBlockHeight === null ||
    !snapshot.signedTransactionSha256 ||
    !snapshot.signature
  ) {
    throw new Error("WITNESS_DENIED: incomplete immutable payment identity");
  }
  const identity: AttestedPaymentIdentity = {
    requestId: snapshot.requestId,
    genesisHash: snapshot.genesisHash,
    programId: snapshot.programId,
    vault: snapshot.vault,
    workflowDigest: snapshot.workflowDigest,
    paymentDigest: snapshot.paymentDigest,
    signedTransactionSha256: snapshot.signedTransactionSha256,
    signature: snapshot.signature,
    lastValidBlockHeight: snapshot.lastValidBlockHeight,
  };
  const payload = encodeModelBFinalityAttestation(
    identity,
    observation.status,
    observation.finalizedSlot
  );
  return Object.freeze({
    witnessId,
    requestId: snapshot.requestId,
    signature: snapshot.signature,
    status: observation.status,
    finalizedSlot: observation.finalizedSlot,
    mac: signModelBFinalityAttestation(key, payload),
  });
}
